#!/usr/bin/env node
/**
 * SessionEnd hook.
 *
 * Cleans up the plugin's OWN transient artifacts when a Claude Code session
 * ends or is cleared, so codex-autoreview never leaks processes or files:
 *
 *   1. Kills orphaned detached `review-worker.mjs` processes that this session
 *      started — identified by the `pid` recorded on each review whose request
 *      carries this `sessionId`, and verified to still be a review-worker
 *      before signalling. Never kills review-workers from other sessions.
 *   2. Reconciles this session's still-in-flight reviews (`queued`/`running`)
 *      to a terminal `failed` state, and prunes old review records by age and
 *      count — always keeping the most recent few so `/codex-autoreview:last`
 *      still works after a clear.
 *   3. Removes this session's own stale per-review log/output files.
 *
 * SAFETY: this hook only ever touches the plugin's own per-project state
 * directory. It never reads, writes, or deletes anything under `~/.codex` —
 * the user's Codex config, auth, and history are explicitly out of scope.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { SESSION_ID_ENV } from "./lib/auto-review.mjs";
import {
  listReviews,
  reconcileAndPruneReviews,
  resolveReviewsDir
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/**
 * @returns {Record<string, unknown>}
 */
function readHookInput() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @param {string} [message]
 */
function logNote(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

/**
 * Best-effort check that a pid is still a codex-autoreview review worker, so we
 * never signal an unrelated process that happens to have reused the pid. Uses
 * `/proc` on Linux; on other platforms it returns `true` (the pid came from our
 * own state, which is already a strong signal) so cleanup still proceeds.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function looksLikeReviewWorker(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("review-worker.mjs");
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ENOENT") {
      // No /proc entry: either not Linux, or the process is already gone.
      // Fall back to a liveness probe; if it is alive, trust our own state.
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Kill the detached workers this session started. A worker started detached
 * leads its own process group, so signalling `-pid` reaps the codex child too.
 *
 * @param {import("./lib/state.mjs").ReviewRecord[]} reviews
 * @param {string | null} sessionId
 * @returns {number} count of workers signalled
 */
function killSessionWorkers(reviews, sessionId) {
  let killed = 0;
  for (const review of reviews) {
    const request = review.request;
    const belongsToSession =
      sessionId && request && typeof request === "object" && request.sessionId === sessionId;
    if (!belongsToSession) {
      continue;
    }
    if (review.status !== "queued" && review.status !== "running") {
      continue;
    }
    const pid = typeof review.pid === "number" && review.pid > 0 ? review.pid : null;
    if (!pid || !looksLikeReviewWorker(pid)) {
      continue;
    }
    try {
      // Kill the whole process group (worker + its codex child).
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      killed += 1;
    } catch {
      // Already gone — nothing to do.
    }
  }
  return killed;
}

/**
 * Remove this session's own stale per-review log/output files for reviews that
 * are no longer in state (i.e. were just pruned). Only files inside the
 * plugin's own reviews directory are ever touched.
 *
 * @param {string} workspaceRoot
 * @param {Set<string>} survivingReviewIds
 * @returns {number} count of files removed
 */
function pruneOrphanReviewFiles(workspaceRoot, survivingReviewIds) {
  const reviewsDir = resolveReviewsDir(workspaceRoot);
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(reviewsDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    // Files are named "<reviewId>.log" / "<reviewId>.output.txt". Keep anything
    // belonging to a review still in state; drop the rest.
    const match = entry.match(/^(.+?)\.(log|output\.txt)$/);
    if (!match) {
      continue;
    }
    if (survivingReviewIds.has(match[1])) {
      continue;
    }
    try {
      fs.rmSync(path.join(reviewsDir, entry), { force: true });
      removed += 1;
    } catch {
      // Best-effort; ignore.
    }
  }
  return removed;
}

function main() {
  const input = readHookInput();
  const cwd =
    (typeof input.cwd === "string" && input.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const sessionId =
    (typeof input.session_id === "string" && input.session_id) ||
    process.env[SESSION_ID_ENV] ||
    null;

  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // 1. Kill this session's orphaned detached workers (before reconciling state,
  //    so a worker cannot race us back to `running`).
  const reviewsBefore = listReviews(workspaceRoot);
  const killed = killSessionWorkers(reviewsBefore, sessionId);

  // 2. Reconcile this session's in-flight reviews to terminal + prune old ones.
  const { reconciled, pruned, kept } = reconcileAndPruneReviews(workspaceRoot, {
    sessionId
  });

  // 3. Drop log/output files for reviews that no longer exist in state.
  const survivingIds = new Set(listReviews(workspaceRoot).map((review) => review.id));
  const filesRemoved = pruneOrphanReviewFiles(workspaceRoot, survivingIds);

  logNote(
    `codex-autoreview: session cleanup — killed ${killed} worker(s), ` +
      `reconciled ${reconciled} in-flight review(s), pruned ${pruned} old record(s) ` +
      `(kept ${kept}), removed ${filesRemoved} stale file(s).`
  );
}

try {
  main();
} catch (error) {
  // A cleanup hook must never disrupt session shutdown — log and exit 0.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-autoreview: session cleanup skipped: ${message}\n`);
}
