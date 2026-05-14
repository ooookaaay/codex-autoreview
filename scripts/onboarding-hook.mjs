#!/usr/bin/env node
/**
 * SessionStart onboarding hook.
 *
 * On a workspace that has not yet completed the guided onboarding flow
 * (`config.onboardedAt` is null), this hook injects onboarding context so
 * Claude walks the user through plugin setup. Until onboarding completes the
 * review hooks no-op; this hook keeps reminding — it is NOT a hard block.
 *
 * Per-`source` behavior (SessionStart re-runs on startup / resume / clear /
 * compact — consulted `codex` for the cadence):
 *   - `startup`  — inject the FULL guided walkthrough (the first-session UX).
 *   - `clear`    — inject a terse step checklist (`/clear` dropped the prior
 *                  walkthrough from context, so the steps are still needed).
 *   - `resume`   — inject a one-line gentle reminder (the prior transcript
 *                  still carries the walkthrough).
 *   - `compact`  — same one-line reminder (full onboarding every compaction is
 *                  noisy).
 *   - unknown    — treated like `resume`.
 *
 * Once the workspace IS onboarded the hook injects NOTHING — no "active" note;
 * the statusline and commands already surface that state.
 *
 * SessionStart cannot block (blocking errors are ignored) and the injection
 * channel is `hookSpecificOutput.additionalContext`. The hook always exits 0.
 *
 * @file
 */

import fs from "node:fs";
import process from "node:process";

import { isOnboarded } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/**
 * Read and parse the hook's stdin JSON. A missing/empty/malformed payload
 * yields `null` — the hook then behaves as a clean no-op.
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
    return null;
  }
}

/**
 * The full guided-onboarding walkthrough — injected on a fresh `startup`.
 * Phrased as factual ambient context (per the platform research, Claude treats
 * `additionalContext` as context, not an instruction).
 */
const FULL_WALKTHROUGH = [
  "codex-autoreview is installed but this workspace has not been onboarded yet.",
  "Until onboarding completes, the automatic plan/code review hooks stay dormant.",
  "Walk the user through setup, one step at a time, confirming each before moving on:",
  "  1. Codex CLI — confirm `codex` is installed and logged in (`codex --version`;",
  "     `codex login` if needed). The plugin shells out to `codex exec` for reviews.",
  "  2. Enable — turn the plugin on for this project with `/codex-autoreview:config --enable`.",
  "  3. Model & effort — optionally set a review model/effort via",
  "     `/codex-autoreview:config --model <m> --effort <low|medium|high|xhigh>`;",
  "     leaving the model unset lets Codex use the account's own default.",
  "  4. Statusline — optionally add the bundled statusline script to settings.json",
  "     so review status shows in the status line.",
  "  5. Project instructions — optionally create a `.codex-autoreview.md` at the repo",
  "     root with project-specific review guidance / a preferred review profile.",
  "When the user is set up, run `/codex-autoreview:onboard` to mark onboarding complete.",
  "Do not nag — present the steps, help with each, and stop once the user is done."
].join("\n");

/** A compact step checklist — injected on `clear` (context was just dropped). */
const TERSE_CHECKLIST = [
  "codex-autoreview is not onboarded for this workspace; review hooks are dormant.",
  "Onboarding steps: (1) codex CLI installed + logged in, (2) `/codex-autoreview:config --enable`,",
  "(3) optional model/effort, (4) optional statusline, (5) optional `.codex-autoreview.md`.",
  "Run `/codex-autoreview:onboard` to finish. Offer to help if the user wants to set it up."
].join("\n");

/** A one-line gentle reminder — injected on `resume` / `compact` / unknown. */
const ONE_LINE_REMINDER =
  "codex-autoreview is installed but not onboarded for this workspace — its review " +
  "hooks stay dormant until the user runs `/codex-autoreview:onboard`.";

/**
 * The SessionStart `source` values this hook explicitly handles. An unknown /
 * future source is treated like `resume` (see {@link onboardingContextForSource}).
 * @type {readonly ["startup", "resume", "clear", "compact"]}
 */
export const ONBOARDING_SOURCES = Object.freeze(["startup", "resume", "clear", "compact"]);

/**
 * Pick the onboarding context to inject for a given SessionStart `source`.
 * Returns `""` when nothing should be injected.
 *
 * @param {string} source
 * @returns {string}
 */
export function onboardingContextForSource(source) {
  switch (source) {
    case "startup":
      return FULL_WALKTHROUGH;
    case "clear":
      return TERSE_CHECKLIST;
    case "resume":
    case "compact":
      return ONE_LINE_REMINDER;
    default:
      // An unknown / future source is treated like `resume`.
      return ONE_LINE_REMINDER;
  }
}

function main() {
  const input = readHookInput();
  // Malformed / empty stdin — still resolve the workspace from the environment
  // so onboarding context is not silently dropped on a quirky payload.
  const cwd =
    (input && typeof input.cwd === "string" && input.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // Once onboarded — inject nothing at all.
  if (isOnboarded(workspaceRoot)) {
    return;
  }

  const source =
    input && typeof input.source === "string" ? input.source : "startup";
  const context = onboardingContextForSource(source);
  if (!context) {
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context
      }
    })}\n`
  );
}

try {
  main();
} catch (error) {
  // SessionStart cannot block; surface the error on stderr but always exit 0
  // so a hook failure never disrupts session start.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-autoreview onboarding hook: ${message}\n`);
}
