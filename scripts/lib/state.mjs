/**
 * Per-project persisted state: the enable toggle, model/effort config, and a
 * small ring buffer of recent review verdicts.
 *
 * Adapted from codex-plugin-cc (plugins/codex/scripts/lib/state.mjs),
 * Copyright 2026 OpenAI, licensed under the Apache License, Version 2.0.
 * The job-tracking machinery of the original was dropped; this plugin only
 * needs config plus the last few verdicts. See ../../NOTICE.
 *
 * @file
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-autoreview");
const STATE_FILE_NAME = "state.json";
const REVIEWS_DIR_NAME = "reviews";
const MAX_REVIEWS = 20;
const LOCK_FILE_NAME = "state.json.lock";
/** Treat a lock older than this as stale (a crashed writer never released it). */
const LOCK_STALE_MS = 15_000;
/** How long to keep retrying to acquire the lock before giving up. */
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
/** Busy-wait granularity between lock acquisition attempts. */
const LOCK_RETRY_MS = 25;

/**
 * @typedef {object} AutoReviewConfig
 * @property {boolean} enabled - Whether the automatic reviews are turned on.
 * @property {string | null} model - Codex model override, or null for default.
 * @property {string | null} effort - Codex reasoning effort override, or null.
 * @property {number | null} timeoutMs - Hard per-review `codex exec` timeout in
 *   milliseconds, or null to use the built-in default.
 */

/**
 * A review still `running` longer than this is almost certainly stuck (its
 * worker was killed before it could flush a terminal state, or the host slept).
 * `last`/`config` surface such jobs as likely-stuck rather than healthy. This
 * is deliberately generous — comfortably past the longest legitimate review
 * plus the worker's own kill grace period.
 */
export const STALE_RUNNING_MS = 600_000;

/**
 * The two terminal review statuses. A review in either of these is final: no
 * later write may resurrect it (e.g. a worker that kept running after the
 * SessionEnd hook already reconciled its review to `failed`).
 */
export const TERMINAL_STATUSES = Object.freeze(["completed", "failed"]);

/**
 * @param {Pick<ReviewRecord, "status"> | null | undefined} review
 * @returns {boolean}
 */
export function isTerminalStatus(review) {
  return Boolean(review && TERMINAL_STATUSES.includes(review.status));
}

/**
 * @typedef {object} ReviewRecord
 * @property {string} id - Unique review/job id.
 * @property {"plan" | "code"} kind - Which hook produced the review.
 * @property {"queued" | "running" | "completed" | "failed"} status
 * @property {string | null} verdict - The first contract line (e.g. "SOUND: ...").
 * @property {string | null} output - The full Codex final message.
 * @property {string | null} errorMessage
 * @property {string} createdAt - ISO timestamp.
 * @property {string} updatedAt - ISO timestamp.
 * @property {string | null} logFile - Absolute path to the job log, if any.
 * @property {number | null} [pid] - Detached worker pid, when known.
 * @property {string | null} [surfacedAt] - ISO timestamp when the completed
 *   verdict was injected into a Claude session, or absent/null if not yet.
 * @property {object} [request] - The queued request payload (carries the
 *   prompt, model, effort, timeout, and the Claude `sessionId` when known).
 */

function nowIso() {
  return new Date().toISOString();
}

/**
 * @returns {{ version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }}
 */
function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      enabled: false,
      model: null,
      effort: null,
      timeoutMs: null
    },
    reviews: []
  };
}

/**
 * Resolve the per-workspace state directory. Uses `CLAUDE_PLUGIN_DATA` when
 * Claude Code provides it, otherwise a stable tmpdir location.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug =
    slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir
    ? path.join(pluginDataDir, "state")
    : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function resolveReviewsDir(cwd) {
  return path.join(resolveStateDir(cwd), REVIEWS_DIR_NAME);
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function resolveLockFile(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
}

/**
 * Sleep synchronously for `ms` without a busy CPU spin. The state writers are
 * short-lived processes (hooks and a detached worker), so a blocking wait on
 * the order of milliseconds is acceptable and keeps the locking logic simple.
 *
 * @param {number} ms
 */
