/**
 * Git helpers — repository detection and working-tree change inspection.
 *
 * Vendored and trimmed from codex-plugin-cc
 * (plugins/codex/scripts/lib/git.mjs), Copyright 2026 OpenAI,
 * licensed under the Apache License, Version 2.0. See ../../NOTICE.
 *
 * @file
 */

import { runCommand } from "./process.mjs";

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {ReturnType<typeof runCommand>}
 */
function git(cwd, args) {
  return runCommand("git", args, { cwd });
}

/**
 * Resolve the git repository root for `cwd`, or throw if not a repo.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

/**
 * Inspect the working tree for staged, unstaged, and untracked changes.
 *
 * Returns `isDirty: false` (and empty arrays) when `cwd` is not a git
 * repository or git is unavailable, so callers can treat "nothing to
 * review" and "no git" the same way.
 *
 * @param {string} cwd
 * @returns {{ staged: string[], unstaged: string[], untracked: string[], isDirty: boolean }}
 */
export function getWorkingTreeState(cwd) {
  const empty = { staged: [], unstaged: [], untracked: [], isDirty: false };

  const stagedResult = git(cwd, ["diff", "--cached", "--name-only"]);
  if (stagedResult.error || stagedResult.status !== 0) {
    return empty;
  }
  const unstagedResult = git(cwd, ["diff", "--name-only"]);
  if (unstagedResult.error || unstagedResult.status !== 0) {
    return empty;
  }
  const untrackedResult = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (untrackedResult.error || untrackedResult.status !== 0) {
    return empty;
  }

  const staged = stagedResult.stdout.trim().split("\n").filter(Boolean);
  const unstaged = unstagedResult.stdout.trim().split("\n").filter(Boolean);
  const untracked = untrackedResult.stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}
