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

/**
 * On-disk state schema version.
 *
 * v1 → v2 (F3, Phase 1 FOUNDATION): added the accept/reject memory
 * (`config.dismissedFindings`), the reviewer-backend config keys
 * (`config.backend`, `config.backendConfig`, `config.pricing`), the
 * onboarding marker (`config.onboardedAt`), the accumulated review-gap
 * accumulator (`reviewGaps`), and the per-review anchoring / structured-result
 * fields (`request.reviewedInputHash`, `request.backend`, `review.result`,
 * `review.reviewedInputHash`). Wave 2C additionally added the review-profile
 * override (`config.profile`). All additive — {@link loadState} reads a v1
 * file unchanged (missing keys fill from {@link defaultState}), so the bump is
 * backward-compatible.
 */
const STATE_VERSION = 2;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-autoreview");
const STATE_FILE_NAME = "state.json";
const REVIEWS_DIR_NAME = "reviews";
const MAX_REVIEWS = 20;
const LOCK_FILE_NAME = "state.json.lock";
/**
 * Treat a lock older than this as stale (a crashed writer never released it).
 * A legitimate critical section here is a small JSON read + atomic write —
 * single-digit milliseconds — so a lock held longer than this many seconds
 * means its owner died mid-write.
 */
const LOCK_STALE_MS = 15_000;
/**
 * How long to keep retrying to acquire the lock before, as an absolute last
 * resort, proceeding unlocked. Set generously (30s) relative to the millisecond
 * critical section: in practice the lock is always acquired well within this,
 * and a single dropped state update would be worse for this single-machine
 * plugin than the vanishingly rare unlocked write this guards.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
/** Busy-wait granularity between lock acquisition attempts. */
const LOCK_RETRY_MS = 25;

/**
 * @typedef {object} DismissedFinding
 * Accept/reject memory entry (F3): a finding the user explicitly dismissed, so
 * later reviews stop re-surfacing it. Phase 2C's accept/reject loop reads/writes
 * this list.
 * @property {string} fingerprint - Stable finding fingerprint (file + line
 *   window + normalized title) — the dedupe key.
 * @property {"accepted" | "rejected"} disposition - `accepted` = the user
 *   acknowledged and will not act; `rejected` = the user judged it a false
 *   positive. Both suppress re-surfacing; the distinction feeds calibration.
 * @property {string} dismissedAt - ISO timestamp.
 * @property {string | null} [note] - Optional user note on why.
 */

/**
 * @typedef {object} ReviewGap
 * An accumulated "review gap" (F3): a claim a review could NOT verify, plus the
 * concrete oracle that would verify it next time. Flattened from each review's
 * `result.unverified[]`. Phase 2C's review-gap feedback loop reads this.
 * @property {string} gap - What could not be verified.
 * @property {string} suggestedOracle - The test/fixture/script that would.
 * @property {boolean} critical - Whether it was surfaced as critical.
 * @property {string} reviewId - The review that recorded the gap.
 * @property {"plan" | "code"} kind
 * @property {string} recordedAt - ISO timestamp.
 */

/**
 * @typedef {object} AutoReviewConfig
 * @property {boolean} enabled - Whether the automatic reviews are turned on.
 * @property {string | null} model - Codex model override, or null for default.
 * @property {string | null} effort - Codex reasoning effort override, or null.
 * @property {number | null} timeoutMs - Hard per-review `codex exec` timeout in
 *   milliseconds, or null to use the built-in default.
 * @property {string} backend - Reviewer backend id (F1). Defaults to
 *   `"exec-generic"` — today's behavior, the non-breaking migration default.
 * @property {object | null} backendConfig - Backend-specific config (e.g. the
 *   `externalCommand` object for the `external` backend), or null.
 * @property {string | null} profile - Review profile id override (one of
 *   `review-schema.mjs`'s `REVIEW_PROFILES`), or null to use the per-kind
 *   default. Wave 2C's profiles/personas; the CLI validates the enum on write,
 *   the worker resolves null to a per-kind default.
 * @property {Record<string, { in: number, cachedIn?: number, out: number }>} pricing
 *   Per-model USD-per-1M-token rate overrides (F6) — wins over the hardcoded
 *   table. Empty object by default.
 * @property {DismissedFinding[]} dismissedFindings - Accept/reject memory (F3).
 * @property {string | null} onboardedAt - ISO timestamp the user completed the
 *   guided onboarding flow, or null when not yet onboarded. A Phase 2
 *   `SessionStart` hook consumes this; review hooks no-op until it is set.
 *   ABSENT/null = not yet onboarded.
 */

