#!/usr/bin/env node
/**
 * Detached background review worker.
 *
 * Spawned by `lib/auto-review.mjs` with `--cwd` and `--review-id`. Reads the
 * queued review record (which carries review METADATA + a minimal redactable
 * runtime payload — NOT a fully rendered prompt), ASSEMBLES the review prompt
 * itself, runs the configured REVIEWER BACKEND to completion, and writes the
 * verdict back into the per-project state. This process is detached from the
 * Claude session, so it is free to block for as long as the review takes — but
 * never forever.
 *
 * F1 — PLUGGABLE REVIEWER ABSTRACTION: the worker does not call codex directly.
 * It looks up `request.backend` in the reviewer registry and calls the
 * backend's three methods: `probe()` → `run()` → `parse()`.
 *
 * PHASE 2 / WAVE A1:
 *   - PROMPT ASSEMBLY: the worker assembles the review prompt via the
 *     `assembleReviewPrompt` seam (`lib/prompts.mjs`, owned by Wave C). Until
 *     that function lands, {@link assembleReviewPromptCompat} falls back to the
 *     bundled prompt templates — a dynamic-import + property check, so the
 *     worker keeps loading and tests stay green before Wave C merges.
 *   - PROMPT REDACTION: as soon as the worker has claimed `running` and read
 *     the redactable runtime payload (`planText` / `claudeResponseBlock`), it
 *     STRIPS those fields from the persisted request and stamps
 *     `request.promptRedacted` — sensitive prompt text never lingers in state.
 *   - PRE-RUN STALE DETECTION: right after claiming `running` the worker
 *     recomputes the anchoring fingerprint; if the working tree / plan moved
 *     under the review, it settles the review as a cheap terminal `STALE`
 *     WITHOUT spending a codex call on an obsolete input.
 *   - BOUNDED-AUTO-FEEDBACK SCAFFOLD: the `reviewMode` code path is laid in
 *     (`advisory` | `soft-gate` | `bounded-feedback`); the feature is OFF —
 *     the default `advisory` mode changes nothing.
 *
 * HANG PROTECTION / TERMINAL-STATE GUARANTEE (UNCHANGED):
 *   - `backend.run` enforces a hard wall-clock timeout and kills the review
 *     process tree if it hangs (the exec-* backends reuse `runCodexReview`).
 *   - Every exit path here — backend unavailable, spawn error, crash, non-zero
 *     exit, killed by signal, timeout, malformed output, state-write error,
 *     pre-run stale, or this worker itself being killed (SIGTERM/SIGINT) —
 *     funnels through `settleTerminal`, so a review can never be left stuck in
 *     `running`.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { killProcessTree, resolveReviewTimeoutMs } from "./lib/codex.mjs";
import { computeDiffFingerprint, computePlanHash } from "./lib/git.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
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

const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(WORKER_DIR, "..");

/**
 * Review modes (Phase 2 bounded-auto-feedback SCAFFOLD). The code path is laid
 * in here but the feature is OFF: the default `advisory` mode is the only
 * behavior that does anything today.
 *   - `advisory` — DEFAULT. The review is purely informational; the verdict is
 *     recorded and surfaced, nothing is gated or auto-corrected.
 *   - `soft-gate` — RESERVED. A blocking-style plan/code gate (the verdict is
 *     surfaced more assertively); not wired in Wave A1.
 *   - `bounded-feedback` — RESERVED. A bounded auto-correction loop driven by
 *     `maxFeedbackLoops`; not wired in Wave A1. Enabling it is an explicit
 *     owner decision — see `docs/IMPLEMENTATION-PLAN.md` §6 / §10.
 * @type {readonly ["advisory", "soft-gate", "bounded-feedback"]}
 */
export const REVIEW_MODES = Object.freeze(["advisory", "soft-gate", "bounded-feedback"]);

/** The default review mode — the feature is OFF; nothing is gated. */
export const DEFAULT_REVIEW_MODE = "advisory";

/** Default bound on the bounded-feedback loop, when that mode is ever enabled. */
export const DEFAULT_MAX_FEEDBACK_LOOPS = 1;

/**
 * Normalize a requested review mode to a known {@link REVIEW_MODES} value,
 * defaulting to {@link DEFAULT_REVIEW_MODE}. Part of the bounded-auto-feedback
 * SCAFFOLD — the worker resolves the mode but, in Wave A1, only the default
 * `advisory` path is wired.
 *
 * @param {unknown} mode
 * @returns {"advisory" | "soft-gate" | "bounded-feedback"}
 */
export function resolveReviewMode(mode) {
  const raw = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  return REVIEW_MODES.includes(/** @type {any} */ (raw))
    ? /** @type {any} */ (raw)
    : DEFAULT_REVIEW_MODE;
}

