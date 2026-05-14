/**
 * Background review dispatch.
 *
 * A hook calls `dispatchBackgroundReview`, which records a `queued` review,
 * spawns the detached `review-worker.mjs`, and returns immediately. The worker
 * runs `codex exec` to completion and updates the review record with the
 * verdict. The main Claude session is never blocked.
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
 * Dispatch a Codex review prompt as a detached background job.
 *
 * Never waits for the verdict. The calling hook returns immediately so the main
 * Claude session stays unblocked; the verdict surfaces later through the
 * `/codex-autoreview:last` command and the statusline.
 *
 * @param {object} params
 * @param {string} params.cwd - Working directory for the Codex run.
 * @param {"plan" | "code"} params.kind - Which review this is.
 * @param {string} params.prompt - The review prompt to hand to Codex.
 * @param {{ model?: unknown, effort?: unknown, timeoutMs?: unknown, backend?: unknown, backendConfig?: unknown }} params.config
 * @param {string | null} [params.sessionId] - Claude session id, if known.
 * @param {string} [params.profile] - Review profile id (F2). Defaults per kind.
 * @param {string} [params.planText] - The plan text, for `kind === "plan"` —
 *   used to compute the F4 `planHash` anchor.
 * @param {(command: string, args: string[], options: object) => { pid: number | null }} [params.spawn]
 *   - Injectable detached-spawn function (defaults to `spawnDetached`), for tests.
 * @returns {{ dispatched: boolean, reviewId: string | null, detail: string | null }}
 */
export function dispatchBackgroundReview(params) {
  const { cwd, kind, prompt, config = {} } = params;
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
  const reviewId = generateReviewId(kind === "plan" ? "plan" : "code");
  const logFile = resolveReviewLogFile(workspaceRoot, reviewId);

  // F4: capture the anchoring fingerprint at dispatch time so the worker can
  // detect a working tree / plan that moved under the review. Best-effort —
  // a non-git tree just has no code fingerprint.
  let reviewedInputHash = null;
  try {
    if (kind === "plan") {
      reviewedInputHash = computePlanHash(params.planText ?? prompt);
    } else {
      const fingerprint = computeDiffFingerprint(cwd);
      reviewedInputHash = fingerprint.available ? fingerprint.fingerprint : null;
    }
  } catch {
    reviewedInputHash = null;
  }

  // Persist the queued record and the prompt-bearing request before spawning so
  // the worker has everything it needs and the review is visible immediately.
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
      prompt,
      model,
      effort,
      timeoutMs,
      backend,
      profile,
      ...(backendConfig ? { backendConfig } : {}),
      ...(reviewedInputHash ? { reviewedInputHash } : {}),
      ...(sessionId ? { sessionId } : {})
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