/**
 * Default staleness floor for a review with NO recorded per-review timeout
 * (older records, or a request that never persisted `timeoutMs`). For a review
 * that does carry `request.timeoutMs`, the staleness bound is computed from
 * THAT value instead — see {@link staleBoundForReview} — because a project may
 * configure a review timeout as long as 30 minutes, and a fixed 10-minute bound
 * would falsely "heal" a legitimate long review whose worker is still alive.
 *
 * `last`/`config` surface jobs past their bound as likely-stuck rather than
 * healthy. The value is deliberately generous — comfortably past a default
 * review plus the worker's own kill grace period.
 */
export const STALE_RUNNING_MS = 600_000;

/**
 * Extra slack added on top of a review's own hard timeout before it counts as
 * stale: the worker's SIGTERM→SIGKILL kill grace, plus generous headroom for a
 * slow final state write, lock contention, and clock skew. A review still
 * `running` past `timeoutMs + STALE_GRACE_MS` genuinely cannot have a live
 * worker — the worker would have self-terminated at its own `timeoutMs`.
 */
const STALE_GRACE_MS = 120_000;

/**
 * The staleness bound for a specific review, in milliseconds. Derived from the
 * review's own recorded `request.timeoutMs` when present (so a legitimately
 * long-configured review is never falsely healed), otherwise the
 * {@link STALE_RUNNING_MS} floor. The result is never below the floor.
 *
 * @param {ReviewRecord | null | undefined} review
 * @returns {number}
 */
export function staleBoundForReview(review) {
  const requested =
    review &&
    review.request &&
    typeof review.request === "object" &&
    typeof review.request.timeoutMs === "number" &&
    Number.isFinite(review.request.timeoutMs) &&
    review.request.timeoutMs > 0
      ? review.request.timeoutMs
      : null;
  if (requested == null) {
    return STALE_RUNNING_MS;
  }
  return Math.max(STALE_RUNNING_MS, requested + STALE_GRACE_MS);
}

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
 * @property {string | null} verdict - The compact `<VERDICT>: <summary>` line.
 * @property {string | null} output - The compact human-facing review text,
 *   rendered FROM {@link ReviewRecord.result} (F2).
 * @property {string | null} errorMessage
 * @property {string} createdAt - ISO timestamp.
 * @property {string} updatedAt - ISO timestamp.
 * @property {string | null} logFile - Absolute path to the job log, if any.
 * @property {number | null} [pid] - Detached worker pid, when known.
 * @property {string | null} [surfacedAt] - ISO timestamp when the completed
 *   verdict was injected into a Claude session, or absent/null if not yet.
 * @property {import("./review-schema.mjs").ReviewResult | null} [result] - The
 *   full F2 claim-based structured review object, when the backend produced
 *   one. The text fields above are rendered from this. (F2/F3)
 * @property {string | null} [reviewedInputHash] - The anchoring fingerprint
 *   (diff fingerprint / planHash) the review was actually computed against, as
 *   recomputed at settle time — compared to `request.reviewedInputHash` for
 *   stale detection. (F3/F4)
 * @property {string} [backend] - The reviewer backend id that produced this
 *   review (F1).
 * @property {boolean} [degraded] - `true` when the backend could not populate
 *   the full structured result (a prose-only backend). (F1/F2)
 * @property {object} [request] - The queued request payload (carries the
 *   prompt, model, effort, timeout, `backend`, `backendConfig`,
 *   `reviewedInputHash`, and the Claude `sessionId` when known).
 */

function nowIso() {
  return new Date().toISOString();
}

/**
 * @typedef {object} AutoReviewState
 * @property {number} version - On-disk schema version.
 * @property {AutoReviewConfig} config
 * @property {ReviewRecord[]} reviews - Ring buffer of recent reviews.
 * @property {ReviewGap[]} reviewGaps - Accumulated unverified-claim gaps (F3).
 */

