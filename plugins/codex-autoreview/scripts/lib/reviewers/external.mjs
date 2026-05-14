/**
 * `external` reviewer backend — Wave 2B, non-default.
 *
 * Runs an arbitrary user-configured CLI (e.g. `claude -p`, `gemini`) as a
 * second reviewer. The `externalCommand` config object (persisted under the
 * project config `backendConfig`) is the full contract from
 * `docs/research/external-reviewer-architecture.md` §1:
 *
 * ```jsonc
 * {
 *   "command": "claude",                 // resolved on PATH
 *   "args": ["-p", "--output-format", "json", "--model", "sonnet"],
 *   "promptDelivery": "stdin",           // "stdin" | "file" | "arg"
 *   "outputCapture": "stdout",           // "stdout" | "file"
 *   "outputFormat": "json",              // "json" | "text"
 *   "resultPath": "result",              // dot-path into JSON → verdict text
 *   "timeoutMs": 240000,
 *   "env": ["HOME", "PATH"]              // explicit allowlist (privacy)
 * }
 * ```
 *
 * Placeholders substituted in every `args[]` element AND exported as env vars
 * (`CODEX_AUTOREVIEW_PROMPT_FILE` etc.) so file-based tools can pick them up:
 *   `{prompt}` `{promptFile}` `{outputFile}` `{cwd}` `{kind}` `{base}`.
 *
 * Three-tier output handling (the structured-output strategy — the plugin
 * NEVER depends on a tool emitting JSON, JSON is only an optimization):
 *   1. native JSON envelope → extract the answer string via `resultPath`
 *      (`outputFormat: "json"`); when the answer is itself the plugin's
 *      claim-based JSON object it is parsed structurally;
 *   2. raw stdout/file text → the trimmed output IS the answer
 *      (`outputFormat: "text"`);
 *   3. prompt-enforced text contract → `fromVerdictLine` parses the verdict
 *      line from the answer string (the universal floor — every tool supports
 *      it because the plugin's prompts already pin the first-line format).
 *
 * @file
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

import {
  fromVerdictLine,
  normalizeReviewResult,
  REVIEW_SCHEMA_VERSION
} from "../review-schema.mjs";
import { failedParsedReview, finalizeParsedReview } from "./exec-shared.mjs";

/**
 * Grace period between SIGTERM and the follow-up SIGKILL when an external tool
 * overruns its wall-clock timeout. Mirrors the codex path.
 */
const KILL_GRACE_MS = 5_000;

/** Default hard wall-clock cap for an external review run, in milliseconds. */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 240_000;

/** Bytes captured per stream before the head is dropped (anti-balloon). */
const MAX_CAPTURE_BYTES = 256 * 1024;

/**
 * Conservative `ARG_MAX` budget for `promptDelivery: "arg"`. A substituted
 * argv larger than this is REFUSED with a clear error rather than silently
 * truncated — big diffs/plans must go through stdin or a temp file instead.
 */
const ARG_MAX_BUDGET = 100 * 1024;

/**
 * Validate the shape of an `externalCommand` config object. Returns a list of
 * human-readable problems (empty = valid). `run` calls this first; also
 * exposed so the config command / `/doctor` can validate without running.
 *
 * @param {unknown} config
 * @returns {string[]}
 */
