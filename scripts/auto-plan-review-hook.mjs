#!/usr/bin/env node
/**
 * PreToolUse / ExitPlanMode hook.
 *
 * When the per-project toggle is on, sends Claude's plan to Codex for a
 * devil's-advocate review. The review runs as a detached background job; this
 * hook dispatches it and returns immediately. It never emits a permission
 * decision, so plan-mode exit is never blocked.
 *
 * No-ops cleanly when: the toggle is off, the plan is too small to be worth a
 * review, or the `codex` CLI is absent.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { dispatchBackgroundReview } from "./lib/auto-review.mjs";
import { getCodexAvailability } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const MIN_REVIEWABLE_PLAN_CHARS = 240;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

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
  return JSON.parse(raw);
}

/**
 * @param {string} [message]
 */
function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

/**
 * Extract the plan text from the ExitPlanMode tool input.
 *
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
function extractPlanText(input) {
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? /** @type {Record<string, unknown>} */ (input.tool_input)
      : {};
  const inlinePlan = typeof toolInput.plan === "string" ? toolInput.plan : "";
  if (inlinePlan.trim()) {
    return inlinePlan.trim();
  }

  const planFilePath =
    typeof toolInput.planFilePath === "string" ? toolInput.planFilePath : "";
  if (planFilePath) {
    try {
      return fs.readFileSync(planFilePath, "utf8").trim();
    } catch {
      return "";
    }
  }

  return "";
}

/**
 * @param {string} planText
 * @returns {string}
 */
function buildPlanReviewPrompt(planText) {
  const template = loadPromptTemplate(ROOT_DIR, "auto-plan-review");
  return interpolateTemplate(template, { PLAN_BLOCK: planText });
}

function main() {
  const input = readHookInput();
  const cwd =
    (typeof input.cwd === "string" && input.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  // No-op cleanly when the per-project toggle is off.
  if (!config.enabled) {
    return;
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    const detail = availability.detail ? ` ${availability.detail}.` : "";
    logNote(
      `codex-autoreview: Codex CLI is not available for the plan review.${detail} Install it with \`npm install -g @openai/codex\`.`
    );
    return;
  }

  const planText = extractPlanText(input);
  if (!planText) {
    return;
  }

  // Skip trivially small plans so the review does not waste Codex usage.
  if (planText.length < MIN_REVIEWABLE_PLAN_CHARS) {
    logNote(
      "codex-autoreview: plan review skipped — the plan is too small to be worth a devil's-advocate pass."
    );
    return;
  }

  // Dispatch the devil's-advocate review as a detached background job and
  // return immediately. Plan-mode exit is never blocked; the verdict surfaces
  // later through /codex-autoreview:last and the statusline.
  const dispatch = dispatchBackgroundReview({
    cwd,
    kind: "plan",
    prompt: buildPlanReviewPrompt(planText),
    // Pass the raw plan text so the F4 planHash anchors to the plan itself,
    // not the prompt-wrapped form.
    planText,
    config,
    sessionId: typeof input.session_id === "string" ? input.session_id : null
  });

  if (!dispatch.dispatched) {
    logNote(
      dispatch.detail
        ? `codex-autoreview: plan review dispatch failed: ${dispatch.detail}`
        : "codex-autoreview: plan review dispatch failed."
    );
    return;
  }

  const label = dispatch.reviewId ? ` (${dispatch.reviewId})` : "";
  logNote(
    `codex-autoreview: Codex devil's-advocate plan review started in the background${label}. Run /codex-autoreview:last to see the verdict before relying on the plan.`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
