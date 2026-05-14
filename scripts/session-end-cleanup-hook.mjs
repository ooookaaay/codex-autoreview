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

import { spawnSync } from "node:child_process";
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
 * Read a process's command line by pid, or `null` if it cannot be determined.
 *
 * Uses `/proc/<pid>/cmdline` on Linux and `ps -p <pid> -o command=` elsewhere
 * (macOS / other Unix). Returning `null` means "could not verify" — the caller
 * MUST NOT kill in that case, to avoid signalling an unrelated process that has
 * reused the pid.
 *
 * @param {number} pid
 * @returns {string | null}
 */
function readProcessCommand(pid) {
  // Linux: /proc is authoritative and cheap.
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (cmdline) {
      // /proc/<pid>/cmdline is NUL-separated.
      return cmdline.split("\0").join(" ").trim();
    }
  } catch {
    // Not Linux, or the process is gone — fall through to `ps`.
  }
  // Other platforms: ask `ps`. If `ps` is unavailable or the pid is gone,
  // there is no command to return, so the caller treats it as unverifiable.
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 3000
    });
    if (result.status === 0) {
      const command = (result.stdout ?? "").trim();
      return command || null;
    }
  } catch {
    // `ps` not available — unverifiable.
  }
  return null;
}

/**
 * Verify a pid is genuinely THIS codex-autoreview review worker before we
 * signal it — guarding against pid reuse (a stale pid in state now belonging to
 * an unrelated process). Requires the command line to contain BOTH
 * `review-worker.mjs` AND this review's `--review-id`. If the command line
 * cannot be determined at all, returns `false` (skip the kill) rather than
 * guessing — an un-killed worker is reconciled in state anyway, but signalling
 * the wrong process would be unsafe.
 *
 * @param {number} pid
 * @param {string} reviewId
 * @returns {boolean}
 */
function looksLikeReviewWorker(pid, reviewId) {
  const command = readProcessCommand(pid);
  if (!command) {
    return false;
  }
  return command.includes("review-worker.mjs") && command.includes(reviewId);
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
    if (!pid || !looksLikeReviewWorker(pid, review.id)) {
      // Either no pid recorded, the process is gone, or it could not be
      // positively verified as this review's worker — skip the kill. The
      // review is still reconciled to a terminal state below regardless.
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
 * Remove the per-review log/output files for the reviews that were EXPLICITLY
 * pruned from state by `reconcileAndPruneReviews` (terminal reviews only — see
 * that function). Files are removed strictly by the pruned-id allowlist, never
 * by "anything not in current state": that broader rule would delete files
 * belonging to another active session's still-running review. Only files
 * inside the plugin's own reviews directory are ever touched.
 *
 * @param {string} workspaceRoot
 * @param {string[]} prunedReviewIds
 * @returns {number} count of files removed
 */
function removePrunedReviewFiles(workspaceRoot, prunedReviewIds) {
  if (prunedReviewIds.length === 0) {
    return 0;
  }
  const reviewsDir = resolveReviewsDir(workspaceRoot);
  let removed = 0;
  for (const reviewId of prunedReviewIds) {
    for (const suffix of [".log", ".output.txt"]) {
      const file = path.join(reviewsDir, `${reviewId}${suffix}`);
      try {
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      } catch {
        // Best-effort; ignore.
      }
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
  //    Pruning only ever removes TERMINAL reviews; another active session's
  //    queued/running review is always kept.
  const { reconciled, pruned, kept, prunedIds } = reconcileAndPruneReviews(workspaceRoot, {
    sessionId
  });

  // 3. Drop log/output files ONLY for the reviews that were explicitly pruned
  //    above — never for "anything not in current state", which would clobber
  //    another active session's still-running review files.
  const filesRemoved = removePrunedReviewFiles(workspaceRoot, prunedIds);

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
