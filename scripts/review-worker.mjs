#!/usr/bin/env node
/**
 * Detached background review worker.
 *
 * Spawned by `lib/auto-review.mjs` with `--cwd` and `--review-id`. Reads the
 * queued review record (which carries the prompt + backend + model + effort +
 * timeout), runs the configured REVIEWER BACKEND to completion, and writes the
 * verdict back into the per-project state. This process is detached from the
 * Claude session, so it is free to block for as long as the review takes — but
 * never forever.
 *
 * F1 — PLUGGABLE REVIEWER ABSTRACTION: the worker no longer calls codex
 * directly. It looks up `request.backend` in the reviewer registry and calls
 * the backend's three methods: `probe()` → `run()` → `parse()`. ONLY those
 * three codex-coupling points became backend calls — the hang-protection
 * machinery below is byte-for-byte unchanged.
 *
 * HANG PROTECTION / TERMINAL-STATE GUARANTEE (UNCHANGED):
 *   - `backend.run` enforces a hard wall-clock timeout and kills the review
 *     process tree if it hangs (the exec-* backends reuse `runCodexReview`).
 *   - Every exit path here — backend unavailable, spawn error, crash, non-zero
 *     exit, killed by signal, timeout, malformed output, state-write error, or
 *     this worker itself being killed (SIGTERM/SIGINT) — funnels through
 *     `settleTerminal`, so a review can never be left stuck in `running`.
 *
 * @file
 */

import path from "node:path";
import process from "node:process";

