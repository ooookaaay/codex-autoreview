/**
 * Background review dispatch.
 *
 * A hook calls `dispatchBackgroundReview`, which records a `queued` review,
 * spawns the detached `review-worker.mjs`, and returns immediately. The worker
 * assembles the review prompt and runs the configured reviewer backend to
 * completion, then updates the review record with the verdict. The main Claude
 * session is never blocked.
 *
 * PHASE 2 / WAVE A1 changes:
 *   - The dispatcher no longer persists a full rendered prompt in state. It
 *     records only review METADATA plus the minimal, redactable runtime payload
 *     the worker needs (`planText` for a plan review, `claudeResponseBlock` for
 *     a code review). The worker assembles the actual prompt itself (via the
 *     `assembleReviewPrompt` seam) and redacts the runtime payload as soon as it
 *     has read it — so sensitive prompt text never lingers in persisted state.
 *   - At dispatch the anchoring fingerprint (F4 `computeDiffFingerprint` /
 *     `computePlanHash`) is captured into the record, and an identical
 *     pending/recent review is DEDUPED: a new dispatch is skipped when an
 *     equivalent review (same `kind` + `reviewedInputHash` + `backend`) is
 *     already `queued`/`running`, or completed within {@link DEDUPE_WINDOW_MS}.
 *
 * This file is original to codex-autoreview; the fire-and-forget contract
 * mirrors codex-plugin-cc's `lib/auto-review.mjs`.
 *
 * @file
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  resolveEffectiveReviewModel,
  resolveReviewEffort,
  resolveReviewTimeoutMs,
  spawnDetached
} from "./codex.mjs";
import { computeDiffFingerprint, computePlanHash } from "./git.mjs";
import { DEFAULT_BACKEND_ID, isKnownBackend } from "./reviewers/index.mjs";
import {
  generateReviewId,
  healStuckReviews,
  listReviews,
  resolveReviewLogFile,
  updateReviewIf,
  upsertReview
} from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(LIB_DIR, "..");
const WORKER_SCRIPT = path.join(SCRIPTS_DIR, "review-worker.mjs");

/** Claude session id env var the worker reads to scope reviews to a session. */
export const SESSION_ID_ENV = "CODEX_AUTOREVIEW_SESSION_ID";

/**
 * How recently a COMPLETED review with the same dedupe key suppresses a fresh
 * dispatch. A queued/running equivalent always suppresses; a completed one only
 * does so within this window, so a later edit-then-re-review still works once
 * the window lapses. 10 minutes (consulted `codex`: short TTL that stops
 * hook-chatter from re-burning quota on the exact same input, while still
 * letting a genuine later re-review through).
 */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Build the stable dedupe key for a review. Two reviews collide only when they
 * target the SAME input (`reviewedInputHash`) of the SAME `kind` via the SAME
 * reviewer `backend` — a different backend may legitimately produce a different
 * verdict for the identical input, so it is part of the key.
 *
 * The anchoring hash is read from BOTH lifecycle locations: a fresh
 * `queued`/`running` record carries it under `request.reviewedInputHash`, while
 * a settled record also has a top-level `reviewedInputHash` recomputed by the
 * worker. The dispatch-time value is preferred since that is what a fresh
 * dispatch is keyed against. The `backend` is read the same way.
 *
 * Returns `null` when there is no anchoring hash to key on (a non-git tree, or
 * a plan with no text): such a review can never be confidently deduped, so it
 * always dispatches.
 *
 * @param {{ kind?: unknown, reviewedInputHash?: unknown, backend?: unknown, request?: unknown }} review
 * @returns {string | null}
 */
function dedupeKeyOf(review) {
  if (!review || typeof review !== "object") {
    return null;
  }
  const request =
    review.request && typeof review.request === "object"
      ? /** @type {Record<string, unknown>} */ (review.request)
      : {};
  const hash =
    (typeof request.reviewedInputHash === "string" && request.reviewedInputHash) ||
    (typeof review.reviewedInputHash === "string" && review.reviewedInputHash) ||
    null;
  if (!hash) {
    return null;
  }
  const kind = review.kind === "plan" ? "plan" : "code";
  const backend =
    (typeof review.backend === "string" && review.backend) ||
    (typeof request.backend === "string" && request.backend) ||
    DEFAULT_BACKEND_ID;
  return `${kind} ${backend} ${hash}`;
}