/**
 * @returns {AutoReviewState}
 */
function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      enabled: false,
      model: null,
      effort: null,
      timeoutMs: null,
      // F1: reviewer backend. Default reproduces today's behavior exactly.
      backend: "exec-generic",
      backendConfig: null,
      // Wave 2C: review profile override — null means the per-kind default.
      profile: null,
      // F6: per-model price overrides (wins over the hardcoded table).
      pricing: {},
      // F3: accept/reject memory — findings the user dismissed.
      dismissedFindings: [],
      // F3: onboarding marker — null/absent means "not yet onboarded".
      onboardedAt: null
    },
    reviews: [],
    // F3: accumulated review gaps (flattened unverified[] across reviews).
    reviewGaps: []
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
  // A unique OWNERSHIP TOKEN for this acquisition. The lock file's content is
  // `<pid>:<token>`; the holder only ever removes the lock if the file still
  // carries its own token. This prevents the classic race where writer A
  // stale-breaks writer B's lock, A acquires, then B's `finally` deletes A's
  // lock — handing the "lock" to a third writer while A is still inside.
  const token = `${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  let acquired = false;

  /** @returns {string | null} the lock file's current content, or null if gone. */
  const readLock = () => {
    try {
      return fs.readFileSync(lockFile, "utf8").trim();
    } catch {
      return null;
    }
  };

  while (!acquired) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, `${process.pid}:${token}\n`);
      fs.closeSync(fd);
      acquired = true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") {
        // Cannot even create the lock file (e.g. permissions): proceed unlocked
        // rather than lose the update entirely.
        break;
      }
      // Break a stale lock left behind by a crashed writer — but only if the
      // SAME lock content is still there after the stale interval (otherwise
      // the owner is alive and rotating, or already released).
      try {
        const before = readLock();
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (age > LOCK_STALE_MS) {
          // Re-read: only remove if the content is unchanged since `before`,
          // i.e. we are breaking the exact stale lock we observed.
          if (before !== null && readLock() === before) {
            fs.rmSync(lockFile, { force: true });
          }
          continue;
        }
      } catch {
        // The lock vanished between calls — just retry.
        continue;
      }
      if (Date.now() >= deadline) {
        // Absolute last resort: proceed unlocked rather than drop the update.
        // With a 30s acquire window vs a millisecond critical section this is
        // effectively unreachable in practice.
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
        // Only remove the lock if it still carries OUR token — never delete a
        // lock a different writer now owns (e.g. after our lock was itself
        // stale-broken because we ran long).
        if (readLock() === `${process.pid}:${token}`) {
          fs.rmSync(lockFile, { force: true });
        }
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
 * BACKWARD-COMPATIBLE (F3): an older v1 state file has no `backend`/`pricing`/
 * `profile`/`dismissedFindings`/`onboardedAt`/`reviewGaps` — every missing key
 * is filled from {@link defaultState}, so a v1 file loads cleanly as v2 with the
 * onboarding marker absent (= not yet onboarded) and today's-behavior defaults.
 *
 * @param {string} cwd
 * @returns {AutoReviewState}
 */
export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  const base = defaultState();
  if (!fs.existsSync(stateFile)) {
    return base;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const parsedConfig =
      parsed.config && typeof parsed.config === "object" ? parsed.config : {};
    return {
      ...base,
      ...parsed,
      // Always re-stamp the version: a loaded v1 file is now a v2 in memory.
      version: STATE_VERSION,
      config: {
        ...base.config,
        ...parsedConfig,
        // Defensively re-default the structured config keys: a v1 file omits
        // them, and a corrupt value must not poison a typed array/object.
        backend:
          typeof parsedConfig.backend === "string" && parsedConfig.backend
            ? parsedConfig.backend
            : base.config.backend,
        backendConfig:
          parsedConfig.backendConfig && typeof parsedConfig.backendConfig === "object"
            ? parsedConfig.backendConfig
            : null,
        profile:
          typeof parsedConfig.profile === "string" && parsedConfig.profile
            ? parsedConfig.profile
            : null,
        pricing:
          parsedConfig.pricing && typeof parsedConfig.pricing === "object"
            ? parsedConfig.pricing
            : {},
        dismissedFindings: Array.isArray(parsedConfig.dismissedFindings)
          ? parsedConfig.dismissedFindings
          : [],
        onboardedAt:
          typeof parsedConfig.onboardedAt === "string" && parsedConfig.onboardedAt
            ? parsedConfig.onboardedAt
            : null
      },
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
      reviewGaps: Array.isArray(parsed.reviewGaps) ? parsed.reviewGaps : []
    };
  } catch {
    return base;
  }
}

/**
 * Trim the review ring buffer on every save.
 *
 * CRITICAL safety rule: a non-terminal (`queued`/`running`) review is NEVER
 * dropped, however many there are. Its detached worker still expects to find
 * its record — if the record vanished, the worker would find nothing, exit
 * without writing a terminal state, and the verdict would be lost (breaking the
 * terminal-state guarantee). Only TERMINAL reviews are subject to the
 * {@link MAX_REVIEWS} cap; the newest terminal reviews are kept so
 * `/codex-autoreview:last` still works.
 *
 * @param {ReviewRecord[]} reviews
 * @returns {ReviewRecord[]}
 */
function pruneReviews(reviews) {
  const sorted = [...reviews].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  /** @type {ReviewRecord[]} */
  const nonTerminal = [];
  /** @type {ReviewRecord[]} */
  const terminal = [];
  for (const review of sorted) {
    if (review.status === "completed" || review.status === "failed") {
      terminal.push(review);
    } else {
      nonTerminal.push(review);
    }
  }
  // Keep every non-terminal review; cap only the terminal ones. The overall
  // budget for terminal records shrinks by however many non-terminal reviews
  // are in flight, but always leaves room for at least a few terminal records.
  const terminalBudget = Math.max(5, MAX_REVIEWS - nonTerminal.length);
  const keptTerminal = terminal.slice(0, terminalBudget);
  // Re-sort the union newest-first so the buffer stays ordered.
  return [...nonTerminal, ...keptTerminal].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
}

/** Hard cap on the accumulated review-gap buffer (F3) — newest kept. */
const MAX_REVIEW_GAPS = 50;

/**
 * Persist `state` for `cwd`. Prunes the review buffer to `MAX_REVIEWS` and the
 * review-gap accumulator to {@link MAX_REVIEW_GAPS}.
 *
 * The write is atomic: the JSON is written to a unique temp file and then
 * `rename`d over the real state file, so a concurrent reader never observes a
 * truncated or partially written file.
 *
 * @param {string} cwd
 * @param {{ config?: Partial<AutoReviewConfig>, reviews?: ReviewRecord[], reviewGaps?: ReviewGap[] }} state
 * @returns {AutoReviewState}
 */
export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const reviewGaps = Array.isArray(state.reviewGaps) ? state.reviewGaps : [];
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    reviews: pruneReviews(state.reviews ?? []),
    // Keep only the newest gaps so the accumulator can't grow without bound.
    reviewGaps: reviewGaps.slice(-MAX_REVIEW_GAPS)
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
 * @param {(state: AutoReviewState) => void} mutate
 * @returns {AutoReviewState}
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
 * touched longer than its staleness bound ago.
 *
 * The bound is PER-REVIEW: derived from the review's own recorded
 * `request.timeoutMs` (+ kill grace + slack) via {@link staleBoundForReview},
 * so a project that configured a long review timeout (up to 30 min) never has
 * a legitimately long-running review falsely flagged. A healthy review reaches
 * a terminal state at or before its own hard timeout; a job lingering well past
 * that means its worker died (SIGKILL/OOM/crash) without flushing a terminal
 * state, so callers should warn / self-heal instead of implying it is healthy.
 *
 * `staleMs` may be passed to force a fixed bound (used by tests).
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
  const staleMs = options.staleMs ?? staleBoundForReview(review);
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
  // staleMs is intentionally NOT defaulted: when unset, isReviewLikelyStuck
  // computes a PER-REVIEW bound from each review's own configured timeout, so a
  // legitimately long review is never falsely healed. Tests may force a value.
  const staleMs = options.staleMs;
  let reconciled = 0;
  let healed = 0;
  let kept = 0;
  /** @type {string[]} */
  const prunedIds = [];

  updateState(cwd, (state) => {
    // 1. Reconcile in-flight reviews to a terminal state:
    //    (a) this session's reviews — its session is ending; and
    //    (b) ANY likely-stuck review, regardless of session — its worker is
    //        certainly dead (SIGKILL/OOM/crash) since it outlived its own hard
    //        timeout (+ kill grace + slack) by a wide margin.
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

    // 2. Prune by age + count. CRITICAL invariants:
    //    - only TERMINAL reviews are ever eligible. A `queued`/`running` review
    //      is always kept — it may belong to ANOTHER active session whose
    //      worker is still running; deleting its record would let that worker
    //      recreate a corrupt partial record on completion.
    //    - `keepRecent` is counted over TERMINAL reviews ONLY, not the overall
    //      list. Counting it over the mixed list means a handful of fresh
    //      in-flight reviews could push every terminal review past the budget
    //      and prune all verdict history — breaking `/codex-autoreview:last`.
    const sorted = [...state.reviews].sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    );
    /** @type {ReviewRecord[]} */
    const survivors = [];
    let terminalSeen = 0;
    for (const review of sorted) {
      const isTerminal = review.status === "completed" || review.status === "failed";
      if (!isTerminal) {
        // Non-terminal reviews are always kept, regardless of session or age.
        survivors.push(review);
        kept += 1;
        continue;
      }
      // Among terminal reviews: keep the most recent `keepRecent` outright; the
      // rest are pruned if they are too old or over the count budget.
      const terminalIndex = terminalSeen;
      terminalSeen += 1;
      const updatedAt = Date.parse(String(review.updatedAt ?? ""));
      const tooOld = Number.isFinite(updatedAt) && now - updatedAt > maxAgeMs;
      const overKeepBudget = terminalIndex >= keepRecent;
      if (terminalIndex >= keepRecent && (tooOld || overKeepBudget)) {
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
  // Not defaulted: isReviewLikelyStuck computes a per-review bound from each
  // review's own configured timeout. Tests may force a fixed value.
  const staleMs = options.staleMs;
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

// --------------------------------------------------------------------------
// F3 — state-schema-extension accessors. All backward-compatible: they read a
// v1 state file (where these fields are absent) as the documented defaults.
// --------------------------------------------------------------------------

/**
 * Whether the user has completed the guided onboarding flow for this workspace.
 * ABSENT/null marker = not yet onboarded. A Phase 2 `SessionStart` hook uses
 * this to trigger onboarding; review hooks no-op until it returns `true`.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
export function isOnboarded(cwd) {
  const onboardedAt = loadState(cwd).config.onboardedAt;
  return typeof onboardedAt === "string" && onboardedAt.trim().length > 0;
}

/**
 * Read the raw onboarding timestamp (ISO string), or `null` when not yet
 * onboarded.
 *
 * @param {string} cwd
 * @returns {string | null}
 */
export function getOnboardedAt(cwd) {
  const onboardedAt = loadState(cwd).config.onboardedAt;
  return typeof onboardedAt === "string" && onboardedAt.trim() ? onboardedAt : null;
}

/**
 * Mark the workspace as onboarded (idempotent — does not overwrite an existing
 * timestamp). Phase 1 only provides the accessor; the Phase 2 onboarding flow
 * is what calls this.
 *
 * @param {string} cwd
 * @param {{ now?: string }} [options]
 * @returns {AutoReviewState}
 */
export function markOnboarded(cwd, options = {}) {
  return updateState(cwd, (state) => {
    if (!state.config.onboardedAt) {
      state.config.onboardedAt = options.now ?? nowIso();
    }
  });
}

/**
 * Read the accumulated review-gap accumulator (F3) — flattened unverified
 * claims across reviews, newest last.
 *
 * @param {string} cwd
 * @returns {ReviewGap[]}
 */
export function listReviewGaps(cwd) {
  const gaps = loadState(cwd).reviewGaps;
  return Array.isArray(gaps) ? gaps : [];
}

/**
 * Append a review's unverified-claim gaps to the accumulator, in one locked
 * pass. `gaps` is normally a review's `result.unverified[]`; each entry is
 * stamped with the originating `reviewId`/`kind`/timestamp. No-op for an empty
 * list. The accumulator is capped to the newest {@link MAX_REVIEW_GAPS} on
 * save.
 *
 * @param {string} cwd
 * @param {object} params
 * @param {string} params.reviewId
 * @param {"plan" | "code"} params.kind
 * @param {Array<{ gap: string, suggestedOracle: string, critical?: boolean }>} params.gaps
 * @returns {AutoReviewState}
 */
export function appendReviewGaps(cwd, params) {
  const incoming = Array.isArray(params.gaps) ? params.gaps : [];
  if (incoming.length === 0) {
    return loadState(cwd);
  }
  return updateState(cwd, (state) => {
    const recordedAt = nowIso();
    if (!Array.isArray(state.reviewGaps)) {
      state.reviewGaps = [];
    }
    for (const entry of incoming) {
      if (!entry || typeof entry.gap !== "string" || !entry.gap.trim()) {
        continue;
      }
      state.reviewGaps.push({
        gap: entry.gap,
        suggestedOracle:
          typeof entry.suggestedOracle === "string" ? entry.suggestedOracle : "",
        critical: Boolean(entry.critical),
        reviewId: params.reviewId,
        kind: params.kind === "plan" ? "plan" : "code",
        recordedAt
      });
    }
  });
}

/**
 * Read the accept/reject memory (F3) — findings the user explicitly dismissed.
 *
 * @param {string} cwd
 * @returns {DismissedFinding[]}
 */
export function listDismissedFindings(cwd) {
  const dismissed = loadState(cwd).config.dismissedFindings;
  return Array.isArray(dismissed) ? dismissed : [];
}

/**
 * Whether a finding fingerprint is in the accept/reject memory — i.e. the user
 * has dismissed it before and later reviews should not re-surface it.
 *
 * @param {string} cwd
 * @param {string} fingerprint
 * @returns {boolean}
 */
export function isFindingDismissed(cwd, fingerprint) {
  if (typeof fingerprint !== "string" || !fingerprint) {
    return false;
  }
  return listDismissedFindings(cwd).some((entry) => entry && entry.fingerprint === fingerprint);
}

/**
 * Record a finding as dismissed (accept/reject memory, F3). Idempotent on the
 * fingerprint: a repeated dismissal updates the disposition/note in place
 * rather than duplicating. Phase 1 provides the accessor; Phase 2C's
 * accept/reject UX is what calls it.
 *
 * @param {string} cwd
 * @param {object} params
 * @param {string} params.fingerprint
 * @param {"accepted" | "rejected"} params.disposition
 * @param {string | null} [params.note]
 * @returns {AutoReviewState}
 */
export function dismissFinding(cwd, params) {
  const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint.trim() : "";
  if (!fingerprint) {
    return loadState(cwd);
  }
  const disposition = params.disposition === "rejected" ? "rejected" : "accepted";
  return updateState(cwd, (state) => {
    if (!Array.isArray(state.config.dismissedFindings)) {
      state.config.dismissedFindings = [];
    }
    const existing = state.config.dismissedFindings.find(
      (entry) => entry && entry.fingerprint === fingerprint
    );
    const dismissedAt = nowIso();
    if (existing) {
      existing.disposition = disposition;
      existing.dismissedAt = dismissedAt;
      existing.note = params.note ?? existing.note ?? null;
      return;
    }
    state.config.dismissedFindings.push({
      fingerprint,
      disposition,
      dismissedAt,
      note: params.note ?? null
    });
  });
}

/**
 * Resolve the per-model pricing rate override for `model` from the project
 * config (F6) — `null` when the project has set no override for it. Wins over
 * the hardcoded `pricing.mjs` table; the rate resolution order is
 * flag → this → table → unknown.
 *
 * @param {string} cwd
 * @param {string} model
 * @returns {{ in: number, cachedIn?: number, out: number } | null}
 */
export function getPricingOverride(cwd, model) {
  if (typeof model !== "string" || !model.trim()) {
    return null;
  }
  const pricing = loadState(cwd).config.pricing;
  if (!pricing || typeof pricing !== "object") {
    return null;
  }
  const entry = pricing[model.trim()];
  return entry && typeof entry === "object" ? entry : null;
}
