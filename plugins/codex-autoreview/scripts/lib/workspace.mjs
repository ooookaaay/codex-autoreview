/**
 * Workspace-root resolution.
 *
 * Vendored from codex-plugin-cc (plugins/codex/scripts/lib/workspace.mjs),
 * Copyright 2026 OpenAI, licensed under the Apache License, Version 2.0.
 * See ../../NOTICE.
 *
 * @file
 */

import { ensureGitRepository } from "./git.mjs";

/**
 * Resolve the workspace root for `cwd`. Falls back to `cwd` itself when it is
 * not inside a git repository, so per-project state still has a stable home.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