export function validateExternalConfig(config) {
  /** @type {string[]} */
  const problems = [];
  if (!config || typeof config !== "object") {
    return ["externalCommand config must be an object."];
  }
  const cfg = /** @type {Record<string, unknown>} */ (config);
  if (typeof cfg.command !== "string" || !cfg.command.trim()) {
    problems.push("`command` is required and must be a non-empty string.");
  }
  if (cfg.args != null && !Array.isArray(cfg.args)) {
    problems.push("`args` must be an array of strings when present.");
  } else if (Array.isArray(cfg.args) && cfg.args.some((a) => typeof a !== "string")) {
    problems.push("`args` must contain only strings.");
  }
  const deliveries = ["stdin", "file", "arg"];
  if (cfg.promptDelivery != null && !deliveries.includes(String(cfg.promptDelivery))) {
    problems.push(`\`promptDelivery\` must be one of: ${deliveries.join(", ")}.`);
  }
  const captures = ["stdout", "file"];
  if (cfg.outputCapture != null && !captures.includes(String(cfg.outputCapture))) {
    problems.push(`\`outputCapture\` must be one of: ${captures.join(", ")}.`);
  }
  const formats = ["json", "text"];
  if (cfg.outputFormat != null && !formats.includes(String(cfg.outputFormat))) {
    problems.push(`\`outputFormat\` must be one of: ${formats.join(", ")}.`);
  }
  if (cfg.promptDelivery === "arg" && Array.isArray(cfg.args)) {
    if (!cfg.args.some((a) => typeof a === "string" && a.includes("{prompt}"))) {
      problems.push('`promptDelivery: "arg"` requires `{prompt}` to appear in `args`.');
    }
  }
  if (cfg.promptDelivery === "file" && Array.isArray(cfg.args)) {
    const usesPlaceholder = cfg.args.some(
      (a) => typeof a === "string" && a.includes("{promptFile}")
    );
    // A file-delivery tool may also pick the path up via the env var, so this
    // is a soft note rather than a hard problem only when args is present and
    // does not reference it AND there is no obvious env pickup. Keep it as a
    // hint; do not block — env pickup is a documented path.
    if (!usesPlaceholder) {
      problems.push(
        '`promptDelivery: "file"` usually needs `{promptFile}` in `args` (or the tool must read $CODEX_AUTOREVIEW_PROMPT_FILE).'
      );
    }
  }
  if (cfg.outputCapture === "file" && Array.isArray(cfg.args)) {
    const usesPlaceholder = cfg.args.some(
      (a) => typeof a === "string" && a.includes("{outputFile}")
    );
    if (!usesPlaceholder) {
      problems.push(
        '`outputCapture: "file"` needs `{outputFile}` in `args` so the tool knows where to write.'
      );
    }
  }
  if (cfg.resultPath != null && typeof cfg.resultPath !== "string") {
    problems.push("`resultPath` must be a string dot-path when present.");
  }
  if (cfg.timeoutMs != null) {
    const t = Number(cfg.timeoutMs);
    if (!Number.isFinite(t) || t <= 0) {
      problems.push("`timeoutMs` must be a positive number when present.");
    }
  }
  if (cfg.env != null && !Array.isArray(cfg.env)) {
    problems.push("`env` must be an array of env-var-name strings (allowlist).");
  } else if (Array.isArray(cfg.env) && cfg.env.some((e) => typeof e !== "string")) {
    problems.push("`env` must contain only env-var-name strings.");
  }
  return problems;
}

/**
 * Build the placeholder substitution map for one run.
 *
 * @param {object} params
 * @param {string} params.prompt
 * @param {string} params.promptFile - Abs path (may be unused).
 * @param {string} params.outputFile - Abs path (may be unused).
 * @param {string} params.cwd
 * @param {"plan" | "code"} params.kind
 * @param {string | null} params.base
 * @returns {Record<string, string>}
 */
function buildPlaceholders(params) {
  return {
    "{prompt}": params.prompt,
    "{promptFile}": params.promptFile,
    "{outputFile}": params.outputFile,
    "{cwd}": params.cwd,
    "{kind}": params.kind,
    "{base}": params.base ?? ""
  };
}

/**
 * Substitute every `{placeholder}` in a single argv element.
 *
 * @param {string} arg
 * @param {Record<string, string>} placeholders
 * @returns {string}
 */
function substituteArg(arg, placeholders) {
  let out = String(arg);
  for (const [token, value] of Object.entries(placeholders)) {
    if (out.includes(token)) {
      out = out.split(token).join(value);
    }
  }
  return out;
}

/**
 * Build the allowlisted child env for an external tool. The privacy principle:
 * only the explicitly-listed env vars (plus the plugin's own placeholder vars)
 * reach the child. When no `env` allowlist is configured, a minimal safe
 * default (`PATH`, `HOME`) is used so the tool can at least start.
 *
 * @param {object} params
 * @param {string[] | undefined} params.allowlist
 * @param {NodeJS.ProcessEnv} params.sourceEnv
 * @param {string} params.promptFile
 * @param {string} params.outputFile
 * @param {string} params.cwd
 * @param {"plan" | "code"} params.kind
 * @param {string | null} params.base
 * @returns {NodeJS.ProcessEnv}
 */