import { killProcessTree, resolveReviewTimeoutMs } from "./lib/codex.mjs";
import { getReviewerBackend } from "./lib/reviewers/index.mjs";
import {
  appendReviewGaps,
  ensureStateDir,
  getPricingOverride,
  isTerminalStatus,
  listReviews,
  resolveReviewsDir,
  updateReviewIf
} from "./lib/state.mjs";
import { normalizeRateOverride } from "./lib/pricing.mjs";
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
 * COMPARE-AND-SET: the write is conditional on the review NOT already being
 * terminal. If the SessionEnd cleanup hook already reconciled this review to
 * `failed` (because the worker outlived its session), this worker must not
 * resurrect it with a `completed`/`failed` of its own — the cleanup's verdict
 * stands. The whole check-and-write runs in one locked critical section.
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
    updateReviewIf(
      terminalState.workspaceRoot,
      terminalState.reviewId,
      (review) => !isTerminalStatus(review),
      { status, ...patch }
    );
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

  const logFile = review.logFile || path.join(resolveReviewsDir(workspaceRoot), `${reviewId}.log`);

  // If the review is ALREADY terminal, a SessionEnd cleanup (or another actor)
  // has finished it — this worker must not resurrect it. Exit without
  // registering it with the terminal-state machinery, so no later write fires.
  if (isTerminalStatus(review)) {
    appendLog(logFile, `Review is already ${review.status}; worker exiting without claiming it.`);
    return;
  }

  // From here on the review record exists and is non-terminal, so every exit
  // path must leave it in a terminal state. Register it with the
  // terminal-state machinery.
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

  const reviewsDir = resolveReviewsDir(workspaceRoot);
  const outputFile = path.join(reviewsDir, `${reviewId}.output.txt`);
  const timeoutMs = resolveReviewTimeoutMs({ timeoutMs: request.timeoutMs });

  // F1: resolve the reviewer backend. A missing/unknown `request.backend` — as
  // on an old queued record from before F1 — resolves to the default
  // (`exec-generic`), so the migration is non-breaking.
  const backend = getReviewerBackend(request.backend);
  const runCwd = request.cwd ?? cwd;

  appendLog(
    logFile,
    `Starting ${review.kind} review with backend=${backend.id} model=${request.model} effort=${request.effort} timeoutMs=${timeoutMs}.`
  );
  // Claim the review as `running` only if it has NOT been reconciled to a
  // terminal state in the meantime (compare-and-set). If the claim is rejected,
  // a cleanup already finished this review — abort without running the backend.
  //
  // The worker records ITS OWN pid here, in the SAME compare-and-set that marks
  // the review `running`. The dispatcher also patches the pid after spawn(),
  // but there is a window between the worker claiming `running` and that parent
  // patch landing; without this self-write, a SessionEnd hook firing in that
  // window would see a running review with no pid and be unable to kill it.
  const claim = updateReviewIf(
    workspaceRoot,
    reviewId,
    (current) => !isTerminalStatus(current),
    { status: "running", pid: process.pid }
  );
  if (!claim.applied) {
    appendLog(logFile, "Review was finalized before this worker could claim it; aborting.");
    // Mark settled so the finally-backstop does not try to fail it — the
    // existing terminal state is authoritative.
    terminalState.settled = true;
    return;
  }

  // COUPLING POINT 1 (was getCodexAvailability) — the backend's availability
  // probe. Time-boxed and non-throwing by the backend contract.
  const availability = backend.probe({ cwd: runCwd, env: process.env, backendConfig: request.backendConfig });
  if (!availability.available) {
    const detail = availability.detail ? ` (${availability.detail})` : "";
    appendLog(logFile, `Reviewer backend "${backend.id}" unavailable${detail}.`);
    settleTerminal("failed", {
      backend: backend.id,
      errorMessage: `Reviewer backend "${backend.id}" is not available${detail}.`
    });
    process.exitCode = 1;
    return;
  }

  // F6: resolve a project-level pricing override for the run's model, if any.
  const rateOverride = request.model
    ? normalizeRateOverride(getPricingOverride(workspaceRoot, request.model))
    : null;

  // COUPLING POINT 2 (was runCodexReview) — invoke the backend to completion
  // under its hard wall-clock timeout. The backend contract forbids throwing;
  // the try/catch is a belt-and-braces backstop.
  let raw;
  try {
    raw = await backend.run({
      cwd: runCwd,
      prompt: request.prompt,
      kind: review.kind,
      profile: request.profile ?? (review.kind === "plan" ? "plan-devils-advocate" : "generic-code"),
      base: request.base ?? null,
      outputFile,
      schemaFile: request.schemaFile ?? null,
      timeoutMs,
      model: request.model ?? null,
      effort: request.effort ?? null,
      env: process.env,
      rateOverride,
      backendConfig: request.backendConfig ?? {},
      // Track the review child pid so the signal handlers can reap its process
      // tree if this worker is killed mid-run.
      onChild: (pid) => {
        terminalState.codexChildPid = pid ?? null;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(logFile, `backend "${backend.id}" run threw: ${message}`);
    settleTerminal("failed", {
      backend: backend.id,
      errorMessage: `Reviewer backend "${backend.id}" failed: ${message}`
    });
    process.exitCode = 1;
    return;
  }

  // A hard timeout fired: the review process tree was killed. This is terminal
  // — never leave the review `running` just because the backend hung.
  if (raw.timedOut) {
    const seconds = Math.round((raw.timeoutMs ?? timeoutMs) / 1000);
    const detail = `reviewer backend "${backend.id}" timed out after ${seconds}s and was killed`;
    appendLog(logFile, detail);
    settleTerminal("failed", {
      backend: backend.id,
      output: null,
      errorMessage: detail
    });
    process.exitCode = 1;
    return;
  }

  // COUPLING POINT 3 (was extractVerdictLine + output-file read) — turn the
  // raw result into the structured ParsedReview. Non-throwing by contract.
  const parsed = backend.parse(raw, {
    cwd: runCwd,
    kind: review.kind,
    profile: request.profile ?? (review.kind === "plan" ? "plan-devils-advocate" : "generic-code"),
    model: request.model ?? null,
    schemaFile: request.schemaFile ?? null,
    rateOverride
  });

  if (!parsed.ok || !parsed.output) {
    const detail = parsed.errorMessage || `backend "${backend.id}" produced no verdict`;
    appendLog(logFile, `Review failed: ${detail}`);
    settleTerminal("failed", {
      backend: backend.id,
      output: null,
      errorMessage: detail
    });
    process.exitCode = raw.status === 0 ? 1 : raw.status || 1;
    return;
  }

  // F3/F4: stale detection — recompute the anchoring fingerprint and compare
  // to the value captured at dispatch. A working tree that moved under the
  // review is not an error; the result is just recorded with the recomputed
  // hash so a later consumer (Phase 2) can detect the drift.
  const reviewedInputHash =
    (parsed.result && parsed.result.reviewedInputHash) ||
    (request && typeof request.reviewedInputHash === "string"
      ? request.reviewedInputHash
      : null);

  // F3: flatten this review's unverified-claim gaps into the accumulator.
  if (parsed.result && Array.isArray(parsed.result.unverified) && parsed.result.unverified.length > 0) {
    try {
      appendReviewGaps(workspaceRoot, {
        reviewId,
        kind: review.kind,
        gaps: parsed.result.unverified
      });
    } catch {
      // The gap accumulator is best-effort — never let it block settling.
    }
  }

  appendLog(
    logFile,
    `Review completed (backend=${backend.id}${parsed.degraded ? ", degraded" : ""}). Verdict: ${parsed.verdict ?? "(none)"}`
  );
  settleTerminal("completed", {
    verdict: parsed.verdict,
    output: parsed.output,
    result: parsed.result,
    reviewedInputHash,
    backend: backend.id,
    degraded: parsed.degraded,
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
