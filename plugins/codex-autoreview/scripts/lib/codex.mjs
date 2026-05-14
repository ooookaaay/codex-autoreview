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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
 * Reasoning-effort values the Codex CLI accepts for a background REVIEW run.
 *
 * Re-validated for Phase 1 (F5) against `codex-cli 0.130.0`: the research
 * (`docs/research/codex-cli.md`) confirmed `minimal` FAILS with the default
 * Codex toolset a review needs (read-only git + file inspection) — the model
 * cannot drive the tools at that tier — and `none` likewise leaves no reasoning
 * budget to trace cross-file logic. Both are therefore excluded from the set
 * the plugin will accept for a review; the usable tiers are `low`/`medium`/
 * `high`/`xhigh`. (`xhigh` itself was briefly mis-documented upstream; this
 * exact set is validated against `codex` config.)
 */
export const VALID_REASONING_EFFORTS = Object.freeze([
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
 * Read ONLY the top-level `model = "..."` key out of the user's
 * `~/.codex/config.toml`. Deliberately NOT a TOML parser — F5 hardening adds
 * `--ignore-user-config` for hermeticity (no MCP servers / rules / personality
 * leak into a review), but that flag also stops codex from reading the user's
 * chosen default model. To stay non-breaking, the plugin re-supplies JUST that
 * one value explicitly via `--model` (decision: consulted `codex`, recommended
 * "Option C scoped to model extraction only").
 *
 * Scans only top-level lines (stops at the first `[table]` header) so a `model`
 * key nested under some `[profile.x]` table is never mistaken for the global
 * default. Returns `null` on any problem (missing file, unreadable, no key) —
 * the caller then omits `--model` and accepts codex's built-in default. NEVER
 * throws.
 *
 * @param {{ homeDir?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string | null}
 */
export function readUserCodexDefaultModel(options = {}) {
  const env = options.env ?? process.env;
  const codexHome =
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()
      ? env.CODEX_HOME.trim()
      : path.join(options.homeDir ?? os.homedir() ?? "", ".codex");
  const configPath = path.join(codexHome, "config.toml");
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Stop at the first table header — anything after is not a top-level key.
    if (/^\[/.test(trimmed)) {
      break;
    }
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^model\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (match) {
      // Strip surrounding single or double quotes.
      const value = match[1].replace(/^["']|["']$/g, "").trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Resolve the model to actually pass to `codex exec --model` for a review,
 * given the plugin's hermetic-run posture (`--ignore-user-config` is always on,
 * see {@link buildCodexExecArgs}).
 *
 * Resolution order:
 *   1. an explicit plugin-level model override ({@link resolveReviewModel});
 *   2. else the user's own `~/.codex/config.toml` top-level `model` — so an
 *      unset plugin override still respects the user's chosen model even though
 *      `--ignore-user-config` stops codex from reading it itself;
 *   3. else `null` — `--model` is omitted and codex's built-in default applies.
 *
 * @param {{ model?: unknown }} config
 * @param {{ homeDir?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string | null}
 */
export function resolveEffectiveReviewModel(config, options = {}) {
  const override = resolveReviewModel(config);
  if (override) {
    return override;
  }
  return readUserCodexDefaultModel(options);
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
 * Maximum number of bytes of `codex exec` stdout/stderr the worker retains.
 * `codex exec` prints its whole session transcript to stderr; on a pathological
 * run that can be large. The authoritative verdict is the
 * `--output-last-message` file, not these streams — they are only used to
 * extract an error message — so a hard cap keeps a runaway transcript from
 * ballooning worker memory. The TAIL is kept (errors surface at the end).
 */
export const MAX_CAPTURE_BYTES = 256 * 1024;

/**
 * Environment-variable names a hardened `codex exec` child is allowed to
 * inherit. The privacy principle (design doc §4) is "minimal env-allowlist,
 * never forward secret-env into the child". The research
 * (`docs/research/codex-cli.md`) found `shell_environment_policy.inherit="core"`
 * still exposes ~55 vars — not minimal — so the plugin builds the child env
 * itself from this allowlist instead of relying on codex's own filtering.
 *
 * Only what `codex` genuinely needs to start, resolve its binary, find its auth
 * (`CODEX_HOME`), and run read-only git is included. Anything not on this list
 * — API keys, cloud creds, tokens, the user's broader shell env — is dropped.
 */
export const CODEX_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  // Codex's own home / auth location — without it codex cannot find its login.
  "CODEX_HOME",
  // Node toolchain dirs codex's vendored sub-binary may need to resolve.
  "NODE_PATH",
  "NVM_DIR",
  // Proxy config a corporate network may require for codex to reach the API.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows: codex's process resolution needs these.
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA"
]);

/**
 * Build a minimal environment for a hardened `codex exec` child by copying ONLY
 * the {@link CODEX_ENV_ALLOWLIST} keys out of `sourceEnv`. This is the env the
 * worker passes to `codex` — it keeps secret-bearing vars (API keys, cloud
 * creds, the user's wider shell env) out of the child entirely, which is
 * stronger than codex's own `shell_environment_policy` filtering.
 *
 * @param {NodeJS.ProcessEnv} [sourceEnv] - Defaults to `process.env`.
 * @returns {NodeJS.ProcessEnv}
 */
export function buildCodexChildEnv(sourceEnv = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (typeof value === "string" && value.length > 0) {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

/**
 * Cap a captured stream to {@link MAX_CAPTURE_BYTES}, keeping the TAIL (where
 * `codex exec` prints its `ERROR:` lines). A truncation marker is prepended so
 * the cut is observable in logs.
 *
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function capStreamCapture(text, maxBytes = MAX_CAPTURE_BYTES) {
  const value = String(text ?? "");
  if (value.length <= maxBytes) {
    return value;
  }
  const tail = value.slice(value.length - maxBytes);
  return `[...truncated ${value.length - maxBytes} bytes...]\n${tail}`;
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
 * Build the `codex exec` argument vector for a hardened background review run.
 *
 * `model` and `effort` are optional: when `null`/empty the corresponding flag
 * is omitted so `codex` falls back to the user's own `~/.codex/config.toml`
 * default. This avoids passing a hardcoded model that the account may reject.
 *
 * F5 HARDENING (verified against `codex-cli 0.130.0`, see
 * `docs/research/codex-cli.md`) — every flag below is a privacy / anti-hang
 * control for an UNATTENDED background run:
 *   - `--ephemeral` — no session rollout file is persisted to `~/.codex`.
 *   - `-c approval_policy="never"` — never block waiting for an approval
 *     prompt (required for an unattended run; safe paired with `-s read-only`).
 *   - `--ignore-user-config` / `--ignore-rules` — hermetic: the user's
 *     `~/.codex/config.toml`, MCP servers, personality, and execpolicy
 *     `.rules` cannot leak into or break the review.
 *   - `-c shell_environment_policy.inherit="none"` — codex's spawned shell
 *     inherits NO env. The research found `"core"` still exposes ~55 vars; the
 *     worker already builds a minimal allowlisted env (see
 *     {@link buildCodexChildEnv}), and a review only needs read-only git +
 *     file inspection, so `"none"` is the correct, maximally private value.
 *   - `-c history.persistence="none"` — defense-in-depth (a no-op for
 *     `codex exec`, but harmless and honest about intent).
 *   - `-s read-only` — filesystem read-only; a review never writes.
 *   - `--skip-git-repo-check` / `--color never` — don't hard-fail in odd CWDs;
 *     keep any human-readable fallback free of ANSI escapes.
 *
 * Set `params.json` to add `--json` (JSONL event stream — the F6 token-usage
 * source). Set `params.schemaFile` to add `--output-schema <file>` (the F2
 * claim-based structured-output path). Both are off by default so the legacy
 * free-form `exec-generic` path is unaffected.
 *
 * @param {object} params
 * @param {string | null} [params.model]
 * @param {string | null} [params.effort]
 * @param {string} params.cwd
 * @param {string} params.outputFile - Where Codex writes its final message.
 * @param {boolean} [params.json] - Add `--json` for the JSONL event stream.
 * @param {string | null} [params.schemaFile] - Add `--output-schema <file>`.
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
    // F5 hardening — unattended-run privacy / anti-hang controls.
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'approval_policy="never"',
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    'history.persistence="none"'
  );
  if (params.json) {
    args.push("--json");
  }
  if (params.schemaFile) {
    args.push("--output-schema", params.schemaFile);
  }
  args.push("--output-last-message", params.outputFile);
  return args;
}

/**
 * Whether `pid` is a value it is SAFE to pass to `process.kill(-pid, …)` /
 * `process.kill(pid, …)` as a real, specific process target.
 *
 * SAFETY-CRITICAL. `process.kill` overloads the sign of its argument: a
 * NEGATIVE pid signals the whole PROCESS GROUP. The pathological inputs are not
 * just `0`/`null`/`undefined` — they are `1` and `-1`:
 *   - `process.kill(-1, signal)` is a BROADCAST to every process the caller's
 *     user owns (POSIX `kill(-1)`), which would tear down every unrelated
 *     Claude Code session on the machine;
 *   - `process.kill(1, signal)` targets init/systemd.
 * A bare `if (!pid)` guard does NOT catch these — `!1` and `!-1` are both
 * `false`, so `1` and `-1` slip straight through. Every kill site in this
 * plugin signals `-pid` (the group), so the floor must be a real child pid:
 * an integer strictly greater than 1. `spawn().pid` is always either
 * `undefined` (spawn failed) or an OS child pid ≥ 2, so this never rejects a
 * legitimate target — it only refuses the catastrophic ones, including a
 * `pid` that came from a corrupted/hand-edited `state.json`.
 *
 * @param {unknown} pid
 * @returns {pid is number}
 */
export function isSignalablePid(pid) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
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
 * SAFETY: the pid is gated by {@link isSignalablePid} before EITHER signal —
 * a `0`/`1`/`-1`/`NaN`/non-integer pid would otherwise turn `process.kill(-pid)`
 * into a process-group broadcast (`-1` → every process the user owns) or an
 * init-targeting signal. Only a real child pid (integer > 1) is ever signalled.
 *
 * @param {number | undefined} pid
 * @param {NodeJS.Signals} signal
 */
export function killProcessTree(pid, signal) {
  if (!isSignalablePid(pid)) {
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
 * F5 HARDENING: the codex child is spawned with a MINIMAL allowlisted env
 * ({@link buildCodexChildEnv}) — secret-bearing vars never reach it — and the
 * captured stdout/stderr are bounded to {@link MAX_CAPTURE_BYTES} so a runaway
 * transcript cannot balloon worker memory.
 *
 * @param {object} params
 * @param {string} params.cwd
 * @param {string} params.prompt
 * @param {string | null} [params.model]
 * @param {string | null} [params.effort]
 * @param {string} params.outputFile
 * @param {boolean} [params.json] - Pass `--json` (F6 token-usage event stream).
 * @param {string | null} [params.schemaFile] - Pass `--output-schema <file>`.
 * @param {number} [params.timeoutMs] - Hard cap; defaults to {@link DEFAULT_REVIEW_TIMEOUT_MS}.
 * @param {NodeJS.ProcessEnv} [params.env] - Source env; an allowlisted SUBSET
 *   of it is what the child actually receives.
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
    outputFile: params.outputFile,
    json: Boolean(params.json),
    schemaFile: params.schemaFile ?? null
  });
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_REVIEW_TIMEOUT_MS;
  /** Grace period between SIGTERM and the follow-up SIGKILL. */
  const KILL_GRACE_MS = 5_000;

  const onChild = typeof params.onChild === "function" ? params.onChild : null;

  // F5: the child receives only an allowlisted SUBSET of the source env —
  // secret-bearing vars (API keys, cloud creds, the user's wider shell env)
  // are dropped entirely rather than relying on codex's own env filtering.
  const childEnv = buildCodexChildEnv(params.env ?? process.env);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("codex", args, {
        cwd: params.cwd,
        env: childEnv,
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

    // F5: bound the captured streams. `codex exec` prints its whole session
    // transcript to stderr; keep only the most recent MAX_CAPTURE_BYTES (the
    // tail, where `ERROR:` lines surface) so a runaway transcript cannot
    // balloon worker memory. The authoritative verdict is the output file.
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_CAPTURE_BYTES * 2) {
        stdout = stdout.slice(stdout.length - MAX_CAPTURE_BYTES);
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > MAX_CAPTURE_BYTES * 2) {
        stderr = stderr.slice(stderr.length - MAX_CAPTURE_BYTES);
      }
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
        status,
        stdout: capStreamCapture(stdout),
        stderr: capStreamCapture(stderr),
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
    // A signal-killed child exits `close` with `code === null` — map that to a
    // non-zero status here (the one place that sees `signal`), so `finish`
    // always receives a concrete numeric status.
    child.on("close", (code, signal) => {
      finish(code ?? (signal ? 1 : 0), signal ?? null);
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

/**
 * @typedef {object} CodexJsonStreamResult
 * @property {{ tokensIn: number, tokensCachedIn: number, tokensOut: number, tokensReasoningOut: number } | null} usage
 *   Token usage from the `turn.completed` event, or `null` if none was seen.
 *   All-zeros usage (the `codex exec review` subcommand reports zeros) is
 *   normalized to `null` — it is "unavailable", not "free".
 * @property {string | null} finalMessage - The last `agent_message` item text.
 * @property {string | null} errorMessage - A `turn.failed`/`error` message,
 *   double-decoded when codex JSON-encoded it.
 * @property {string | null} threadId - The session id from `thread.started`.
 */

/**
 * Parse the JSONL event stream emitted by `codex exec --json` (F6 token-usage
 * source). Stream facts verified against `codex-cli 0.130.0`
 * (`docs/research/codex-cli.md`):
 *   - usage lives ONLY in `turn.completed` →
 *     `usage.{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}`;
 *   - the final assistant message is the last `item.completed` whose
 *     `item.type == "agent_message"`;
 *   - failures arrive as an `error` line then `turn.failed`, and the `message`
 *     is itself a JSON-encoded string (double-decode for the inner message).
 *
 * Tolerant by design: malformed lines are skipped, unknown `type` values are
 * ignored (forward-compatible with future codex versions), and an all-zeros
 * `usage` block (the review subcommand emits zeros) is treated as `null` so
 * cost reporting is never misleadingly `$0`.
 *
 * @param {string} stdout - The raw `--json` JSONL stdout.
 * @returns {CodexJsonStreamResult}
 */
export function parseCodexJsonStream(stdout) {
  /** @type {CodexJsonStreamResult} */
  const result = {
    usage: null,
    finalMessage: null,
    errorMessage: null,
    threadId: null
  };
  const text = String(stdout ?? "");
  if (!text.trim()) {
    return result;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== "{") {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") {
      continue;
    }
    switch (event.type) {
      case "thread.started": {
        if (typeof event.thread_id === "string") {
          result.threadId = event.thread_id;
        }
        break;
      }
      case "turn.completed": {
        const usage = event.usage && typeof event.usage === "object" ? event.usage : null;
        if (usage) {
          const toCount = (value) =>
            typeof value === "number" && Number.isFinite(value) && value > 0
              ? Math.trunc(value)
              : 0;
          const tokensIn = toCount(usage.input_tokens);
          const tokensCachedIn = Math.min(toCount(usage.cached_input_tokens), tokensIn);
          const tokensOut = toCount(usage.output_tokens);
          const tokensReasoningOut = toCount(usage.reasoning_output_tokens);
          // All-zeros (the `codex exec review` subcommand reports zeros) means
          // "usage unavailable", not "this turn was free" — keep it null.
          if (tokensIn > 0 || tokensOut > 0) {
            result.usage = { tokensIn, tokensCachedIn, tokensOut, tokensReasoningOut };
          }
        }
        break;
      }
      case "item.completed": {
        const item = event.item && typeof event.item === "object" ? event.item : null;
        if (item && item.type === "agent_message" && typeof item.text === "string") {
          result.finalMessage = item.text;
        }
        break;
      }
      case "error":
      case "turn.failed": {
        const rawMessage =
          (typeof event.message === "string" && event.message) ||
          (event.error && typeof event.error === "object" && typeof event.error.message === "string"
            ? event.error.message
            : null);
        if (rawMessage) {
          // codex JSON-encodes the inner error message; double-decode it.
          let decoded = rawMessage;
          let wasDecoded = false;
          try {
            const inner = JSON.parse(rawMessage);
            if (inner && typeof inner === "object") {
              const innerMessage =
                (inner.error && typeof inner.error.message === "string"
                  ? inner.error.message
                  : null) ||
                (typeof inner.message === "string" ? inner.message : null);
              if (innerMessage) {
                decoded = innerMessage;
                wasDecoded = true;
              }
            }
          } catch {
            // Not JSON-encoded — use as-is.
          }
          // `error` and `turn.failed` usually carry the SAME error; prefer the
          // first cleanly-decoded message and never let a later opaque
          // `{...}`-style message clobber a good one.
          if (!result.errorMessage || wasDecoded) {
            result.errorMessage = decoded;
          }
        }
        break;
      }
      default:
        // Unknown future event type — ignore, never crash.
        break;
    }
  }
  return result;
}