export function buildExternalChildEnv(params) {
  const allowlist =
    Array.isArray(params.allowlist) && params.allowlist.length > 0
      ? params.allowlist
      : ["PATH", "HOME"];
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const key of allowlist) {
    if (typeof key !== "string") {
      continue;
    }
    const value = params.sourceEnv[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  // The plugin's own placeholder vars — file-based tools pick the prompt /
  // output path up here even when they cannot take it on argv.
  env.CODEX_AUTOREVIEW_PROMPT_FILE = params.promptFile;
  env.CODEX_AUTOREVIEW_OUTPUT_FILE = params.outputFile;
  env.CODEX_AUTOREVIEW_CWD = params.cwd;
  env.CODEX_AUTOREVIEW_KIND = params.kind;
  if (params.base) {
    env.CODEX_AUTOREVIEW_BASE = params.base;
  }
  return env;
}

/**
 * Cap a captured stream, keeping the TAIL (where tools print final results /
 * errors). A truncation marker is prepended so the cut is observable.
 *
 * @param {string} text
 * @returns {string}
 */
function capCapture(text) {
  const value = String(text ?? "");
  if (value.length <= MAX_CAPTURE_BYTES) {
    return value;
  }
  return `[...truncated ${value.length - MAX_CAPTURE_BYTES} bytes...]\n${value.slice(
    value.length - MAX_CAPTURE_BYTES
  )}`;
}

/**
 * Spawn an arbitrary command DETACHED (own process group) under a hard
 * wall-clock timeout, feed it `input` on stdin, capture bounded stdout/stderr,
 * and reap the whole process tree on timeout (SIGTERM → SIGKILL grace).
 *
 * This is the generic equivalent of `runCodexReview`'s hang-protection
 * machinery, local to the external backend (the codex helper is hardcoded to
 * `codex` and lives in a file this wave does not own). NEVER throws — a spawn
 * failure resolves with `{error}`, a timeout resolves with `{timedOut: true}`.
 *
 * @param {object} params
 * @param {string} params.command
 * @param {string[]} params.args
 * @param {string} params.cwd
 * @param {NodeJS.ProcessEnv} params.env
 * @param {string | null} params.input - Written to stdin then closed; `null`
 *   leaves stdin closed immediately (file/arg delivery).
 * @param {number} params.timeoutMs
 * @param {(pid: number | undefined) => void} [params.onChild]
 * @returns {Promise<{ status: number, stdout: string, stderr: string, signal: string | null, error: Error | null, timedOut: boolean, timeoutMs: number }>}
 */
export function spawnWithTimeout(params) {
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_EXTERNAL_TIMEOUT_MS;
  const onChild = typeof params.onChild === "function" ? params.onChild : null;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(params.command, params.args, {
        cwd: params.cwd,
        env: params.env,
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

    if (onChild) {
      try {
        onChild(child.pid);
      } catch {
        // A bad callback must not break the run.
      }
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let killTimer = null;

    /**
     * Kill the child's whole process group; fall back to the direct child.
     * @param {NodeJS.Signals} signal
     */
    const killTree = (signal) => {
      const pid = child.pid;
      if (!pid) {
        return;
      }
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
      }
    };

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

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
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
      if (onChild) {
        try {
          onChild(undefined);
        } catch {
          // ignore
        }
      }
      resolve({
        status,
        stdout: capCapture(stdout),
        stderr: capCapture(stderr),
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

    try {
      child.stdin?.on("error", () => {});
      child.stdin?.end(params.input ?? "");
    } catch {
      // stdin already closed — the tool runs with whatever it received.
    }
  });
}

/**
 * Walk a dot-path into a parsed JSON object. Returns `undefined` when any
 * segment is missing. A leading `$.` or `.` is tolerated.
 *
 * @param {unknown} obj
 * @param {string} dotPath
 * @returns {unknown}
 */
export function resolveDotPath(obj, dotPath) {
  if (obj == null || typeof dotPath !== "string" || !dotPath.trim()) {
    return obj;
  }
  const segments = dotPath
    .replace(/^\$?\.?/, "")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  let cursor = obj;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== "object") {
      return undefined;
    }
    cursor = /** @type {Record<string, unknown>} */ (cursor)[segment];
  }
  return cursor;
}

/**
 * The three-tier output handling: turn a tool's raw output into an answer
 * STRING, then into a {@link import("../review-schema.mjs").ReviewResult}.
 *
 * @param {object} params
 * @param {string} params.rawOutput - stdout, or the `{outputFile}` content.
 * @param {"json" | "text"} params.outputFormat
 * @param {string} params.resultPath - dot-path into the JSON envelope.
 * @param {"plan" | "code"} params.kind
 * @param {string} params.profile
 * @returns {{ result: import("../review-schema.mjs").ReviewResult | null, answer: string, errorMessage: string | null }}
 */
export function parseExternalOutput(params) {
  const rawOutput = String(params.rawOutput ?? "").trim();
  if (!rawOutput) {
    return { result: null, answer: "", errorMessage: "external tool produced no output" };
  }

  let answer = rawOutput;

  if (params.outputFormat === "json") {
    // Tier 1: native JSON envelope. Parse, then walk `resultPath` to the
    // answer. If JSON parsing fails, defensively fall through to tier 3 with
    // the raw text (gemini-cli has shipped incomplete --output-format json).
    let parsed;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      const located = resolveDotPath(parsed, params.resultPath || "result");
      if (located && typeof located === "object") {
        // The answer is itself a structured object — treat it as the plugin's
        // claim-based JSON and normalize it directly (the gold path).
        const result = normalizeReviewResult(located, {
          kind: params.kind,
          profile: params.profile
        });
        return { result, answer: JSON.stringify(located), errorMessage: null };
      }
      if (typeof located === "string" && located.trim()) {
        answer = located.trim();
      } else {
        // The dot-path missed — but the envelope might itself BE the answer
        // object (a schema-constrained tool with no envelope). Try that.
        const asResult = normalizeReviewResult(parsed, {
          kind: params.kind,
          profile: params.profile
        });
        if (asResult.verdict !== "FAILED" || asResult.summary) {
          return { result: asResult, answer: rawOutput, errorMessage: null };
        }
        return {
          result: null,
          answer: "",
          errorMessage: `external tool JSON had no value at resultPath "${
            params.resultPath || "result"
          }"`
        };
      }
    }
    // parsed was null → fall through to tier 3 on the raw text.
  }

  // Tier 2/3: `answer` is now a plain text answer (raw text mode, or the
  // string extracted from the JSON envelope). The answer string might itself
  // be the plugin's claim-based JSON — try that first.
  const trimmed = answer.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const inner = JSON.parse(trimmed);
      if (inner && typeof inner === "object" && "verdict" in inner) {
        const result = normalizeReviewResult(inner, {
          kind: params.kind,
          profile: params.profile
        });
        return { result, answer: trimmed, errorMessage: null };
      }
    } catch {
      // Not JSON — the prompt-enforced text contract handles it below.
    }
  }

  // Tier 3 — the universal floor: the prompt pinned the first line to a
  // verdict (`CLEAN:`/`ISSUES:`/`SOUND:`/`CONCERNS:`). `fromVerdictLine`
  // produces a valid minimal result; the structured arrays stay empty.
  const verdictLine = trimmed.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const result = fromVerdictLine(verdictLine, {
    kind: params.kind,
    profile: params.profile,
    fullOutput: trimmed
  });
  result.summary = result.summary || verdictLine;
  return { result, answer: trimmed, errorMessage: null };
}