/**
 * Decide whether a fresh review keyed by `key` is a duplicate of one already in
 * the state ring buffer. A review is a duplicate when an existing record shares
 * its dedupe key AND is either still in flight (`queued`/`running`) or completed
 * within {@link DEDUPE_WINDOW_MS}. `failed` reviews — and reviews whose verdict
 * came back `STALE` — never suppress a re-dispatch (a failed/stale review
 * produced no usable verdict, so re-reviewing is correct, not wasteful).
 *
 * @param {import("./state.mjs").ReviewRecord[]} reviews
 * @param {string} key - The dedupe key of the review about to be dispatched.
 * @param {{ now?: number }} [options]
 * @returns {import("./state.mjs").ReviewRecord | null} the suppressing review, or null
 */
export function findDuplicateReview(reviews, key, options = {}) {
  if (!key || !Array.isArray(reviews)) {
    return null;
  }
  const now = options.now ?? Date.now();
  for (const review of reviews) {
    if (!review || dedupeKeyOf(review) !== key) {
      continue;
    }
    if (review.status === "queued" || review.status === "running") {
      return review;
    }
    if (review.status === "completed") {
      // A completed-but-STALE review carries no fresh verdict for the current
      // input — let a re-dispatch through.
      const verdict = typeof review.verdict === "string" ? review.verdict : "";
      if (/^STALE\b/i.test(verdict.trim())) {
        continue;
      }
      const updatedAt = Date.parse(String(review.updatedAt ?? ""));
      if (Number.isFinite(updatedAt) && now - updatedAt <= DEDUPE_WINDOW_MS) {
        return review;
      }
    }
  }
  return null;
}

/**
 * Dispatch a Codex review as a detached background job.
 *
 * Never waits for the verdict. The calling hook returns immediately so the main
 * Claude session stays unblocked; the verdict surfaces later through the
 * `/codex-autoreview:last` command and the statusline.
 *
 * The dispatcher records only review METADATA and the minimal, redactable
 * runtime payload — it does NOT persist a fully rendered prompt. The detached
 * worker assembles the prompt itself and redacts the runtime payload as soon as
 * it has read it.
 *
 * @param {object} params
 * @param {string} params.cwd - Working directory for the Codex run.
 * @param {"plan" | "code"} params.kind - Which review this is.
 * @param {{ model?: unknown, effort?: unknown, timeoutMs?: unknown, backend?: unknown, backendConfig?: unknown }} params.config
 * @param {string | null} [params.sessionId] - Claude session id, if known.
 * @param {string} [params.profile] - Review profile id (F2). Defaults per kind.
 * @param {string} [params.planText] - The plan text, for `kind === "plan"` —
 *   the runtime payload the worker feeds into the assembled plan prompt, and
 *   the source of the F4 `planHash` anchor.
 * @param {string} [params.claudeResponseBlock] - The builder's final message,
 *   for `kind === "code"` — the runtime payload the worker feeds into the
 *   assembled code prompt as a claim to verify.
 * @param {string} [params.projectInstructionsPath] - Abs path to the project's
 *   `.codex-autoreview.md`, when one exists — passed through to the prompt
 *   assembler.
 * @param {string} [params.trigger] - What triggered the dispatch (`stop`,
 *   `exit-plan-mode`, `pre-push`, …). Recorded on the request for diagnostics.
 * @param {(command: string, args: string[], options: object) => { pid: number | null }} [params.spawn]
 *   - Injectable detached-spawn function (defaults to `spawnDetached`), for tests.
 * @returns {{ dispatched: boolean, reviewId: string | null, detail: string | null, deduped?: boolean }}
 */
