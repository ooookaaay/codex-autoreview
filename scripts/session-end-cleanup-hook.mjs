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
 * `includeTerminal` is for the SECOND kill pass: by then `reconcileAndPruneReviews`
 * has marked this session's in-flight reviews `failed`, but a worker that raced
 * in (recorded its pid + claimed `running` between the first snapshot and the
 * reconcile) is still alive. That pass must therefore also kill workers whose
 * review record is now `failed` — the pid + review-id verification still
 * guarantees only a genuine, matching review-worker is ever signalled.
 *
 * @param {import("./lib/state.mjs").ReviewRecord[]} reviews
 * @param {string | null} sessionId
 * @param {{ includeTerminal?: boolean, alreadyKilled?: Set<number> }} [options]
 * @returns {{ killed: number, killedPids: Set<number> }}
 */
function killSessionWorkers(reviews, sessionId, options = {}) {
  const includeTerminal = Boolean(options.includeTerminal);
  const alreadyKilled = options.alreadyKilled ?? new Set();
  const killedPids = new Set(alreadyKilled);
  let killed = 0;
  for (const review of reviews) {
    const request = review.request;
    const belongsToSession =
      sessionId && request && typeof request === "object" && request.sessionId === sessionId;
    if (!belongsToSession) {
      continue;
    }
    const inFlight = review.status === "queued" || review.status === "running";
    // First pass: in-flight only. Second pass: also `failed` (a raced worker
    // whose review was reconciled while it was still spinning up).
    if (!inFlight && !(includeTerminal && review.status === "failed")) {
      continue;
    }
    const pid = typeof review.pid === "number" && review.pid > 0 ? review.pid : null;
    if (!pid || killedPids.has(pid)) {
      continue;
    }
    if (!looksLikeReviewWorker(pid, review.id)) {
      // No verifiable matching review-worker at that pid — skip the kill. The
      // review is reconciled to a terminal state regardless.
      continue;
    }
    try {
      // Kill the whole process group (worker + its codex child).
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
      killedPids.add(pid);
      killed += 1;
    } catch {
      // Already gone — nothing to do.
    }
  }
  return { killed, killedPids };
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

  // 1. FIRST kill pass: kill this session's detached workers that are visible
  //    as in-flight right now.
  const reviewsBefore = listReviews(workspaceRoot);
  const firstPass = killSessionWorkers(reviewsBefore, sessionId);

  // 2. Reconcile this session's in-flight reviews to terminal + prune old ones.
  //    Pruning only ever removes TERMINAL reviews; another active session's
  //    queued/running review is always kept. It also self-heals any
  //    likely-stuck review (a SIGKILL'd/crashed worker) from any session.
  const { reconciled, healed, pruned, kept, prunedIds } = reconcileAndPruneReviews(
    workspaceRoot,
    { sessionId }
  );

  // 3. SECOND kill pass, AFTER reconcile: a worker can race in between the
  //    first snapshot and the reconcile — recording its pid and claiming
  //    `running` — so it is now marked `failed` in state but its process (and
  //    its codex child) is still alive. Re-read state and kill those too;
  //    `includeTerminal` lets this pass act on the just-reconciled `failed`
  //    records. pid + review-id verification still gates every signal.
  const reviewsAfter = listReviews(workspaceRoot);
  const secondPass = killSessionWorkers(reviewsAfter, sessionId, {
    includeTerminal: true,
    alreadyKilled: firstPass.killedPids
  });
  const killed = firstPass.killed + secondPass.killed;

  // 4. Drop log/output files ONLY for the reviews that were explicitly pruned
  //    above — never for "anything not in current state", which would clobber
  //    another active session's still-running review files.
  const filesRemoved = removePrunedReviewFiles(workspaceRoot, prunedIds);

  logNote(
    `codex-autoreview: session cleanup — killed ${killed} worker(s), ` +
      `reconciled ${reconciled} in-flight review(s), healed ${healed} stuck review(s), ` +
      `pruned ${pruned} old record(s) (kept ${kept}), removed ${filesRemoved} stale file(s).`
  );
}

try {
  main();
} catch (error) {
  // A cleanup hook must never disrupt session shutdown — log and exit 0.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-autoreview: session cleanup skipped: ${message}\n`);
}
