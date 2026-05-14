#!/usr/bin/env node
/**
 * Pre-push review hook — a `PreToolUse` hook matching `Bash`.
 *
 * There is NO native "pre-push" hook event in Claude Code (confirmed in the
 * platform research). This hook is the recommended Option A: it fires on every
 * `Bash` tool call, fast-paths anything that is not a `git push`, and on a
 * detected push DISPATCHES a background code review of the about-to-push
 * working-tree changes.
 *
 * The hook is strictly NON-BLOCKING and advisory:
 *   - it NEVER emits a `permissionDecision` (an `allow` would bypass Claude
 *     Code's permission system, an `deny`/`ask` would gate the push) — it just
 *     exits 0 with empty stdout so the normal Bash permission flow continues;
 *   - the review it dispatches is the same detached, fire-and-forget code
 *     review the Stop hook dispatches, and it goes through the SAME dedupe
 *     (`dispatchBackgroundReview`), so a push right after a Stop review does
 *     not double-spend a codex call on the identical change.
 *
 * Like the other review hooks it no-ops cleanly on malformed stdin, when the
 * toggle is off, when the workspace is not onboarded, when there is nothing to
 * review, or when the `codex` CLI is absent.
 *
 * Human pushes from a separate terminal are out of scope — this only sees
 * pushes Claude itself runs.
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
 * @param {string} [message]
 */
function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

/** Token regexes for the shell-aware `git push` detector. */
const RE_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** git global options that take a SEPARATE value token (skip the value). */
const RE_GIT_VALUE_OPT = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--exec-path)$/;
/** git global options with an INLINE `=value` (single token). */
const RE_GIT_INLINE_VALUE_OPT =
  /^(?:--git-dir|--work-tree|--namespace|--config-env|--exec-path)=/;
/** A `--dry-run` push, or a short-option bundle containing `n` — not a real push. */
const RE_DRY_RUN_OPT = /^(?:--dry-run|-[A-Za-z]*n[A-Za-z]*)$/;

