/**
 * Codex CLI integration for codex-autoreview.
 *
 * Design decision: this plugin shells out to `codex exec` rather than vendoring
 * the full `codex app-server` JSON-RPC client stack. The narrow review use case
 * only needs to (a) fire one review prompt at Codex, (b) capture the final
 * verdict text, (c) persist it. `codex exec` exposes exactly that surface
 * (`--model`, `-c model_reasoning_effort=`, `--cd`, `--output-last-message`,
 * `--skip-git-repo-check`, `--sandbox read-only`) with a far smaller dependency
 * closure and no broker/thread lifecycle to maintain. All Codex interaction is
 * isolated in this module.
 *
 * This file is original to codex-autoreview, but the model/effort defaults and
 * the reasoning-effort value set follow codex-plugin-cc's conventions.
 *
 * @file
 */

import process from "node:process";
import { spawn } from "node:child_process";

import { binaryAvailable } from "./process.mjs";

/**
 * Label shown for the model/effort when the project has not set an override.
 *
 * The plugin intentionally does NOT hardcode a default model: a hardcoded model
 * (e.g. `gpt-5.4-codex`) is rejected outright on some accounts — a ChatGPT-auth
 * Codex only accepts the models that account is entitled to. When unset, the
 * plugin omits `--model` / `model_reasoning_effort` entirely and lets the user's
 * own `~/.codex/config.toml` default decide. That is the robust default.
 */
export const CODEX_DEFAULT_LABEL = "codex default";

/**
 * Reasoning-effort values the Codex CLI accepts. Note the history: `xhigh` was
 * briefly mis-documented upstream; the codex-plugin-cc reference impl settled on
 * this exact set, validated against `codex` config.
 */
export const VALID_REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);

/**
 * The plugin's OWN default reasoning effort for automatic reviews.
 *
 * This is deliberately explicit and NOT inherited from the user's global
 * `~/.codex/config.toml`: a user may keep their global default at `xhigh` for
 * interactive use, which would make every automatic background review needlessly
 * slow. `medium` keeps reviews fast to turn around while still leaving Codex
 * enough reasoning budget to trace cross-file logic and catch real bugs (the
 * value recommended by Codex itself for this background-review use case). Fully
 * overridable per project via `/codex-autoreview:config --effort <e>`.
 *
 * Note the asymmetry with the model default: the MODEL stays unset/inherited on
 * purpose (a hardcoded model can be rejected outright by ChatGPT-auth accounts),
 * but EFFORT is safe to pin because every account accepts every effort tier.
 */
export const DEFAULT_REVIEW_EFFORT = "medium";

/**
 * Hard wall-clock cap for a single `codex exec` review run, in milliseconds.
 * A hung or pathologically slow Codex must never leave a review job stuck in
 * `running` forever — when this elapses the worker kills the codex process tree
 * and marks the job `failed`. Overridable per project via the `timeoutMs`
 * config key. 4 minutes is comfortably longer than a normal review (observed
 * ~3-5 min) while still bounding a true hang.
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 240_000;

/** Lower bound for a configured timeout — anything shorter is unusable. */
const MIN_REVIEW_TIMEOUT_MS = 10_000;
/** Upper bound for a configured timeout — guards against a typo'd huge value. */
const MAX_REVIEW_TIMEOUT_MS = 1_800_000;

/**
 * Resolve the Codex model override, or `null` when none is configured (meaning
 * "let codex use its own config default").
 *
 * @param {{ model?: unknown }} config
 * @returns {string | null}
 */
export function resolveReviewModel(config) {
  const configured =
    config && typeof config.model === "string" ? config.model.trim() : "";
  return configured || null;
}

/**
 * Resolve the effective Codex reasoning effort for a review.
 *
 * Unlike the model, effort always resolves to a concrete value: a configured
 * override when set, otherwise the plugin's own {@link DEFAULT_REVIEW_EFFORT}.
 * It is intentionally NOT left unset — leaving it unset would inherit the user's
 * global `~/.codex/config.toml` (often `xhigh`), making automatic reviews slow.
 *
 * @param {{ effort?: unknown }} config
 * @returns {string}
 */
export function resolveReviewEffort(config) {
  const configured =
    config && typeof config.effort === "string" ? config.effort.trim() : "";
  return configured || DEFAULT_REVIEW_EFFORT;
}

/**
 * Whether the project has an explicit effort override, as opposed to falling
 * back to {@link DEFAULT_REVIEW_EFFORT}. Used by the config report / statusline
 * to label the source of the effort value.
 *
 * @param {{ effort?: unknown }} config
 * @returns {boolean}
 */
