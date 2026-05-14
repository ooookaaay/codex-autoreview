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

import { resolveReviewEffort, resolveReviewModel, spawnDetached } from "./codex.mjs";
import { generateReviewId, resolveReviewLogFile, upsertReview } from "./state.mjs";
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
 * @param {{ model?: unknown, effort?: unknown }} params.config
 * @param {string | null} [params.sessionId] - Claude session id, if known.
 * @param {(command: string, args: string[], options: object) => { pid: number | null }} [params.spawn]
 *   - Injectable detached-spawn function (defaults to `spawnDetached`), for tests.
 * @returns {{ dispatched: boolean, reviewId: string | null, detail: string | null }}
 */
export function dispatchBackgroundReview(params) {
  const { cwd, kind, prompt, config = {} } = params;
  const spawn = params.spawn ?? spawnDetached;
  const sessionId = params.sessionId ?? process.env[SESSION_ID_ENV] ?? null;

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const model = resolveReviewModel(config);
  const effort = resolveReviewEffort(config);
  const reviewId = generateReviewId(kind === "plan" ? "plan" : "code");
  const logFile = resolveReviewLogFile(workspaceRoot, reviewId);

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
    request: {
      cwd,
      prompt,
      model,
      effort,
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
    upsertReview(workspaceRoot, { id: reviewId, status: "queued", pid: pid ?? null });
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