/**
 * Normalize the bounded-feedback loop bound to a non-negative integer,
 * defaulting to {@link DEFAULT_MAX_FEEDBACK_LOOPS}. SCAFFOLD only — nothing in
 * Wave A1 consumes the value beyond recording it.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function resolveMaxFeedbackLoops(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return DEFAULT_MAX_FEEDBACK_LOOPS;
}

/**
 * Assemble the review prompt.
 *
 * The forward seam is `assembleReviewPrompt({ kind, profile, cwd,
 * projectInstructionsPath })` in `lib/prompts.mjs` — owned by Wave C, and not
 * yet present. This adapter dynamic-imports `prompts.mjs` and uses the real
 * `assembleReviewPrompt` WHEN it exists; until then it falls back to the
 * bundled prompt templates so the worker keeps loading and tests stay green.
 * The dynamic import + property check is deliberate: a static named import of
 * a not-yet-exported symbol would fail module loading outright.
 *
 * @param {object} args
 * @param {"plan" | "code"} args.kind
 * @param {string | null} [args.profile]
 * @param {string} args.cwd
 * @param {string | null} [args.projectInstructionsPath]
 * @returns {Promise<string>} the assembled prompt TEMPLATE (runtime slots like
 *   `{{PLAN_BLOCK}}` are interpolated by the caller)
 */
export async function assembleReviewPromptCompat(args) {
  const prompts = await import("./lib/prompts.mjs");
  if (typeof prompts.assembleReviewPrompt === "function") {
    return prompts.assembleReviewPrompt({
      kind: args.kind,
      profile: args.profile ?? null,
      cwd: args.cwd,
      projectInstructionsPath: args.projectInstructionsPath ?? undefined
    });
  }
  // Pre-Wave-C fallback: the bundled prompt templates, unchanged behavior.
  const templateName = args.kind === "plan" ? "auto-plan-review" : "auto-code-review";
  return loadPromptTemplate(PLUGIN_ROOT, templateName);
}

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
 * Recompute the anchoring fingerprint of the CURRENT working tree / plan, for
 * the PRE-RUN stale check. For a code review this is the F4 diff fingerprint of
 * the live working tree; for a plan review there is no live source to re-hash
 * (the plan text is the redactable runtime payload, which may already be in
 * hand here), so the plan's hash is recomputed from `planText` when available.
 *
 * Returns `null` when there is nothing to anchor (a non-git tree, or a plan
 * with no recoverable text) — the caller then SKIPS the pre-run stale check and
 * relies on the worker's existing post-run detection instead.
 *
 * @param {"plan" | "code"} kind
 * @param {string} cwd
 * @param {string | null} planText
 * @returns {string | null}
 */