/** @type {import("./index.mjs").ReviewerBackend} */
export const externalBackend = {
  id: "external",

  capabilities: {
    // The external tool's real capabilities depend on its config. The
    // conservative static posture is the universal floor (prompt-enforced text
    // contract); a tool given a JSON-schema flag does better at runtime, but
    // the worker must not over-promise before the run.
    structuredOutput: false,
    accurateUsage: false,
    reviewScoped: false,
    claimBased: false
  },

  /**
   * @param {import("./index.mjs").ProbeCtx} ctx
   * @returns {{ available: boolean, detail: string }}
   */
  probe(ctx) {
    const config = ctx.backendConfig ?? {};
    const problems = validateExternalConfig(config);
    if (problems.length > 0) {
      return {
        available: false,
        detail: `external backend config invalid: ${problems[0]}`
      };
    }
    const command = /** @type {Record<string, unknown>} */ (config).command;
    // Time-boxed `<command> --version` probe — a tool wedged on `--version`
    // is treated as unavailable rather than blocking the worker.
    const result = spawnVersionProbe(String(command), ctx.env ?? process.env);
    if (!result.available) {
      return {
        available: false,
        detail: `external command \`${command}\` not runnable: ${result.detail}`
      };
    }
    return { available: true, detail: `external command \`${command}\` — ${result.detail}` };
  },

  /**
   * Run the configured external CLI under the §1 placeholder-substitution
   * contract. NEVER throws — a spawn failure / timeout / bad config resolves
   * with a {@link import("./index.mjs").RawRunResult} the worker can settle.
   *
   * @param {import("./index.mjs").RunCtx} ctx
   * @returns {Promise<import("./index.mjs").RawRunResult>}
   */
  async run(ctx) {
    const config = ctx.backendConfig ?? {};
    const problems = validateExternalConfig(config);
    if (problems.length > 0) {
      return {
        status: 1,
        stdout: "",
        stderr: "",
        signal: null,
        error: new Error(`external backend config invalid: ${problems[0]}`),
        timedOut: false,
        timeoutMs: 0,
        outputFileContent: ""
      };
    }
    const cfg = /** @type {Record<string, any>} */ (config);
    const command = String(cfg.command);
    const promptDelivery = cfg.promptDelivery || "stdin";
    const outputCapture = cfg.outputCapture || "stdout";
    const timeoutMs =
      typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0
        ? cfg.timeoutMs
        : ctx.timeoutMs || DEFAULT_EXTERNAL_TIMEOUT_MS;

    // Per-run temp dir (0700) holding the optional prompt + output files.
    let tempDir = "";
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoreview-ext-"));
    } catch (error) {
      return {
        status: 1,
        stdout: "",
        stderr: "",
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
        timeoutMs,
        outputFileContent: ""
      };
    }
    const promptFile = path.join(tempDir, "prompt.txt");
    // Prefer the worker-provided outputFile so the artifact lands in the
    // reviews dir; fall back to the temp dir.
    const outputFile =
      outputCapture === "file"
        ? ctx.outputFile || path.join(tempDir, "output.txt")
        : path.join(tempDir, "output.txt");

    try {
      // Prompt file is always written (0600) — file-delivery tools read it,
      // and even stdin/arg tools may pick it up via the env var.
      fs.writeFileSync(promptFile, ctx.prompt ?? "", { encoding: "utf8", mode: 0o600 });
      if (outputCapture === "file") {
        // Pre-create an empty output file so the tool can write into it.
        fs.writeFileSync(outputFile, "", { encoding: "utf8", mode: 0o600 });
      }

      const placeholders = buildPlaceholders({
        prompt: ctx.prompt ?? "",
        promptFile,
        outputFile,
        cwd: ctx.cwd,
        kind: ctx.kind,
        base: ctx.base ?? null
      });
      const rawArgs = Array.isArray(cfg.args) ? cfg.args : [];
      const args = rawArgs.map((a) => substituteArg(a, placeholders));

      // `arg` delivery: refuse an oversized argv rather than silently truncate.
      if (promptDelivery === "arg") {
        const argvBytes = args.reduce((sum, a) => sum + Buffer.byteLength(a, "utf8"), 0);
        if (argvBytes > ARG_MAX_BUDGET) {
          return {
            status: 1,
            stdout: "",
            stderr: "",
            signal: null,
            error: new Error(
              `external backend: substituted argv is ${argvBytes} bytes, over the ${ARG_MAX_BUDGET}-byte ARG_MAX budget — use promptDelivery "stdin" or "file" for large prompts`
            ),
            timedOut: false,
            timeoutMs,
            outputFileContent: ""
          };
        }
      }

      const childEnv = buildExternalChildEnv({
        allowlist: cfg.env,
        sourceEnv: ctx.env ?? process.env,
        promptFile,
        outputFile,
        cwd: ctx.cwd,
        kind: ctx.kind,
        base: ctx.base ?? null
      });

      // stdin delivery feeds the prompt; file/arg delivery closes stdin
      // immediately (some tools block on an open stdin otherwise).
      const input = promptDelivery === "stdin" ? ctx.prompt ?? "" : null;

      const raw = await spawnWithTimeout({
        command,
        args,
        cwd: ctx.cwd,
        env: childEnv,
        input,
        timeoutMs,
        onChild: ctx.onChild
      });

      let outputFileContent = "";
      if (outputCapture === "file") {
        try {
          if (fs.existsSync(outputFile)) {
            outputFileContent = fs.readFileSync(outputFile, "utf8").trim();
          }
        } catch {
          outputFileContent = "";
        }
      }

      return {
        status: raw.status,
        stdout: raw.stdout,
        stderr: raw.stderr,
        signal: raw.signal,
        error: raw.error,
        timedOut: raw.timedOut,
        timeoutMs: raw.timeoutMs,
        outputFileContent
      };
    } catch (error) {
      return {
        status: 1,
        stdout: "",
        stderr: "",
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
        timeoutMs,
        outputFileContent: ""
      };
    } finally {
      // Always clean up the per-run temp dir. The worker-provided outputFile
      // (in the reviews dir) is NOT under tempDir, so it survives.
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  },

  /**
   * @param {import("./index.mjs").RawRunResult} raw
   * @param {import("./index.mjs").RunCtx} ctx
   * @returns {import("./index.mjs").ParsedReview}
   */
  parse(raw, ctx) {
    if (raw.timedOut) {
      const seconds = Math.round((raw.timeoutMs ?? 0) / 1000);
      return failedParsedReview(
        `external reviewer timed out after ${seconds}s and was killed`
      );
    }
    const config = /** @type {Record<string, any>} */ (ctx.backendConfig ?? {});
    const outputCapture = config.outputCapture || "stdout";
    const outputFormat = config.outputFormat || "text";
    const resultPath = typeof config.resultPath === "string" ? config.resultPath : "result";

    const rawOutput =
      outputCapture === "file" ? raw.outputFileContent || "" : raw.stdout || "";

    if (!rawOutput.trim()) {
      const detail =
        (raw.error && (raw.error instanceof Error ? raw.error.message : String(raw.error))) ||
        (raw.stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ") ||
        (raw.signal ? `external tool was killed (signal ${raw.signal})` : null) ||
        `external tool exited with status ${raw.status} and produced no output`;
      return failedParsedReview(detail);
    }

    const { result, errorMessage } = parseExternalOutput({
      rawOutput,
      outputFormat,
      resultPath,
      kind: ctx.kind,
      profile:
        ctx.profile ?? (ctx.kind === "plan" ? "plan-devils-advocate" : "generic-code")
    });

    if (!result) {
      return failedParsedReview(errorMessage || "external tool produced no usable review");
    }

    // The external backend never has accurate token usage (it cannot trust an
    // arbitrary tool's self-reported counts), so `usage` stays null — honest
    // "cost unknown" rather than a misleading $0. A tool that emits real
    // structured output still has populated claims/findings; mark `degraded`
    // only when there are no structured findings AND no claims.
    result.usage = result.usage ?? null;
    const hasStructure =
      (Array.isArray(result.findings) && result.findings.length > 0) ||
      (Array.isArray(result.claims) && result.claims.length > 0);
    return finalizeParsedReview({
      result,
      degraded: !hasStructure && result.schemaVersion === REVIEW_SCHEMA_VERSION
    });
  }
};

/**
 * Time-boxed `<command> --version` availability probe. Local to this backend
 * (the shared codex probe is hardcoded to `codex`).
 *
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ available: boolean, detail: string }}
 */
function spawnVersionProbe(command, env) {
  // A small synchronous `<command> --version` spawn keeps this backend
  // self-contained (the shared `binaryAvailable` probe in process.mjs is
  // fine too, but spawnSync here avoids a cross-module coupling for a
  // one-liner).
  const result = spawnSync(command, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });
  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    if (code === "ENOENT") {
      return { available: false, detail: "not found on PATH" };
    }
    if (code === "ETIMEDOUT") {
      return { available: false, detail: "did not respond to --version within 10s" };
    }
    return { available: false, detail: result.error.message };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    // Some tools have no --version and exit non-zero; treat a runnable binary
    // as available anyway — the real run will surface a genuine failure.
    return { available: true, detail: `runnable (--version exited ${result.status})` };
  }
  return {
    available: true,
    detail: (result.stdout || result.stderr || "ok").trim().split(/\r?\n/)[0] || "ok"
  };
}
