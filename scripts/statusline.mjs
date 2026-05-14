#!/usr/bin/env node
/**
 * Statusline segment.
 *
 * Prints a single short `codex-autoreview: …` line that reflects the live
 * review state for the current workspace, and nothing at all when the
 * per-project toggle is off — so the statusline stays clean in projects that
 * have not opted in.
 *
 * Precedence (codex-consulted — current activity first):
 *   1. toggle off ............... print nothing
 *   2. a review running ......... `⏳ <kind> review · <elapsed>[ · pending:N]`
 *   3. a review stuck ........... `FAILED · stale`
 *   4. only queued reviews ...... `pending:N`
 *   5. latest terminal review ... `<VERDICT> · <CONFIDENCE>` (or `FAILED`)
 *   6. no review history ........ `ON (<model>, <effort>)`
 *
 * The running indicator never shows a token estimate: usage is only reliable
 * after the worker merges the codex usage event post-run, and a prompt-size
 * estimate would be input-only and misleading (codex-consulted).
 *
 * @file
 */

import fs from "node:fs";
import process from "node:process";

import { CODEX_DEFAULT_LABEL, resolveReviewEffort, resolveReviewModel } from "./lib/codex.mjs";
import { getConfig, isReviewLikelyStuck, listReviews } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/**
 * Read the statusLine JSON payload Claude Code pipes in on stdin.
 *
 * @returns {Record<string, unknown>}
 */
function readStatuslineInput() {
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
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
function resolveCwd(input) {
  if (typeof input.cwd === "string" && input.cwd) {
    return input.cwd;
  }
  const workspace =
    input.workspace && typeof input.workspace === "object"
      ? /** @type {Record<string, unknown>} */ (input.workspace)
      : null;
  if (workspace) {
    if (typeof workspace.current_dir === "string" && workspace.current_dir) {
      return workspace.current_dir;
    }
    if (typeof workspace.project_dir === "string" && workspace.project_dir) {
      return workspace.project_dir;
    }
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Format an elapsed-millisecond span as a compact `1m23s` / `45s` / `2h05m`.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0s";
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return `${totalMinutes}m${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

/**
 * The point in time a review's "elapsed" clock should count from: when it
 * started running, falling back to when it was created.
 *
 * @param {import("./lib/state.mjs").ReviewRecord} review
 * @returns {number} epoch ms, or `NaN` when no usable timestamp exists
 */
function reviewStartedAt(review) {
  const started = Date.parse(String(review.createdAt ?? ""));
  return Number.isFinite(started) ? started : NaN;
}

/**
 * Build the codex-autoreview statusline segment for the given workspace.
 *
 * Returns an empty string when the automatic review is not enabled.
 *
 * @param {string} cwd
 * @param {{ now?: number }} [options]
 * @returns {string}
 */
export function buildStatuslineSegment(cwd, options = {}) {
  let workspaceRoot;
  let config;
  try {
    workspaceRoot = resolveWorkspaceRoot(cwd);
    config = getConfig(workspaceRoot);
  } catch {
    return "";
  }

  if (!config.enabled) {
    return "";
  }

  const now = options.now ?? Date.now();
  /** @type {import("./lib/state.mjs").ReviewRecord[]} */
  let reviews = [];
  try {
    reviews = listReviews(workspaceRoot);
  } catch {
    reviews = [];
  }

  const inFlight = reviews.filter(
    (review) => review.status === "queued" || review.status === "running"
  );
  const running = inFlight.filter((review) => review.status === "running");
  const queued = inFlight.filter((review) => review.status === "queued");
  const stuck = inFlight.filter((review) => isReviewLikelyStuck(review, { now }));

  // 2. A review is actively running — show the live indicator. A stuck review
  //    (running far past its bound) is NOT "live"; it falls through to case 3.
  const liveRunning = running.filter((review) => !isReviewLikelyStuck(review, { now }));
  if (liveRunning.length > 0) {
    // Newest live review drives the elapsed clock.
    const newest = liveRunning
      .slice()
      .sort((left, right) =>
        String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
      )[0];
    const kind = newest.kind === "plan" ? "plan" : "code";
    const startedAt = reviewStartedAt(newest);
    const elapsed = Number.isFinite(startedAt) ? formatElapsed(now - startedAt) : "running";
    const backlog = inFlight.length - 1;
    const backlogSuffix = backlog > 0 ? ` · pending:${backlog}` : "";
    return `codex-autoreview: ⏳ ${kind} review · ${elapsed}${backlogSuffix}`;
  }

  // 3. Nothing live, but an in-flight review is stuck past its bound.
  if (stuck.length > 0) {
    return "codex-autoreview: FAILED · stale";
  }

  // 4. Only queued reviews, none running yet.
  if (queued.length > 0) {
    return `codex-autoreview: pending:${queued.length}`;
  }

  // 5. No in-flight work — reflect the most recent terminal review.
  const terminal = reviews
    .filter((review) => review.status === "completed" || review.status === "failed")
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    );
  const latest = terminal[0];
  if (latest) {
    if (latest.status === "failed") {
      return "codex-autoreview: FAILED";
    }
    const result = latest.result && typeof latest.result === "object" ? latest.result : null;
    const verdict =
      (result && typeof result.verdict === "string" && result.verdict) ||
      verdictFromLine(latest.verdict);
    const confidence = result && typeof result.confidence === "string" ? result.confidence : null;
    if (verdict && confidence) {
      return `codex-autoreview: ${verdict} · ${confidence}`;
    }
    if (verdict) {
      return `codex-autoreview: ${verdict}`;
    }
    // Completed but no structured verdict — fall through to the idle marker.
  }

  // 6. No usable review history yet — the original idle marker.
  const model = resolveReviewModel(config) ?? CODEX_DEFAULT_LABEL;
  const effort = resolveReviewEffort(config);
  return `codex-autoreview: ON (${model}, ${effort})`;
}

/**
 * Extract the leading `<VERDICT>` token from a `<VERDICT>: <summary>` line.
 *
 * @param {unknown} verdictLine
 * @returns {string | null}
 */
function verdictFromLine(verdictLine) {
  if (typeof verdictLine !== "string") {
    return null;
  }
  const match = verdictLine.trim().match(/^([A-Z]+)\b/);
  return match ? match[1] : null;
}

function main() {
  const input = readStatuslineInput();
  const segment = buildStatuslineSegment(resolveCwd(input));
  if (segment) {
    process.stdout.write(segment);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