export function dispatchBackgroundReview(params) {
  const { cwd, kind, config = {} } = params;
  const spawn = params.spawn ?? spawnDetached;
  const sessionId = params.sessionId ?? process.env[SESSION_ID_ENV] ?? null;

  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // Opportunistic self-heal: before dispatching a new review, reconcile any
  // likely-stuck review (a previous worker SIGKILL'd / OOM-killed before it
  // could flush a terminal state) to `failed`. Cheap no-op when nothing is
  // stuck — keeps state honest even on projects where SessionEnd never fires.
  try {
    healStuckReviews(workspaceRoot);
  } catch {
    // Self-heal is best-effort — never let it block a dispatch.
  }

  // F1: resolve the reviewer backend from config; an unknown id falls back to
  // the non-breaking default (today's `exec-generic` behavior).
  const backend = isKnownBackend(config.backend) ? config.backend : DEFAULT_BACKEND_ID;
  const backendConfig =
    config.backendConfig && typeof config.backendConfig === "object"
      ? config.backendConfig
      : null;
  // F5/C: resolve the EFFECTIVE model — the plugin override, else the user's
  // own `~/.codex/config.toml` default (re-supplied explicitly because the
  // hardened `codex exec` invocation passes `--ignore-user-config`).
  const model = resolveEffectiveReviewModel(config);
  const effort = resolveReviewEffort(config);
  const timeoutMs = resolveReviewTimeoutMs(config);
  const profile =
    typeof params.profile === "string" && params.profile
      ? params.profile
      : kind === "plan"
        ? "plan-devils-advocate"
        : "generic-code";

  // F4: capture the anchoring fingerprint at dispatch time so the worker can
  // detect a working tree / plan that moved under the review. Best-effort —
  // a non-git tree just has no code fingerprint.
  let reviewedInputHash = null;
  try {
    if (kind === "plan") {
      const planText = typeof params.planText === "string" ? params.planText : "";
      reviewedInputHash = planText ? computePlanHash(planText) : null;
    } else {
      const fingerprint = computeDiffFingerprint(cwd);
      reviewedInputHash = fingerprint.available ? fingerprint.fingerprint : null;
    }
  } catch {
    reviewedInputHash = null;
  }

  // Phase 2 / Wave A1 — DEDUPE: skip the dispatch when an equivalent review is
  // already pending, or completed recently. Only meaningful when we have an
  // anchoring hash to key on; a non-git / no-text review always dispatches.
  const dedupeKey = dedupeKeyOf({ kind, reviewedInputHash, backend });
  if (dedupeKey) {
    const existing = findDuplicateReview(listReviews(workspaceRoot), dedupeKey);
    if (existing) {
      return {
        dispatched: false,
        reviewId: existing.id,
        deduped: true,
        detail: `An equivalent ${kind} review (${existing.id}, ${existing.status}) already covers this exact input.`
      };
    }
  }

  const reviewId = generateReviewId(kind === "plan" ? "plan" : "code");
  const logFile = resolveReviewLogFile(workspaceRoot, reviewId);

  // The minimal, redactable runtime payload the worker needs to assemble the
  // prompt. The worker deletes these fields from state as soon as it has read
  // them, so sensitive prompt text never lingers in persisted state.
  const planText =
    kind === "plan" && typeof params.planText === "string" && params.planText.trim()
      ? params.planText
      : null;
  const claudeResponseBlock =
    kind === "code" &&
    typeof params.claudeResponseBlock === "string" &&
    params.claudeResponseBlock.trim()
      ? params.claudeResponseBlock
      : null;
  const projectInstructionsPath =
    typeof params.projectInstructionsPath === "string" && params.projectInstructionsPath
      ? params.projectInstructionsPath
      : null;
  const trigger =
    typeof params.trigger === "string" && params.trigger ? params.trigger : null;

  // Persist the queued record before spawning so the worker has everything it
  // needs and the review is visible immediately. NOTE: no fully-rendered
  // `prompt` is stored — only metadata and the redactable runtime payload.
  upsertReview(workspaceRoot, {
    id: reviewId,
    kind,
    status: "queued",
    verdict: null,
    output: null,
    errorMessage: null,
    logFile,
    backend,
    request: {
      cwd,
      model,
      effort,
      timeoutMs,
      backend,
      profile,
      ...(backendConfig ? { backendConfig } : {}),
      ...(reviewedInputHash ? { reviewedInputHash } : {}),
      ...(projectInstructionsPath ? { projectInstructionsPath } : {}),
      ...(trigger ? { trigger } : {}),
      ...(sessionId ? { sessionId } : {}),
      // Redactable runtime payload — the worker strips these once it has them.
      ...(planText ? { planText } : {}),
      ...(claudeResponseBlock ? { claudeResponseBlock } : {})
    }
  });

  const childEnv = {
    ...process.env,
    ...(sessionId ? { [SESSION_ID_ENV]: sessionId } : {})
  };

  try {
    const { pid } = spawn(
      process.execPath,
      [WORKER_SCRIPT, "--cwd", cwd, "--review-id", reviewId],
      { cwd, env: childEnv }
    );
    // Attach the worker pid so SessionEnd cleanup can find and kill the process
    // tree. By the time this runs the detached worker may already have advanced
    // the status; the conditional patch is a compare-and-set that:
    //   - still applies while the review is `queued` OR `running` (the worker
    //     racing ahead to `running` must NOT cause the pid to be dropped — that
    //     would leave the worker un-killable);
    //   - never touches a `completed`/`failed` review (cannot roll it back);
    //   - never overwrites a pid the worker may already have recorded.
    updateReviewIf(
      workspaceRoot,
      reviewId,
      (review) =>
        (review.status === "queued" || review.status === "running") && !review.pid,
      { pid: pid ?? null }
    );
    return { dispatched: true, reviewId, detail: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    upsertReview(workspaceRoot, {
      id: reviewId,
      status: "failed",
      errorMessage: `Failed to dispatch background review: ${detail}`
    });
    return { dispatched: false, reviewId, detail };
  }
}
