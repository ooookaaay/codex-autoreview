#!/usr/bin/env node
/**
 * Stop hook.
 *
 * When the per-project toggle is on AND the workspace is onboarded, sends the
 * repository's code changes to Codex for a bug-finding review. The review runs
 * as a detached background job; this hook dispatches it and returns
 * immediately. It never emits a blocking decision, so the Stop event is never
 * blocked — the review is advisory.
 *
 * No-ops cleanly when: stdin is missing/empty/malformed JSON, the toggle is
 * off, the workspace is not yet onboarded, there is nothing reviewable in the
 * working tree, an equivalent review already covers the change (dedupe), or the
 * `codex` CLI is absent.
 *
 * The hook no longer renders the review prompt itself — it dispatches review
 * METADATA plus the redactable builder's-message text; the detached worker
 * assembles the prompt and redacts that text from state once it has read it.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { dispatchBackgroundReview } from "./lib/auto-review.mjs";
import { getCodexAvailability } from "./lib/codex.mjs";
import { getWorkingTreeState } from "./lib/git.mjs";
import { getConfig, isOnboarded } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const PROJECT_INSTRUCTIONS_FILE = ".codex-autoreview.md";

/**
 * Read and parse the hook's stdin JSON. A missing, empty, or MALFORMED stdin
 * payload yields `null` — the caller treats that as a clean no-op (exit 0, no
 * dispatch) rather than crashing the hook.
 *
 * @returns {Record<string, unknown> | null}
 */
function readHookInput() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed) : null;
  } catch {
    // Malformed JSON on stdin — a clean no-op, never a crash.
    return null;
  }
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
 * Resolve the project's `.codex-autoreview.md` path when one exists at the
 * workspace root, else `null`. Passed through to the worker's prompt assembler.
 *
 * @param {string} workspaceRoot
 * @returns {string | null}
 */
function resolveProjectInstructionsPath(workspaceRoot) {
  const candidate = path.join(workspaceRoot, PROJECT_INSTRUCTIONS_FILE);
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function main() {
  const input = readHookInput();
  // Malformed / empty stdin — clean no-op.
  if (!input) {
    return;
  }

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

  // Onboarding gate: until the guided onboarding flow has completed for this
  // workspace, the review hooks no-op. The SessionStart onboarding hook keeps
  // reminding the user; this is not a hard error.
  if (!isOnboarded(workspaceRoot)) {
    logNote(
      "codex-autoreview: code review skipped — finish onboarding first (run /codex-autoreview:onboard)."
    );
    return;
  }

  // Codex availability is only a precondition when the configured backend
  // actually needs the Codex CLI. An `external` backend reviews without it, so
  // gating on Codex there would silently skip every automatic review (F-03).
  const availability = getCodexAvailability(cwd);
  if (!availability.available && config.backend !== "external") {
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
  const claudeResponseBlock = String(input.last_assistant_message ?? "").trim();
  const dispatch = dispatchBackgroundReview({
    cwd,
    kind: "code",
    // The hook no longer renders the prompt — it hands over the redactable
    // builder's-message text and lets the worker assemble.
    claudeResponseBlock: claudeResponseBlock || undefined,
    projectInstructionsPath: resolveProjectInstructionsPath(workspaceRoot),
    trigger: "stop",
    config,
    sessionId: typeof input.session_id === "string" ? input.session_id : null
  });

  if (!dispatch.dispatched) {
    if (dispatch.deduped) {
      logNote(
        `codex-autoreview: code review skipped — ${dispatch.detail ?? "an equivalent review already covers this change."}`
      );
      return;
    }
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