function recomputeAnchorHash(kind, cwd, planText) {
  try {
    if (kind === "plan") {
      return typeof planText === "string" && planText.trim()
        ? computePlanHash(planText)
        : null;
    }
    const fingerprint = computeDiffFingerprint(cwd);
    return fingerprint.available ? fingerprint.fingerprint : null;
  } catch {
    return null;
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
  if (!request || typeof request !== "object") {
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
  const profile =
    typeof request.profile === "string" && request.profile
      ? request.profile
      : review.kind === "plan"
        ? "plan-devils-advocate"
        : "generic-code";

  // Phase 2 bounded-auto-feedback SCAFFOLD: resolve the mode + loop bound. The
  // feature is OFF — `advisory` is the only wired path; the values are resolved
  // (and below, recorded) so the code path exists for a future owner decision.
  const reviewMode = resolveReviewMode(request.reviewMode);
  const maxFeedbackLoops = resolveMaxFeedbackLoops(request.maxFeedbackLoops);

  appendLog(
    logFile,
    `Starting ${review.kind} review with backend=${backend.id} profile=${profile} mode=${reviewMode} model=${request.model} effort=${request.effort} timeoutMs=${timeoutMs}.`
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

  // Read the redactable runtime payload INTO MEMORY, then immediately STRIP it
  // from persisted state. This worker is one-shot and never restarted, so once
  // the values are in hand there is no reason to keep sensitive prompt text on
  // disk. The strip is a compare-and-set on the still-`running` review.
  const planText = typeof request.planText === "string" ? request.planText : null;
  const claudeResponseBlock =
    typeof request.claudeResponseBlock === "string" ? request.claudeResponseBlock : null;
  // Legacy tolerance: an OLD queued record (or a test) may still carry a fully
  // rendered `request.prompt`. Read it as a last-resort prompt source, then
  // redact it alongside the runtime payload.
  const legacyPrompt = typeof request.prompt === "string" ? request.prompt : null;

  const hadPromptBearingFields = Boolean(planText || claudeResponseBlock || legacyPrompt);
  if (hadPromptBearingFields) {
    try {
      updateReviewIf(
        workspaceRoot,
        reviewId,
        (current) => !isTerminalStatus(current),
        {
          request: (() => {
            const sanitized = { ...request };
            delete sanitized.planText;
            delete sanitized.claudeResponseBlock;
            delete sanitized.prompt;
            sanitized.promptRedacted = true;
            sanitized.promptRedactedAt = new Date().toISOString();
            return sanitized;
          })()
        }
      );
      appendLog(logFile, "Redacted the prompt-bearing runtime payload from persisted state.");
    } catch (error) {
      // Redaction is best-effort: a failure here must not abort the review.
      const message = error instanceof Error ? error.message : String(error);
      appendLog(logFile, `Prompt redaction failed (continuing): ${message}`);
    }
  }

  // PRE-RUN STALE DETECTION: recompute the anchoring fingerprint now, before
  // spending a codex call. If the working tree / plan moved under the review
  // since dispatch, the review's target input is already gone — settle a cheap
  // terminal `STALE` instead of reviewing an obsolete diff/plan.
  const dispatchHash =
    typeof request.reviewedInputHash === "string" && request.reviewedInputHash
      ? request.reviewedInputHash
      : null;
  if (dispatchHash) {
    const currentHash = recomputeAnchorHash(review.kind, runCwd, planText);
    if (currentHash && currentHash !== dispatchHash) {
      appendLog(
        logFile,
        `Pre-run stale: anchor moved (${dispatchHash} → ${currentHash}); settling STALE without a codex call.`
      );
      settleTerminal("completed", {
        backend: backend.id,
        verdict: "STALE: the working tree changed before the review could start.",
        output:
          "STALE: the working tree changed before the review could start. " +
          "No review was run — re-trigger one against the current changes.",
        reviewedInputHash: currentHash,
        degraded: false,
        errorMessage: null
      });
      return;
    }
  }

  // COUPLING POINT 1 (was getCodexAvailability) — the backend's availability
  // probe. Time-boxed and non-throwing by the backend contract.
  const availability = backend.probe({
    cwd: runCwd,
    env: process.env,
    backendConfig: request.backendConfig
  });
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

  // Assemble the review prompt. The worker — not the hook — owns prompt
  // assembly now: the dispatcher persists only metadata + the redactable
  // runtime payload, never a rendered prompt.
  let prompt;
  try {
    const template = await assembleReviewPromptCompat({
      kind: review.kind,
      profile,
      cwd: runCwd,
      projectInstructionsPath: request.projectInstructionsPath ?? null
    });
    // Interpolate the runtime slots the bundled templates expect. When Wave C's
    // `assembleReviewPrompt` returns a template with no such slots these are
    // simply no-ops; when it returns one that still has them, they are filled.
    const claudeResponseSlot = claudeResponseBlock
      ? ["Context from Claude's previous response:", claudeResponseBlock].join("\n")
      : "";
    prompt = interpolateTemplate(template, {
      PLAN_BLOCK: planText ?? "",
      CLAUDE_RESPONSE_BLOCK: claudeResponseSlot,
      REVIEWED_INPUT_HASH: dispatchHash ?? ""
    });
    // Legacy queued records carried a fully rendered prompt — honor it when the
    // metadata path produced nothing usable.
    if (!prompt.trim() && legacyPrompt) {
      prompt = legacyPrompt;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (legacyPrompt) {
      // A legacy record still has a usable prompt — fall back to it rather than
      // failing the review on an assembly error.
      appendLog(logFile, `Prompt assembly failed (${message}); using the legacy request prompt.`);
      prompt = legacyPrompt;
    } else {
      appendLog(logFile, `Prompt assembly failed: ${message}`);
      settleTerminal("failed", {
        backend: backend.id,
        errorMessage: `Failed to assemble the review prompt: ${message}`
      });
      process.exitCode = 1;
      return;
    }
  }

  if (!prompt || !prompt.trim()) {
    appendLog(logFile, "Assembled review prompt was empty.");
    settleTerminal("failed", {
      backend: backend.id,
      errorMessage: "Assembled review prompt was empty."
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
      prompt,
      kind: review.kind,
      profile,
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
    profile,
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

  // F3/F4: post-run stale detection — recompute the anchoring fingerprint and
  // compare to the value captured at dispatch. A working tree that moved DURING
  // the backend run is not an error; the result is just recorded with the
  // recomputed hash so a later consumer (Phase 2) can detect the drift.
  const reviewedInputHash =
    (parsed.result && parsed.result.reviewedInputHash) || dispatchHash || null;

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

  // Bounded-auto-feedback SCAFFOLD: in `advisory` mode (the default, and the
  // only wired path) the verdict is recorded as-is and nothing is auto-
  // corrected. `soft-gate` / `bounded-feedback` would branch here in a future
  // phase; `maxFeedbackLoops` is carried through purely so the record is
  // self-describing for that work. The feature is OFF.
  appendLog(
    logFile,
    `Review completed (backend=${backend.id} mode=${reviewMode}${parsed.degraded ? ", degraded" : ""}). Verdict: ${parsed.verdict ?? "(none)"}`
  );
  settleTerminal("completed", {
    verdict: parsed.verdict,
    output: parsed.output,
    result: parsed.result,
    reviewedInputHash,
    backend: backend.id,
    degraded: parsed.degraded,
    reviewMode,
    maxFeedbackLoops,
    errorMessage: null
  });
}

/**
 * Whether this module is being run as a script (the detached worker) versus
 * merely imported (e.g. by tests that exercise the pure helpers above). The
 * worker has side effects — it claims a review, spawns codex, writes state — so
 * `main()` and the signal handlers MUST NOT fire on a bare `import`.
 *
 * @returns {boolean}
 */
function isRunAsEntrypoint() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isRunAsEntrypoint()) {
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
}
