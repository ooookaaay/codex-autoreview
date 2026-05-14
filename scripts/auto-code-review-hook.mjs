#!/usr/bin/env node
/**
 * Stop hook.
 *
 * When the per-project toggle is on, sends the repository's code changes to
 * Codex for a bug-finding review. The review runs as a detached background job;
 * this hook dispatches it and returns immediately. It never emits a blocking
 * decision, so the Stop event is never blocked — the review is advisory.
 *
 * No-ops cleanly when: the toggle is off, there is nothing reviewable in the
 * working tree, or the `codex` CLI is absent.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { dispatchBackgroundReview } from "./lib/auto-review.mjs";
import { getCodexAvailability } from "./lib/codex.mjs";
import { getWorkingTreeState } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

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
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
function buildCodeReviewPrompt(input) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "auto-code-review");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Context from Claude's previous response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
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
      `codex-autoreview: Codex CLI is not available for the code review.${detail} Install it with \`npm install -g @openai/codex\`.`
    );
    return;
  }

  // Skip when there is nothing reviewable in the working tree.
  const workingTree = getWorkingTreeState(cwd);
  if (!workingTree.isDirty) {
    logNote(
      "codex-autoreview: code review skipped — no uncommitted changes to review."
    );
    return;
  }

  // Dispatch the bug-finding review as a detached background job and return
  // immediately. The Stop event is never blocked; the verdict surfaces later
  // through /codex-autoreview:last and the statusline.
  const dispatch = dispatchBackgroundReview({
    cwd,
    kind: "code",
    prompt: buildCodeReviewPrompt(input),
    config,
    sessionId: typeof input.session_id === "string" ? input.session_id : null
  });

  if (!dispatch.dispatched) {
    logNote(
      dispatch.detail
        ? `codex-autoreview: code review dispatch failed: ${dispatch.detail}`
        : "codex-autoreview: code review dispatch failed."
    );
    return;
  }

  const label = dispatch.reviewId ? ` (${dispatch.reviewId})` : "";
  logNote(
    `codex-autoreview: Codex bug-finding code review started in the background${label}. Run /codex-autoreview:last to see the verdict.`
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
