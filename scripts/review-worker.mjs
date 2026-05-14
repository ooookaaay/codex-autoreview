#!/usr/bin/env node
/**
 * Detached background review worker.
 *
 * Spawned by `lib/auto-review.mjs` with `--cwd` and `--review-id`. Reads the
 * queued review record (which carries the prompt + model + effort + timeout),
 * runs `codex exec` to completion, and writes the verdict back into the
 * per-project state. This process is detached from the Claude session, so it is
 * free to block on Codex for as long as the review takes — but never forever.
 *
 * HANG PROTECTION / TERMINAL-STATE GUARANTEE:
 *   - `runCodexReview` enforces a hard wall-clock timeout and kills the codex
 *     process tree if it hangs.
 *   - Every exit path here — codex missing, spawn error, crash, non-zero exit,
 *     killed by signal, timeout, malformed output, state-write error, or this
 *     worker itself being killed (SIGTERM/SIGINT) — funnels through
 *     `settleTerminal`, so a review can never be left stuck in `running`.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  extractVerdictLine,
  getCodexAvailability,
  killProcessTree,
  resolveReviewTimeoutMs,
  runCodexReview
} from "./lib/codex.mjs";
import {
  ensureStateDir,
  listReviews,
  resolveReviewsDir,
  upsertReview
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--cwd" || token === "--review-id") {
      const key = token === "--cwd" ? "cwd" : "reviewId";
      options[key] = argv[index + 1] ?? "";
      index += 1;
    }
  }
  return options;
}

/**
 * Pull a human-readable error out of `codex exec` stderr. The CLI emits machine
 * errors as `ERROR: {"type":"error",...,"error":{"message":"..."}}` lines;
 * extract the inner message when present, otherwise return the last few
 * non-empty stderr lines.
 *
 * @param {string} stderr
 * @returns {string | null}
 */
function extractCodexError(stderr) {
  const text = String(stderr ?? "").trim();
  if (!text) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^ERROR:\s*(\{.*\})\s*$/);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        const message = parsed?.error?.message ?? parsed?.message;
        if (typeof message === "string" && message.trim()) {
          return `codex error: ${message.trim()}`;
        }
      } catch {
        // Fall through to the generic tail handling.
      }
      return `codex error: ${match[1]}`;
    }
  }
  const tail = lines.filter(Boolean).slice(-3).join(" ");
  return tail || null;
}

/**
 * @param {string} logFile
 * @param {string} message
 */
function appendLog(logFile, message) {
  if (!logFile) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Logging is best-effort; never let it crash the worker.
  }
}

/**
 * Tracks whether this worker has already written a terminal state for its
 * review, so the terminal write happens exactly once no matter how many paths
 * (normal completion, error, signal handler, top-level finally) try to settle.
 */
const terminalState = {
  /** @type {string | null} */
  workspaceRoot: null,
  /** @type {string | null} */
  reviewId: null,
  /** @type {string | null} */
  logFile: null,
  settled: false,
  /**
   * Pid of the in-flight detached `codex exec` child, or null when none is
   * running. The signal handlers reap this so killing the worker never orphans
   * an expensive codex run.
   * @type {number | undefined | null}
   */
  codexChildPid: null
};

/**
 * Write a terminal (`failed`/`completed`) state for the current review exactly
 * once. Every exit path in this worker goes through here, which is what
 * guarantees a review is never abandoned in `running`.
 *
 * @param {"completed" | "failed"} status
 * @param {Partial<import("./lib/state.mjs").ReviewRecord>} [patch]
 */
function settleTerminal(status, patch = {}) {
  if (terminalState.settled || !terminalState.workspaceRoot || !terminalState.reviewId) {
    return;
  }
  terminalState.settled = true;
  try {
    upsertReview(terminalState.workspaceRoot, {
      id: terminalState.reviewId,
      status,
      ...patch
    });
  } catch (error) {
    // The state write itself failed — there is nothing more we can do to
    // persist the outcome, but the worker must still exit. Surface it on
    // stderr and in the log so the failure is at least observable.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`review-worker: failed to persist terminal state: ${message}\n`);
    appendLog(terminalState.logFile ?? "", `Failed to persist terminal state: ${message}`);
  }
}

/**
 * Install SIGTERM/SIGINT handlers so that even if this detached worker is
 * killed (host shutdown, manual kill, the SessionEnd cleanup hook reaping this
 * session's workers) it:
 *   1. kills the in-flight `codex exec` process tree, so an expensive codex run
 *      is never orphaned to keep burning quota after the worker is gone; and
 *   2. flushes a `failed` terminal state, so the review is never left stuck.
 */