function sleepSync(ms) {
  if (ms <= 0) {
    return;
  }
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive per-workspace lock so concurrent hook
 * processes and the detached review worker cannot interleave their
 * read-modify-write cycles on the shared state file.
 *
 * The lock is an `O_EXCL` lock file. A lock older than {@link LOCK_STALE_MS} is
 * treated as abandoned by a crashed writer and forcibly broken. If the lock
 * cannot be acquired within {@link LOCK_ACQUIRE_TIMEOUT_MS}, `fn` is run anyway
 * (an unsynchronized write is strictly better than dropping the update).
 *
 * @template T
 * @param {string} cwd
 * @param {() => T} fn
 * @returns {T}
 */
function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockFile = resolveLockFile(cwd);
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      acquired = true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") {
        // Cannot even create the lock file (e.g. permissions): proceed unlocked
        // rather than lose the update entirely.
        break;
      }
      // Break a stale lock left behind by a crashed writer.
      try {
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        // The lock vanished between calls — just retry.
        continue;
      }
      if (Date.now() >= deadline) {
        // Give up waiting and proceed unlocked rather than drop the update.
        break;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        // Best-effort release; a leftover lock will be broken as stale.
      }
    }
  }
}

/**
 * @param {string} cwd
 */
export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveReviewsDir(cwd), { recursive: true });
}

/**
 * @param {string} cwd
 * @param {string} reviewId
 * @returns {string}
 */
export function resolveReviewLogFile(cwd, reviewId) {
  ensureStateDir(cwd);
  return path.join(resolveReviewsDir(cwd), `${reviewId}.log`);
}

/**
 * Load the persisted state for `cwd`, falling back to defaults when missing or
 * corrupt.
 *
 * @param {string} cwd
 * @returns {{ version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }}
 */
export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : []
    };
  } catch {
    return defaultState();
  }
}

/**
 * @param {ReviewRecord[]} reviews
 * @returns {ReviewRecord[]}
 */
function pruneReviews(reviews) {
  return [...reviews]
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    )
    .slice(0, MAX_REVIEWS);
}

/**
 * Persist `state` for `cwd`. Prunes the review buffer to `MAX_REVIEWS`.
 *
 * The write is atomic: the JSON is written to a unique temp file and then
 * `rename`d over the real state file, so a concurrent reader never observes a
 * truncated or partially written file.
 *
 * @param {string} cwd
 * @param {{ config?: Partial<AutoReviewConfig>, reviews?: ReviewRecord[] }} state
 * @returns {{ version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }}
 */
