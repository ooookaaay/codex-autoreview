/**
 * Process / child-process helpers.
 *
 * Vendored and trimmed from codex-plugin-cc
 * (plugins/codex/scripts/lib/process.mjs), Copyright 2026 OpenAI,
 * licensed under the Apache License, Version 2.0. See ../../NOTICE.
 *
 * @file
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Run a command synchronously and capture its result without throwing.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string, maxBuffer?: number, stdio?: import("node:child_process").StdioOptions }} [options]
 * @returns {{ command: string, args: string[], status: number, signal: string | null, stdout: string, stderr: string, error: Error | null }}
 */
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? process.env.SHELL || true : false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

/**
 * Run a command and throw if it fails.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {Parameters<typeof runCommand>[2]} [options]
 * @returns {ReturnType<typeof runCommand>}
 */
export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

/**
 * Probe whether a binary is on PATH and runnable.
 *
 * @param {string} command
 * @param {string[]} [versionArgs]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ available: boolean, detail: string }}
 */
export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

/**
 * Format a failed command result into a single-line error string.
 *
 * @param {ReturnType<typeof runCommand>} result
 * @returns {string}
 */
export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
