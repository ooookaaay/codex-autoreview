/**
 * Git helpers — repository detection, working-tree change inspection, and the
 * F4 anchoring primitives (diff fingerprint, plan hash).
 *
 * Vendored and trimmed from codex-plugin-cc
 * (plugins/codex/scripts/lib/git.mjs), Copyright 2026 OpenAI,
 * licensed under the Apache License, Version 2.0. See ../../NOTICE.
 *
 * @file
 */

import { createHash } from "node:crypto";

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

/**
 * Prefix marking a value produced by {@link sha256} — kept on the wire so a
 * fingerprint is self-describing and the review schema can validate it
 * (`reviewedInputHash` pattern is `^sha256-[0-9a-f]{64}$`).
 */
export const FINGERPRINT_PREFIX = "sha256-";

/**
 * Hash an arbitrary string into the plugin's canonical `sha256-<hex>` form.
 * The single hashing primitive behind both {@link computeDiffFingerprint} and
 * {@link computePlanHash}, so every anchor in the plugin has one shape.
 *
 * @param {string} input
 * @returns {string}
 */
export function sha256(input) {
  return FINGERPRINT_PREFIX + createHash("sha256").update(String(input ?? ""), "utf8").digest("hex");
}

/**
 * Compute a deterministic fingerprint of the repository's current uncommitted
 * change set — the F4 anchoring primitive for code reviews.
 *
 * The fingerprint folds together everything that defines "what is being
 * reviewed right now":
 *   - `HEAD` — the base commit the change sits on;
 *   - the set of changed files (staged + unstaged + untracked), sorted, so the
 *     fingerprint is order-independent;
 *   - a hash of the actual unified diff content (staged + unstaged), so an
 *     edit that changes a file's content — not just its name — moves the
 *     fingerprint.
 *
 * Untracked files contribute their PATHS (not content) — `git diff` does not
 * cover them and reading every untracked file would be unbounded; a new or
 * removed untracked path still moves the fingerprint via the changed-files set.
 *
 * Phase 2 dedupe / stale-detection compares this value: a review's
 * `reviewedInputHash` recomputed at settle time that differs from dispatch time
 * means the working tree moved under the review (→ `STALE`).
 *
 * Returns `{ available: false }` (with an empty `fingerprint`) when `cwd` is not
 * a git repo or git is unavailable — callers treat that like "nothing to
 * anchor", never an error.
 *
 * @param {string} cwd
 * @returns {{ available: boolean, fingerprint: string, head: string | null, changedFiles: string[] }}
 */
export function computeDiffFingerprint(cwd) {
  const unavailable = {
    available: false,
    fingerprint: "",
    head: null,
    changedFiles: []
  };

  const headResult = git(cwd, ["rev-parse", "HEAD"]);
  // A repo with no commits yet still has a reviewable working tree; fall back
  // to a stable sentinel so the fingerprint stays well-defined.
  const head =
    !headResult.error && headResult.status === 0 ? headResult.stdout.trim() : null;
  if (headResult.error && "code" in headResult.error && headResult.error.code === "ENOENT") {
    return unavailable;
  }

  const tree = getWorkingTreeState(cwd);

  const stagedDiff = git(cwd, ["diff", "--cached"]);
  const unstagedDiff = git(cwd, ["diff"]);
  if (
    stagedDiff.error ||
    stagedDiff.status !== 0 ||
    unstagedDiff.error ||
    unstagedDiff.status !== 0
  ) {
    // git is present but the diff plumbing failed (e.g. not a repo at all):
    // there is nothing to anchor.
    if (head === null && !tree.isDirty) {
      return unavailable;
    }
  }

  const changedFiles = [...tree.staged, ...tree.unstaged, ...tree.untracked]
    .filter(Boolean)
    .sort();
  // De-duplicate (a file can be both staged and unstaged).
  const uniqueChangedFiles = [...new Set(changedFiles)];

  const diffBody = `${stagedDiff.stdout ?? ""}\n${unstagedDiff.stdout ?? ""}`;
  const canonical = [
    `head:${head ?? "(none)"}`,
    `files:${uniqueChangedFiles.join("\n")}`,
    `diff:${sha256(diffBody)}`
  ].join("\n");

  return {
    available: true,
    fingerprint: sha256(canonical),
    head,
    changedFiles: uniqueChangedFiles
  };
}

/**
 * Compute a deterministic hash of a plan's text — the F4 anchoring primitive
 * for plan reviews. The plan has no git diff to fingerprint; its hash is simply
 * `sha256` of its normalized text (trailing whitespace trimmed, CRLF folded to
 * LF) so cosmetic re-renders of the same plan produce the same hash.
 *
 * @param {string} planText
 * @returns {string}
 */
export function computePlanHash(planText) {
  const normalized = String(planText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return sha256(normalized);
}
