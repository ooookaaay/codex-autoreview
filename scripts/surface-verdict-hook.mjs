#!/usr/bin/env node
/**
 * UserPromptSubmit hook — surfaces finished Codex verdicts into the session.
 *
 * The plugin's reviews run in a detached background worker, so a verdict lands
 * in state asynchronously, after the hook that dispatched it already returned.
 * This hook closes the loop: on the user's next prompt it checks for any
 * COMPLETED review whose verdict has not yet been surfaced, and injects a
 * concise summary into the session context via
 * `hookSpecificOutput.additionalContext`. Claude then sees the Codex findings
 * inline and decides whether to act on them.
 *
 * Each surfaced review is stamped `surfacedAt` so it is injected exactly once,
 * never re-injected on later prompts.
 *
 * No-ops cleanly (exit 0, empty stdout) when the toggle is off or there is
 * nothing new to surface.
 *
 * @file
 */

import fs from "node:fs";
import process from "node:process";

import {
  getConfig,
  getUnsurfacedCompletedReviews,
  markReviewsSurfaced
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/** Hard cap on the injected context so a huge Codex output cannot bloat the prompt. */
const MAX_OUTPUT_CHARS = 1400;
/** Most reviews to surface in a single prompt (newest-relevant batching). */
const MAX_REVIEWS_PER_PROMPT = 3;

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
 * Build a concise, bounded context block for one finished review.
 *
 * @param {import("./lib/state.mjs").ReviewRecord} review
 * @returns {string}
 */
function renderReview(review) {
  const lines = [];
  const kindLabel = review.kind === "plan" ? "plan review (devil's advocate)" : "code review (bug-finding)";
  lines.push(`### Codex ${kindLabel} — ${review.id}`);
  lines.push(`Verdict: ${review.verdict}`);
  const output = String(review.output ?? "").trim();
  if (output && output !== review.verdict) {
    let body = output;
    // The verdict line is already shown above; drop a leading duplicate.
    if (body.startsWith(review.verdict)) {
      body = body.slice(review.verdict.length).trim();
    }
    if (body.length > MAX_OUTPUT_CHARS) {
      body = `${body.slice(0, MAX_OUTPUT_CHARS).trimEnd()}\n…(truncated — run /codex-autoreview:last for the full output)`;
    }
    if (body) {
      lines.push("");
      lines.push(body);
    }
  }
  return lines.join("\n");
}

/**
 * @param {import("./lib/state.mjs").ReviewRecord[]} reviews
 * @returns {string}
 */
function buildAdditionalContext(reviews) {
  const blocks = reviews.map(renderReview);
  return [
    "Automatic Codex review results just completed in the background.",
    "Treat these as advisory peer review — assess each finding on its merits,",
    "decide whether it is valid, and tell the user what you will or won't act on.",
    "",
    ...blocks
  ].join("\n");
}

function main() {
  const input = readHookInput();
  const cwd =
    (typeof input.cwd === "string" && input.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const sessionId = typeof input.session_id === "string" ? input.session_id : null;

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  // No-op when the per-project toggle is off — nothing should be surfaced.
  if (!config.enabled) {
    return;
  }

  const pending = getUnsurfacedCompletedReviews(workspaceRoot);
  if (pending.length === 0) {
    return;
  }

  // Surface the oldest-finished few; any beyond the cap stay pending and are
  // picked up on the following prompt.
  const toSurface = pending.slice(0, MAX_REVIEWS_PER_PROMPT);
  const additionalContext = buildAdditionalContext(toSurface);

  // Mark them surfaced only after we have successfully built the payload, so a
  // failure here does not silently swallow a verdict.
  markReviewsSurfaced(
    workspaceRoot,
    toSurface.map((review) => review.id),
    { sessionId }
  );

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext
      }
    })}\n`
  );
}

try {
  main();
} catch (error) {
  // Never block the user's prompt on a surfacing failure — log and exit 0.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-autoreview: could not surface verdict: ${message}\n`);
}
