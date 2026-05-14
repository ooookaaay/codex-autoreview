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

/**
 * @typedef {object} AutoReviewConfig
 * @property {boolean} enabled - Whether the automatic reviews are turned on.
 * @property {string | null} model - Codex model override, or null for default.
 * @property {string | null} effort - Codex reasoning effort override, or null.
 */

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
      effort: null
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
  fs.writeFileSync(
    resolveStateFile(cwd),
    `${JSON.stringify(nextState, null, 2)}\n`,
    "utf8"
  );
  return nextState;
}

/**
 * Load the state, apply `mutate`, and persist the result.
 *
 * @param {string} cwd
 * @param {(state: { version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }) => void} mutate
 * @returns {{ version: number, config: AutoReviewConfig, reviews: ReviewRecord[] }}
 */
export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
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