function installSignalHandlers() {
  for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT"])) {
    process.on(signal, () => {
      appendLog(
        terminalState.logFile ?? "",
        `Worker received ${signal}; killing codex child and marking review failed.`
      );
      // Reap the detached codex child tree first — it leads its own process
      // group, so it would otherwise survive this worker exiting.
      if (terminalState.codexChildPid) {
        killProcessTree(terminalState.codexChildPid, "SIGTERM");
        killProcessTree(terminalState.codexChildPid, "SIGKILL");
        terminalState.codexChildPid = null;
      }
      settleTerminal("failed", {
        errorMessage: `Review worker was terminated by ${signal} before it could finish.`
      });
      // Re-exit promptly; the handler has done its one job.
      process.exit(1);
    });
  }
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = options.cwd || process.cwd();
  const reviewId = options.reviewId;
  if (!reviewId) {
    process.stderr.write("review-worker: missing --review-id\n");
    process.exitCode = 1;
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  ensureStateDir(workspaceRoot);

  const review = listReviews(workspaceRoot).find((entry) => entry.id === reviewId);
  if (!review) {
    // Nothing to settle: there is no review record to mark terminal.
    process.stderr.write(`review-worker: no queued review found for ${reviewId}\n`);
    process.exitCode = 1;
    return;
  }

  // From here on the review record exists, so every exit path must leave it in
  // a terminal state. Register it with the terminal-state machinery.
  const logFile = review.logFile || path.join(resolveReviewsDir(workspaceRoot), `${reviewId}.log`);
  terminalState.workspaceRoot = workspaceRoot;
  terminalState.reviewId = reviewId;
  terminalState.logFile = logFile;

  const request = review.request;
  if (!request || typeof request !== "object" || typeof request.prompt !== "string") {
    appendLog(logFile, "Queued review is missing its request payload.");
    settleTerminal("failed", {
      errorMessage: "Queued review is missing its request payload."
    });
    process.exitCode = 1;
    return;
  }

  const outputFile = path.join(resolveReviewsDir(workspaceRoot), `${reviewId}.output.txt`);
  const timeoutMs = resolveReviewTimeoutMs({ timeoutMs: request.timeoutMs });

  appendLog(
    logFile,
    `Starting ${review.kind} review with model=${request.model} effort=${request.effort} timeoutMs=${timeoutMs}.`
  );
  upsertReview(workspaceRoot, { id: reviewId, status: "running" });

  const availability = getCodexAvailability(request.cwd ?? cwd);
  if (!availability.available) {
    const detail = availability.detail ? ` (${availability.detail})` : "";
    appendLog(logFile, `Codex CLI unavailable${detail}.`);
    settleTerminal("failed", {
      errorMessage: `Codex CLI is not available${detail}.`
    });
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = await runCodexReview({
      cwd: request.cwd ?? cwd,
      prompt: request.prompt,
      model: request.model,
      effort: request.effort,
      outputFile,
      timeoutMs,
      env: process.env,
      // Track the codex child pid so the signal handlers can reap its process
      // tree if this worker is killed mid-run.
      onChild: (pid) => {
        terminalState.codexChildPid = pid ?? null;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(logFile, `codex exec threw: ${message}`);
    settleTerminal("failed", {
      errorMessage: `codex exec failed: ${message}`
    });
    process.exitCode = 1;
    return;
  }

  // A hard timeout fired: the codex process tree was killed. This is terminal —
  // never leave the review `running` just because codex hung.
  if (result.timedOut) {
    const seconds = Math.round(result.timeoutMs / 1000);
    const detail = `codex exec timed out after ${seconds}s and was killed`;
    appendLog(logFile, detail);
    settleTerminal("failed", {
      output: null,
      errorMessage: detail
    });
    process.exitCode = 1;
    return;
  }

  // The authoritative verdict is the --output-last-message file. `codex exec`
  // prints its session transcript to stderr (not stdout) and may exit non-zero
  // even when it produced a partial answer, so the file — not the exit code —
  // is the source of truth for "did we get a verdict".
  let finalMessage = "";
  try {
    if (fs.existsSync(outputFile)) {
      finalMessage = fs.readFileSync(outputFile, "utf8").trim();
    }
  } catch {
    finalMessage = "";
  }

  if (!finalMessage) {
    const detail =
      (result.error &&
        (result.error instanceof Error ? result.error.message : String(result.error))) ||
      extractCodexError(result.stderr) ||
      (result.signal ? `codex exec was killed (signal ${result.signal})` : null) ||
      `codex exec exited with status ${result.status} and produced no verdict`;
    appendLog(logFile, `Review failed: ${detail}`);
    settleTerminal("failed", {
      output: null,
      errorMessage: detail
    });
    process.exitCode = result.status === 0 ? 1 : result.status || 1;
    return;
  }

  const verdict = extractVerdictLine(finalMessage);
  appendLog(logFile, `Review completed. Verdict: ${verdict ?? "(none)"}`);
  settleTerminal("completed", {
    verdict,
    output: finalMessage,
    errorMessage: null
  });
}

installSignalHandlers();

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    appendLog(terminalState.logFile ?? "", `Worker crashed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Final backstop: if main() returned or threw without reaching a terminal
    // state for a registered review, mark it failed now. A no-op when the
    // review was already settled, or when there was no review to settle.
    settleTerminal("failed", {
      errorMessage: "Review worker exited before reaching a terminal state."
    });
  });