export function hasEffortOverride(config) {
  return Boolean(config && typeof config.effort === "string" && config.effort.trim());
}

/**
 * Resolve the effective per-review timeout in milliseconds. Falls back to
 * {@link DEFAULT_REVIEW_TIMEOUT_MS} when the project has not configured one.
 *
 * @param {{ timeoutMs?: unknown }} config
 * @returns {number}
 */
export function resolveReviewTimeoutMs(config) {
  const configured =
    config && typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs)
      ? config.timeoutMs
      : null;
  if (configured == null || configured <= 0) {
    return DEFAULT_REVIEW_TIMEOUT_MS;
  }
  return Math.min(Math.max(configured, MIN_REVIEW_TIMEOUT_MS), MAX_REVIEW_TIMEOUT_MS);
}

/**
 * Normalize and validate a requested review timeout. Accepts a number of
 * milliseconds or a numeric string; returns `null` for empty input (meaning
 * "clear the override, use the default"); throws on a non-numeric or
 * out-of-range value.
 *
 * @param {unknown} timeout
 * @returns {number | null}
 */
export function normalizeTimeoutMs(timeout) {
  if (timeout == null) {
    return null;
  }
  const raw = String(timeout).trim();
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid timeout "${timeout}". Pass a positive number of milliseconds ` +
        `(${MIN_REVIEW_TIMEOUT_MS}-${MAX_REVIEW_TIMEOUT_MS}).`
    );
  }
  if (value < MIN_REVIEW_TIMEOUT_MS || value > MAX_REVIEW_TIMEOUT_MS) {
    throw new Error(
      `Timeout ${value}ms is out of range. Use ${MIN_REVIEW_TIMEOUT_MS}-${MAX_REVIEW_TIMEOUT_MS} ms.`
    );
  }
  return Math.round(value);
}

/**
 * Normalize and validate a reasoning-effort value. Returns `null` for an empty
 * input (meaning "clear the override"), throws on an unsupported value.
 *
 * @param {unknown} effort
 * @returns {string | null}
 */
export function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.includes(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: ${VALID_REASONING_EFFORTS.join(", ")}.`
    );
  }
  return normalized;
}

/**
 * Normalize a requested model string. Returns `null` for empty input.
 *
 * @param {unknown} model
 * @returns {string | null}
 */
export function normalizeModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  return normalized || null;
}

/**
 * Check whether the `codex` CLI is available on PATH.
 *
 * The underlying `codex --version` probe is time-boxed (see
 * {@link binaryAvailable}) so a codex binary wedged on `--version` is reported
 * as unavailable rather than blocking the caller — important because this runs
 * in hooks and in the background worker before the hard `codex exec` timeout
 * would ever apply.
 *
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {{ available: boolean, detail: string }}
 */
export function getCodexAvailability(cwd, options = {}) {
  return binaryAvailable("codex", ["--version"], {
    cwd,
    env: options.env ?? process.env,
    ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {})
  });
}

/**
 * Build the `codex exec` argument vector for a review run.
 *
 * `model` and `effort` are optional: when `null`/empty the corresponding flag
 * is omitted so `codex` falls back to the user's own `~/.codex/config.toml`
 * default. This avoids passing a hardcoded model that the account may reject.
 *
 * @param {object} params
 * @param {string | null} [params.model]
 * @param {string | null} [params.effort]
 * @param {string} params.cwd
 * @param {string} params.outputFile - Where Codex writes its final message.
 * @returns {string[]}
 */
export function buildCodexExecArgs(params) {
  const args = ["exec"];
  if (params.model) {
    args.push("--model", params.model);
  }
  if (params.effort) {
    args.push("-c", `model_reasoning_effort=${params.effort}`);
  }
  args.push(
    "--cd",
    params.cwd,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--output-last-message",
    params.outputFile
  );
  return args;
}

/**
 * Best-effort kill of a process and everything it spawned.
 *
 * The child is started with `detached: true`, so it leads its own process
 * group; `process.kill(-pid, signal)` then signals the whole group — important
 * because `codex` itself spawns a vendored sub-binary that would otherwise
 * survive a kill of just the direct child.
 *
 * Exported so the detached worker can reap an in-flight `codex exec` tree from
 * its own SIGTERM/SIGINT handler — otherwise killing the worker would orphan
 * the (expensive) codex run.
 *
 * @param {number | undefined} pid
 * @param {NodeJS.Signals} signal
 */
