#!/usr/bin/env node
/**
 * PreToolUse / ExitPlanMode hook.
 *
 * When the per-project toggle is on AND the workspace is onboarded, sends
 * Claude's plan to Codex for a devil's-advocate review. The review runs as a
 * detached background job; this hook dispatches it and returns immediately. It
 * never emits a permission decision, so plan-mode exit is never blocked.
 *
 * No-ops cleanly when: stdin is missing/empty/malformed JSON, the toggle is
 * off, the workspace is not yet onboarded, the plan is too small to be worth a
 * review, an equivalent review already covers this plan (dedupe), or the
 * `codex` CLI is absent.
 *
 * The hook no longer renders the review prompt itself — it dispatches review
 * METADATA plus the redactable plan text; the detached worker assembles the
 * prompt and redacts the plan text from state as soon as it has read it.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { dispatchBackgroundReview } from "./lib/auto-review.mjs";
import { getCodexAvailability } from "./lib/codex.mjs";
import { getConfig, isOnboarded } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const MIN_REVIEWABLE_PLAN_CHARS = 240;
const PROJECT_INSTRUCTIONS_FILE = ".codex-autoreview.md";

// F-02: a `planFilePath` from the tool input is untrusted. Cap how much of it
// we will ever read so a crafted payload pointing at a huge file cannot blow up
// the reviewer prompt. Oversized plan files are TRUNCATED (not rejected) to
// match the established pattern in `lib/prompts.mjs` (`readProjectInstructions`).
const MAX_PLAN_FILE_CHARS = 256 * 1024;

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
 * Safely read an untrusted `planFilePath` from the tool input (F-02).
 *
 * The path is attacker-influenceable: a crafted hook payload could point it at
 * an arbitrary local file and exfiltrate its contents into the reviewer prompt.
 * Before reading we require, in order:
 *
 *   1. Workspace containment — the path (absolute, or relative to
 *      `workspaceRoot`) must `fs.realpathSync` to something that stays inside
 *      `workspaceRoot`. The realpath check also defeats symlink escapes.
 *   2. Size cap — files over {@link MAX_PLAN_FILE_CHARS} are read-and-truncated
 *      (matching `readProjectInstructions` in `lib/prompts.mjs`), never used
 *      whole.
 *
 * Any validation failure is a clean no-op: returns `""`, never throws — the
 * hook's contract is that it must never block the session.
 *
 * @param {string} planFilePath - Raw, untrusted path from `tool_input`.
 * @param {string} workspaceRoot - Resolved workspace root to contain reads to.
 * @returns {string}
 */
function readPlanFile(planFilePath, workspaceRoot) {
  try {
    const root = fs.realpathSync(workspaceRoot);
    // Resolve relative paths against the workspace root, not process.cwd().
    const resolvedInput = path.resolve(root, planFilePath);
    // realpath collapses symlinks; if the real target escapes the workspace,
    // the containment check below rejects it.
    const realPath = fs.realpathSync(resolvedInput);
    const contained =
      realPath === root || realPath.startsWith(root + path.sep);
    if (!contained) {
      logNote(
        "codex-autoreview: plan review skipped — planFilePath resolves outside the workspace."
      );
      return "";
    }

    const stats = fs.statSync(realPath);
    if (!stats.isFile()) {
      return "";
    }

    const raw = fs.readFileSync(realPath, "utf8");
    if (raw.length > MAX_PLAN_FILE_CHARS) {
      return `${raw
        .slice(0, MAX_PLAN_FILE_CHARS)
        .trim()}\n\n[... plan file truncated at ${MAX_PLAN_FILE_CHARS} chars ...]`;
    }
    return raw.trim();
  } catch {
    // Missing file, unreadable path, broken symlink, permission error — all
    // collapse to a clean no-op.
    return "";
  }
}

/**
 * Extract the plan text from the ExitPlanMode tool input.
 *
 * @param {Record<string, unknown>} input
 * @param {string} workspaceRoot - Resolved workspace root; bounds file reads.
 * @returns {string}
 */
function extractPlanText(input, workspaceRoot) {
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
    return readPlanFile(planFilePath, workspaceRoot);
  }

  return "";
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
      "codex-autoreview: plan review skipped — finish onboarding first (run /codex-autoreview:onboard)."
    );
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

  const planText = extractPlanText(input, workspaceRoot);
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
    // The hook no longer renders the prompt — it hands over the redactable plan
    // text and lets the worker assemble (and the F4 planHash anchors to the
    // plan itself, not a prompt-wrapped form).
    planText,
    projectInstructionsPath: resolveProjectInstructionsPath(workspaceRoot),
    trigger: "exit-plan-mode",
    config,
    sessionId: typeof input.session_id === "string" ? input.session_id : null
  });

  if (!dispatch.dispatched) {
    if (dispatch.deduped) {
      logNote(
        `codex-autoreview: plan review skipped — ${dispatch.detail ?? "an equivalent review already covers this plan."}`
      );
      return;
    }
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
