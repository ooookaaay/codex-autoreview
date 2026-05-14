#!/usr/bin/env node
/**
 * Statusline segment.
 *
 * Prints `codex-autoreview: ON (<model>, <effort>)` when the per-project toggle
 * is enabled, and nothing at all when it is off — so the statusline stays clean
 * in projects that have not opted in.
 *
 * @file
 */

import fs from "node:fs";
import process from "node:process";

import { CODEX_DEFAULT_LABEL, resolveReviewEffort, resolveReviewModel } from "./lib/codex.mjs";
import { getConfig } from "./lib/state.mjs";
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
 * Build the codex-autoreview statusline segment for the given workspace.
 *
 * Returns an empty string when the automatic review is not enabled.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function buildStatuslineSegment(cwd) {
  let config;
  try {
    config = getConfig(resolveWorkspaceRoot(cwd));
  } catch {
    return "";
  }

  if (!config.enabled) {
    return "";
  }

  const model = resolveReviewModel(config) ?? CODEX_DEFAULT_LABEL;
  const effort = resolveReviewEffort(config) ?? CODEX_DEFAULT_LABEL;
  return `codex-autoreview: ON (${model}, ${effort})`;
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