export function killProcessTree(pid, signal) {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group may already be gone; fall back to the direct child.
    try {
      process.kill(pid, signal);
    } catch {
      // Already dead — nothing to do.
    }
  }
}

/**
 * Run `codex exec` with the review prompt on stdin and resolve with the
 * captured streams + exit status. Used by the detached background worker —
 * never by a hook directly, because it blocks until Codex finishes (or the
 * timeout fires).
 *
 * HANG PROTECTION: the codex child is spawned `detached` (its own process
 * group) and a hard `timeoutMs` wall-clock cap is enforced. On timeout the
 * whole process group is killed (SIGTERM, then SIGKILL after a short grace
 * period) and the result is flagged `timedOut: true` so the worker can mark the
 * job `failed` instead of leaving it stuck in `running` forever.
 *
 * The authoritative verdict text is the `--output-last-message` file, which the
 * caller reads. `codex exec` prints its session transcript to stderr (banner,
 * `ERROR: {...}` lines, etc.); stdout is typically empty.
 *
 * @param {object} params
 * @param {string} params.cwd
 * @param {string} params.prompt
 * @param {string | null} [params.model]
 * @param {string | null} [params.effort]
 * @param {string} params.outputFile
 * @param {number} [params.timeoutMs] - Hard cap; defaults to {@link DEFAULT_REVIEW_TIMEOUT_MS}.
 * @param {NodeJS.ProcessEnv} [params.env]
 * @param {(pid: number | undefined) => void} [params.onChild] - Invoked once
 *   with the spawned codex child pid (and again with `undefined` when it
 *   exits). Lets the caller reap the codex process tree if the caller itself is
 *   killed mid-run, so an in-flight codex exec is never orphaned.
 * @returns {Promise<{ status: number, stdout: string, stderr: string, signal: string | null, error: Error | null, timedOut: boolean, timeoutMs: number }>}
 */
export function runCodexReview(params) {
  const args = buildCodexExecArgs({
    model: params.model ?? null,
    effort: params.effort ?? null,
    cwd: params.cwd,
    outputFile: params.outputFile
  });
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_REVIEW_TIMEOUT_MS;
  /** Grace period between SIGTERM and the follow-up SIGKILL. */
  const KILL_GRACE_MS = 5_000;

  const onChild = typeof params.onChild === "function" ? params.onChild : null;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("codex", args, {
        cwd: params.cwd,
        env: params.env ?? process.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({
        status: 1,
        stdout: "",
        stderr: "",
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
        timeoutMs
      });
      return;
    }

    // Hand the caller the codex child pid so it can reap the process tree if
    // the caller is itself killed mid-run.
    if (onChild) {
      try {
        onChild(child.pid);
      } catch {
        // A bad callback must not break the review run.
      }
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let killTimer = null;

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    // Hard wall-clock timeout: escalate SIGTERM -> SIGKILL across the group.
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child.pid, "SIGKILL");
      }, KILL_GRACE_MS);
      if (killTimer.unref) {
        killTimer.unref();
      }
    }, timeoutMs);
    if (timeoutTimer.unref) {
      timeoutTimer.unref();
    }

    const finish = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      // The codex child is gone — tell the caller so it stops tracking it.
      if (onChild) {
        try {
          onChild(undefined);
        } catch {
          // ignore
        }
      }
      resolve({
        status: status ?? (signal ? 1 : 0),
        stdout,
        stderr,
        signal: signal ?? null,
        error: spawnError,
        timedOut,
        timeoutMs
      });
    };

    child.on("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
      finish(1, null);
    });
    child.on("close", (code, signal) => {
      finish(code ?? 0, signal ?? null);
    });

    // Feed the prompt on stdin; ignore EPIPE if codex exits early.
    try {
      child.stdin?.on("error", () => {});
      child.stdin?.end(params.prompt ?? "");
    } catch {
      // stdin already closed — codex will run with whatever it received.
    }
  });
}

/**
 * Spawn a fully detached process and return immediately. The child keeps
 * running after the parent exits; the parent never waits on it.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ pid: number | null }}
 */
export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return { pid: child.pid ?? null };
}

/**
 * Extract the verdict line (the first non-empty line of Codex's final message,
 * which the prompt contract pins to `SOUND:`/`CONCERNS:`/`CLEAN:`/`ISSUES:`).
 *
 * @param {string} finalMessage
 * @returns {string | null}
 */
export function extractVerdictLine(finalMessage) {
  const line = String(finalMessage ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? null;
}