export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    reviews: pruneReviews(state.reviews ?? [])
  };
  const stateFile = resolveStateFile(cwd);
  const tempFile = `${stateFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
    fs.renameSync(tempFile, stateFile);
  } catch (error) {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // Best-effort temp cleanup; ignore.
    }
    throw error;
  }
  return nextState;
}

/**
 * Load the state, apply `mutate`, and persist the result. The whole
 * load-mutate-save cycle runs under an exclusive per-workspace lock so
 * concurrent hooks and the detached worker cannot lose each other's updates.
 *
 * @param {string} cwd
 * @param {(state: { version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }) => void} mutate
 * @returns {{ version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }}
 */
export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

/**
 * @param {string} cwd
 * @returns {AutoReviewConfig}
 */
export function getConfig(cwd) {
  return loadState(cwd).config;
}

/**
 * Set a single config key.
 *
 * @param {string} cwd
 * @param {keyof AutoReviewConfig} key
 * @param {AutoReviewConfig[keyof AutoReviewConfig]} value
 * @returns {{ version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }}
 */
export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

/**
 * @param {string} cwd
 * @returns {ReviewRecord[]}
 */
export function listReviews(cwd) {
  return loadState(cwd).reviews;
}

/**
 * @param {string} prefix
 * @returns {string}
 */
export function generateReviewId(prefix = "review") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/**
 * Insert or update a review record (matched by `id`).
 *
 * @param {string} cwd
 * @param {Partial<ReviewRecord> & { id: string }} patch
 * @returns {{ version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }}
 */
export function upsertReview(cwd, patch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const index = state.reviews.findIndex((review) => review.id === patch.id);
    if (index === -1) {
      state.reviews.unshift({
        kind: "code",
        status: "queued",
        verdict: null,
        output: null,
        errorMessage: null,
        logFile: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...patch
      });
      return;
    }
    state.reviews[index] = {
      ...state.reviews[index],
      ...patch,
      updatedAt: timestamp
    };
  });
}

/**
 * Conditionally patch an existing review: the `patch` is applied only if the
 * current record satisfies `predicate`. The predicate test and the write happen
 * inside the same locked critical section, so this is a true compare-and-set —
 * it cannot roll back a status the detached worker has already advanced.
 *
 * Used by the dispatcher to attach the worker `pid` after spawning without
 * clobbering a worker that has already moved the review past `queued`.
 *
 * @param {string} cwd
 * @param {string} id - Review id to patch.
 * @param {(review: ReviewRecord) => boolean} predicate
 * @param {Partial<ReviewRecord>} patch
 * @returns {{ applied: boolean }}
 */
export function updateReviewIf(cwd, id, predicate, patch) {
  let applied = false;
  updateState(cwd, (state) => {
    const index = state.reviews.findIndex((review) => review.id === id);
    if (index === -1) {
      return;
    }
    if (!predicate(state.reviews[index])) {
      return;
    }
    state.reviews[index] = {
      ...state.reviews[index],
      ...patch,
      id,
      updatedAt: nowIso()
    };
    applied = true;
  });
  return { applied };
}

/**
 * Return the most recently updated review, optionally filtered by kind.
 *
 * @param {string} cwd
 * @param {{ kind?: "plan" | "code" }} [options]
 * @returns {ReviewRecord | null}
 */
export function getLatestReview(cwd, options = {}) {
  const reviews = listReviews(cwd)
    .filter((review) => (options.kind ? review.kind === options.kind : true))
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    );
  return reviews[0] ?? null;
}

/**
 * Decide whether a review looks stuck: still `queued` or `running` but last
 * touched longer than {@link STALE_RUNNING_MS} ago. A healthy review reaches a
 * terminal state (the worker enforces its own timeout); a job lingering in a
 * non-terminal state well past that bound means its worker died without
 * flushing a terminal state, so callers should warn instead of implying it is
 * still healthily in progress.
 *
 * @param {ReviewRecord | null | undefined} review
 * @param {{ now?: number, staleMs?: number }} [options]
 * @returns {boolean}
 */
export function isReviewLikelyStuck(review, options = {}) {
  if (!review) {
    return false;
  }
  if (review.status !== "running" && review.status !== "queued") {
    return false;
  }
  const staleMs = options.staleMs ?? STALE_RUNNING_MS;
  const now = options.now ?? Date.now();
  const updatedAt = Date.parse(String(review.updatedAt ?? ""));
  if (!Number.isFinite(updatedAt)) {
    // No usable timestamp — treat as stuck so it is surfaced, not hidden.
    return true;
  }
  return now - updatedAt > staleMs;
}

/**
 * Whether a review is a completed verdict eligible to be surfaced to
 * `sessionId` (and has not been surfaced yet).
 *
 * @param {ReviewRecord} review
 * @param {string | null} sessionId
 * @returns {boolean}
 */
function isSurfaceableFor(review, sessionId) {
  if (
    review.status !== "completed" ||
    typeof review.verdict !== "string" ||
    !review.verdict.trim() ||
    review.surfacedAt
  ) {
    return false;
  }
  if (!sessionId) {
    return true;
  }
  const reviewSession =
    review.request && typeof review.request === "object"
      ? review.request.sessionId
      : undefined;
  // Eligible for this session if it owns the review, or the review has no
  // session attribution (then any session may surface it).
  return !reviewSession || reviewSession === sessionId;
}

/**
 * Read-only peek at completed-but-unsurfaced reviews for a session, oldest
 * first. Does NOT claim them — for the actual injection path use
 * {@link claimUnsurfacedCompletedReviews}, which is race-free.
 *
 * @param {string} cwd
 * @param {{ sessionId?: string | null }} [options]
 * @returns {ReviewRecord[]}
 */
export function getUnsurfacedCompletedReviews(cwd, options = {}) {
  const sessionId = options.sessionId ?? null;
  return listReviews(cwd)
    .filter((review) => isSurfaceableFor(review, sessionId))
    .sort((left, right) =>
      String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? ""))
    );
}

/**
 * Atomically CLAIM up to `limit` completed-but-unsurfaced reviews for a
 * session: the eligibility test and the `surfacedAt` stamp happen in ONE locked
 * `updateState` critical section, and only the reviews actually stamped by this
 * call are returned. This is what makes the "inject each verdict exactly once"
 * guarantee hold even when two `UserPromptSubmit` hooks run concurrently — a
 * separate read-then-write (peek + mark) would let both claim the same review.
 *
 * Session scoping matches {@link getUnsurfacedCompletedReviews}: a review is
 * eligible only for the session that dispatched it, or for any session if it
 * has no session attribution.
 *
 * @param {string} cwd
 * @param {{ sessionId?: string | null, limit?: number }} [options]
 * @returns {ReviewRecord[]} the reviews this call claimed, oldest first
 */
export function claimUnsurfacedCompletedReviews(cwd, options = {}) {
  const sessionId = options.sessionId ?? null;
  const limit = Math.max(0, options.limit ?? Number.MAX_SAFE_INTEGER);
  if (limit === 0) {
    return [];
  }
  /** @type {ReviewRecord[]} */
  let claimed = [];
  updateState(cwd, (state) => {
    const surfacedAt = nowIso();
    const eligible = state.reviews
      .filter((review) => isSurfaceableFor(review, sessionId))
      .sort((left, right) =>
        String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? ""))
      )
      .slice(0, limit);
    for (const review of eligible) {
      review.surfacedAt = surfacedAt;
      if (sessionId) {
        review.surfacedSessionId = sessionId;
      }
    }
    // Return deep-ish copies so the caller cannot mutate state post-write.
    claimed = eligible.map((review) => ({ ...review }));
  });
  return claimed;
}

/**
 * Session-end cleanup of the plugin's OWN state, in one locked pass:
 *   - in-flight reviews (`queued`/`running`) belonging to `sessionId` are
 *     reconciled to `failed` ("session ended"), so nothing is left dangling;
 *   - any LIKELY-STUCK in-flight review — from any session — is self-healed to
 *     `failed`. A review still `queued`/`running` past {@link STALE_RUNNING_MS}
 *     cannot have a live worker (the worker's own hard timeout is far shorter),
 *     so its worker was SIGKILL'd / OOM-killed / crashed without flushing a
 *     terminal state. This is the canonical recovery path for that case.
 *   - reviews are pruned by age and count, but the most recent terminal review
 *     is always kept so `/codex-autoreview:last` still works after a clear.
 *
 * Never touches `~/.codex` or anything outside the plugin's own state file.
 *
 * @param {string} cwd
 * @param {{ sessionId?: string | null, now?: number, maxAgeMs?: number, keepRecent?: number, staleMs?: number }} [options]
 * @returns {{ reconciled: number, healed: number, pruned: number, kept: number, prunedIds: string[] }}
 */
export function reconcileAndPruneReviews(cwd, options = {}) {
  const sessionId = options.sessionId ?? null;
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const keepRecent = Math.max(1, options.keepRecent ?? 5);
  const staleMs = options.staleMs ?? STALE_RUNNING_MS;
  let reconciled = 0;
  let healed = 0;
  let kept = 0;
  /** @type {string[]} */
  const prunedIds = [];

  updateState(cwd, (state) => {
    // 1. Reconcile in-flight reviews to a terminal state:
    //    (a) this session's reviews — its session is ending; and
    //    (b) ANY likely-stuck review, regardless of session — its worker is
    //        certainly dead (SIGKILL/OOM/crash) since it outlived the worker's
    //        own hard timeout by a wide margin.
    for (const review of state.reviews) {
      if (review.status !== "queued" && review.status !== "running") {
        continue;
      }
      const belongsToSession =
        sessionId &&
        review.request &&
        typeof review.request === "object" &&
        review.request.sessionId === sessionId;
      const stuck = isReviewLikelyStuck(review, { now, staleMs });
      if (belongsToSession) {
        review.status = "failed";
        review.errorMessage =
          review.errorMessage ||
          "Claude session ended before this background review finished.";
        review.updatedAt = nowIso();
        reconciled += 1;
      } else if (stuck) {
        review.status = "failed";
        review.errorMessage =
          review.errorMessage ||
          "Stale running review — its background worker was terminated without flushing a result.";
        review.updatedAt = nowIso();
        healed += 1;
      }
    }

    // 2. Prune by age + count. CRITICAL: only TERMINAL reviews are ever
    //    eligible. A `queued`/`running` review is always kept — it may belong
    //    to ANOTHER active Claude session on this repo whose worker is still
    //    running; deleting its record (and, downstream, its files) would let
    //    that worker recreate a corrupt partial record on completion. The most
    //    recent few terminal reviews are also always kept so `last` still works.
    const sorted = [...state.reviews].sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    );
    /** @type {ReviewRecord[]} */
    const survivors = [];
    for (let index = 0; index < sorted.length; index += 1) {
      const review = sorted[index];
      const isTerminal = review.status === "completed" || review.status === "failed";
      const updatedAt = Date.parse(String(review.updatedAt ?? ""));
      const tooOld = Number.isFinite(updatedAt) && now - updatedAt > maxAgeMs;
      const overKeepBudget = index >= keepRecent;
      const prunable = isTerminal && (tooOld || overKeepBudget) && index >= keepRecent;
      if (prunable) {
        prunedIds.push(review.id);
      } else {
        survivors.push(review);
        kept += 1;
      }
    }
    state.reviews = survivors;
  });

  return { reconciled, healed, pruned: prunedIds.length, kept, prunedIds };
}

/**
 * Opportunistic, idempotent self-heal sweep: reconcile any LIKELY-STUCK
 * in-flight review to `failed`, without pruning anything. This is the cheap
 * entry-point version of {@link reconcileAndPruneReviews}'s healing step —
 * called from the hook dispatch path so a stuck review is recovered even on
 * projects/sessions where `SessionEnd` never fires. No-op when nothing is
 * stuck (the common case), so it is safe to call on every dispatch.
 *
 * @param {string} cwd
 * @param {{ now?: number, staleMs?: number }} [options]
 * @returns {{ healed: number }}
 */
export function healStuckReviews(cwd, options = {}) {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? STALE_RUNNING_MS;
  let healed = 0;
  // Cheap pre-check without the lock: only take the write lock if something
  // actually looks stuck.
  const anyStuck = listReviews(cwd).some((review) =>
    isReviewLikelyStuck(review, { now, staleMs })
  );
  if (!anyStuck) {
    return { healed: 0 };
  }
  updateState(cwd, (state) => {
    for (const review of state.reviews) {
      if (
        (review.status === "queued" || review.status === "running") &&
        isReviewLikelyStuck(review, { now, staleMs })
      ) {
        review.status = "failed";
        review.errorMessage =
          review.errorMessage ||
          "Stale running review — its background worker was terminated without flushing a result.";
        review.updatedAt = nowIso();
        healed += 1;
      }
    }
  });
  return { healed };
}
