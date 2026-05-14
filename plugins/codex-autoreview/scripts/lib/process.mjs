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
 * `timeoutMs` time-boxes the child: if it exceeds the deadline `spawnSync` kills
 * it (with `killSignal`, default SIGKILL) and the result carries a `timeout`
 * error. This matters for hang protection — a wedged external binary
 * (e.g. `codex --version` hanging) must never block a hook or worker
 * indefinitely.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string, maxBuffer?: number, stdio?: import("node:child_process").StdioOptions, timeoutMs?: number, killSignal?: NodeJS.Signals }} [options]
 * @returns {{ command: string, args: string[], status: number, signal: string | null, stdout: string, stderr: string, error: Error | null, timedOut: boolean }}
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
    windowsHide: true,
    ...(typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? { timeout: options.timeoutMs, killSignal: options.killSignal ?? "SIGKILL" }
      : {})
  });

  // spawnSync surfaces a timeout as an error with code "ETIMEDOUT".
  const timedOut =
    Boolean(result.error) &&
    /** @type {NodeJS.ErrnoException} */ (result.error).code === "ETIMEDOUT";

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
    timedOut
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

/** Default time-box for a binary availability probe (`--version`). */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe whether a binary is on PATH and runnable.
 *
 * The probe is time-boxed (default {@link DEFAULT_PROBE_TIMEOUT_MS}): a binary
 * that hangs on `--version` is treated as unavailable rather than blocking the
 * caller forever — important because this probe runs in hooks and in the
 * background worker before the hard `codex exec` timeout would ever apply.
 *
 * @param {string} command
 * @param {string[]} [versionArgs]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {{ available: boolean, detail: string }}
 */
export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  });
  if (result.timedOut) {
    return {
      available: false,
      detail: `\`${command} ${versionArgs.join(" ")}\` did not respond within ${
        options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
      }ms (treated as unavailable)`
    };
  }
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