/**
 * Tokenize a single simple shell command, respecting single/double quotes and
 * backslash escapes. Quoted runs stay attached to their token; this is how
 * `echo "git push"` tokenizes to `["echo", "git push"]` — the `git push` lives
 * inside ONE quoted token and never looks like a command of its own.
 *
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeSimpleCommand(command) {
  /** @type {string[]} */
  const tokens = [];
  let current = "";
  let hasToken = false;
  /** @type {null | '"' | "'"} */
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (quote) {
      if (ch === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      hasToken = true;
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Split a compound shell command into its simple commands on UNQUOTED command
 * separators (`&&`, `||`, `;`, `|`, newline). Quoted separators are left intact
 * so `git commit -m "a; b"` is not split mid-message.
 *
 * @param {string} command
 * @returns {string[]}
 */
function splitSimpleCommands(command) {
  /** @type {string[]} */
  const parts = [];
  let current = "";
  /** @type {null | '"' | "'"} */
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    const next = command[index + 1];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && next != null) {
        current += next;
        index += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && next != null) {
      current += ch + next;
      index += 1;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      // `&&`, `||` and `|` collapse to a single separator; `;`/newline too.
      if ((ch === "&" || ch === "|") && next === ch) {
        index += 1;
      }
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Whether a Bash command string contains a real `git push` invocation.
 *
 * Shell-aware (consulted `codex` for the rules): it splits on unquoted command
 * separators, tokenizes each simple command respecting quotes, skips leading
 * `FOO=bar` env assignments and an `env` prefix, requires the executable token
 * to be exactly `git` (so `echo git push` does NOT match), skips git global
 * options like `-C dir` / `-c k=v`, then requires the subcommand token to be
 * exactly `push`. A `--dry-run` / `-n` push is treated as NOT a push.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function commandContainsGitPush(command) {
  if (typeof command !== "string" || !command.trim()) {
    return false;
  }
  for (const simple of splitSimpleCommands(command)) {
    if (!simple.trim()) {
      continue;
    }
    let tokens = tokenizeSimpleCommand(simple);
    // Skip leading `FOO=bar` env assignments.
    while (tokens.length > 0 && RE_ASSIGNMENT.test(tokens[0])) {
      tokens = tokens.slice(1);
    }
    // Skip an `env` prefix (and any assignments / `-` options that follow it).
    if (tokens.length > 0 && tokens[0] === "env") {
      tokens = tokens.slice(1);
      while (
        tokens.length > 0 &&
        (RE_ASSIGNMENT.test(tokens[0]) || tokens[0].startsWith("-"))
      ) {
        tokens = tokens.slice(1);
      }
    }
    if (tokens.length === 0) {
      continue;
    }
    // The executable must be exactly `git` (allow an absolute/relative path to
    // a `git` binary, but not `mygit` or `echo`).
    const exe = path.basename(tokens[0]);
    if (exe !== "git") {
      continue;
    }
    let rest = tokens.slice(1);
    // Skip git GLOBAL options that precede the subcommand.
    while (rest.length > 0) {
      const token = rest[0];
      if (RE_GIT_VALUE_OPT.test(token)) {
        // Option + its separate value token.
        rest = rest.slice(2);
        continue;
      }
      if (RE_GIT_INLINE_VALUE_OPT.test(token) || token === "--no-pager" || token === "-p" || token === "--paginate") {
        rest = rest.slice(1);
        continue;
      }
      if (token.startsWith("-")) {
        // Some other global flag — skip it conservatively.
        rest = rest.slice(1);
        continue;
      }
      break;
    }
    if (rest.length === 0 || rest[0] !== "push") {
      continue;
    }
    // A dry-run push is not a real push.
    const pushArgs = rest.slice(1);
    if (pushArgs.some((arg) => RE_DRY_RUN_OPT.test(arg))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Resolve the project's `.codex-autoreview.md` path when one exists at the
 * workspace root, else `null`.
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
  // Malformed / empty stdin — clean no-op (the Bash call proceeds unchanged).
  if (!input) {
    return;
  }

  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? /** @type {Record<string, unknown>} */ (input.tool_input)
      : {};
  const command = typeof toolInput.command === "string" ? toolInput.command : "";

  // FAST PATH: the overwhelming majority of Bash calls are not a `git push` —
  // bail immediately so this hook is cheap on every other Bash invocation.
  if (!commandContainsGitPush(command)) {
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

  // Onboarding gate — same as the other review hooks.
  if (!isOnboarded(workspaceRoot)) {
    return;
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    const detail = availability.detail ? ` ${availability.detail}.` : "";
    logNote(
      `codex-autoreview: Codex CLI is not available for the pre-push review.${detail}`
    );
    return;
  }

  // Nothing to review — a push of an already-clean tree.
  const workingTree = getWorkingTreeState(cwd);
  if (!workingTree.isDirty) {
    return;
  }

  // Dispatch the same detached, non-blocking code review the Stop hook uses.
  // `dispatchBackgroundReview` applies the dedupe, so a push immediately after
  // a Stop review of the identical change does NOT re-spend a codex call.
  const dispatch = dispatchBackgroundReview({
    cwd,
    kind: "code",
    projectInstructionsPath: resolveProjectInstructionsPath(workspaceRoot),
    trigger: "pre-push",
    config,
    sessionId: typeof input.session_id === "string" ? input.session_id : null
  });

  if (!dispatch.dispatched) {
    if (dispatch.deduped) {
      logNote(
        `codex-autoreview: pre-push review skipped — ${dispatch.detail ?? "an equivalent review already covers this change."}`
      );
      return;
    }
    logNote(
      dispatch.detail
        ? `codex-autoreview: pre-push review dispatch failed: ${dispatch.detail}`
        : "codex-autoreview: pre-push review dispatch failed."
    );
    return;
  }

  const label = dispatch.reviewId ? ` (${dispatch.reviewId})` : "";
  logNote(
    `codex-autoreview: Codex code review of the about-to-push changes started in the background${label}. The push is not blocked; run /codex-autoreview:last to see the verdict.`
  );
}

try {
  main();
} catch (error) {
  // NEVER block the push on a hook failure — surface on stderr, exit 0.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-autoreview pre-push hook: ${message}\n`);
}
