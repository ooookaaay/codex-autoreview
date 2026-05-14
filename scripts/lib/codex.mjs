/**
 * Codex CLI integration for codex-autoreview.
 *
 * Design decision: this plugin shells out to `codex exec` rather than vendoring
 * the full `codex app-server` JSON-RPC client stack. The narrow review use case
 * only needs to (a) fire one review prompt at Codex, (b) capture the final
 * verdict text, (c) persist it. `codex exec` exposes exactly that surface
 * (`--model`, `-c model_reasoning_effort=`, `--cd`, `--output-last-message`,
 * `--skip-git-repo-check`, `--sandbox read-only`) with a far smaller dependency
 * closure and no broker/thread lifecycle to maintain. All Codex interaction is
 * isolated in this module.
 *
 * This file is original to codex-autoreview, but the model/effort defaults and
 * the reasoning-effort value set follow codex-plugin-cc's conventions.
 *
 * @file
 */

import process from "node:process";
import { spawn } from "node:child_process";

import { binaryAvailable, runCommand } from "./process.mjs";

/**
 * Label shown for the model/effort when the project has not set an override.
 *
 * The plugin intentionally does NOT hardcode a default model: a hardcoded model
 * (e.g. `gpt-5.4-codex`) is rejected outright on some accounts — a ChatGPT-auth
 * Codex only accepts the models that account is entitled to. When unset, the
 * plugin omits `--model` / `model_reasoning_effort` entirely and lets the user's
 * own `~/.codex/config.toml` default decide. That is the robust default.
 */
export const CODEX_DEFAULT_LABEL = "codex default";

/**
 * Reasoning-effort values the Codex CLI accepts. Note the history: `xhigh` was
 * briefly mis-documented upstream; the codex-plugin-cc reference impl settled on
 * this exact set, validated against `codex` config.
 */
export const VALID_REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);

/**
 * Resolve the Codex model override, or `null` when none is configured (meaning
 * "let codex use its own config default").
 *
 * @param {{ model?: unknown }} config
 * @returns {string | null}
 */
export function resolveReviewModel(config) {
  const configured =
    config && typeof config.model === "string" ? config.model.trim() : "";
  return configured || null;
}

/**
 * Resolve the Codex reasoning-effort override, or `null` when none is configured
 * (meaning "let codex use its own config default").
 *
 * @param {{ effort?: unknown }} config
 * @returns {string | null}
 */
export function resolveReviewEffort(config) {
  const configured =
    config && typeof config.effort === "string" ? config.effort.trim() : "";
  return configured || null;
}

/**
 * Normalize and validate a reasoning-effort value. Returns `null` for an empty
 * input (meaning "clear the override"), throws on an unsupported value.
 *
 * @param {unknown} effort
 * @returns {string | null}
 */
export function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.includes(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: ${VALID_REASONING_EFFORTS.join(", ")}.`
    );
  }
  return normalized;
}

/**
 * Normalize a requested model string. Returns `null` for empty input.
 *
 * @param {unknown} model
 * @returns {string | null}
 */
export function normalizeModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  return normalized || null;
}

/**
 * Check whether the `codex` CLI is available on PATH.
 *
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ available: boolean, detail: string }}
 */
export function getCodexAvailability(cwd, options = {}) {
  return binaryAvailable("codex", ["--version"], {
    cwd,
    env: options.env ?? process.env
  });
}

/**
 * Build the `codex exec` argument vector for a review run.
 *
 * `model` and `effort` are optional: when `null`/empty the corresponding flag
 * is omitted so `codex` falls back to the user's own `~/.codex/config.toml`
 * default. This avoids passing a hardcoded model that the account may reject.
 *
 * @param {object} params
 * @param {string | null} [params.model]
 * @param {string | null} [params.effort]
 * @param {string} params.cwd
 * @param {string} params.outputFile - Where Codex writes its final message.
 * @returns {string[]}
 */
export function buildCodexExecArgs(params) {
  const args = ["exec"];
  if (params.model) {
    args.push("--model", params.model);
  }
  if (params.effort) {
    args.push("-c", `model_reasoning_effort=${params.effort}`);
  }
  args.push(
    "--cd",
    params.cwd,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--output-last-message",
    params.outputFile
  );
  return args;
}

/**
 * Run `codex exec` synchronously with the review prompt on stdin and return the
 * captured final message. Used by the detached background worker — never by a
 * hook directly, because it blocks until Codex finishes.
 *
 * The authoritative verdict text is the `--output-last-message` file, which the
 * caller reads. `codex exec` prints its session transcript to stderr (banner,
 * `ERROR: {...}` lines, etc.); stdout is typically empty. This function surfaces
 * both streams plus the exit status so the worker can decide success/failure.
 *
 * @param {object} params
 * @param {string} params.cwd
 * @param {string} params.prompt
 * @param {string | null} [params.model]
 * @param {string | null} [params.effort]
 * @param {string} params.outputFile
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {{ status: number, stdout: string, stderr: string, signal: string | null, error: Error | null }}
 */
export function runCodexReview(params) {
  const args = buildCodexExecArgs({
    model: params.model ?? null,
    effort: params.effort ?? null,
    cwd: params.cwd,
    outputFile: params.outputFile
  });

  const result = runCommand("codex", args, {
    cwd: params.cwd,
    env: params.env ?? process.env,
    input: params.prompt,
    maxBuffer: 32 * 1024 * 1024
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    signal: result.signal,
    error: result.error
  };
}

/**
 * Spawn a fully detached process and return immediately. The child keeps
 * running after the parent exits; the parent never waits on it.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ pid: number | null }}
 */
export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return { pid: child.pid ?? null };
}

/**
 * Extract the verdict line (the first non-empty line of Codex's final message,
 * which the prompt contract pins to `SOUND:`/`CONCERNS:`/`CLEAN:`/`ISSUES:`).
 *
 * @param {string} finalMessage
 * @returns {string | null}
 */
export function extractVerdictLine(finalMessage) {
  const line = String(finalMessage ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? null;
}
