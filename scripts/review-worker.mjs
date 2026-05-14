#!/usr/bin/env node
/**
 * Detached background review worker.
 *
 * Spawned by `lib/auto-review.mjs` with `--cwd` and `--review-id`. Reads the
 * queued review record (which carries the prompt + model + effort), runs
 * `codex exec` to completion, and writes the verdict back into the per-project
 * state. This process is detached from the Claude session, so it is free to
 * block on Codex for as long as the review takes.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { extractVerdictLine, getCodexAvailability, runCodexReview } from "./lib/codex.mjs";
import {
  ensureStateDir,
  listReviews,
  resolveReviewsDir,
  upsertReview
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--cwd" || token === "--review-id") {
      const key = token === "--cwd" ? "cwd" : "reviewId";
      options[key] = argv[index + 1] ?? "";
      index += 1;
    }
  }
  return options;
}

/**
 * Pull a human-readable error out of `codex exec` stderr. The CLI emits machine
 * errors as `ERROR: {"type":"error",...,"error":{"message":"..."}}` lines;
 * extract the inner message when present, otherwise return the last few
 * non-empty stderr lines.
 *
 * @param {string} stderr
 * @returns {string | null}
 */
function extractCodexError(stderr) {
  const text = String(stderr ?? "").trim();
  if (!text) {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^ERROR:\s*(\{.*\})\s*$/);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        const message = parsed?.error?.message ?? parsed?.message;
        if (typeof message === "string" && message.trim()) {
          return `codex error: ${message.trim()}`;
        }
      } catch {
        // Fall through to the generic tail handling.
      }
      return `codex error: ${match[1]}`;
    }
  }
  const tail = lines.filter(Boolean).slice(-3).join(" ");
  return tail || null;
}

/**
 * @param {string} logFile
 * @param {string} message
 */
function appendLog(logFile, message) {
  if (!logFile) {
    return;
  }
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Logging is best-effort; never let it crash the worker.
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = options.cwd || process.cwd();
  const reviewId = options.reviewId;
  if (!reviewId) {
    process.stderr.write("review-worker: missing --review-id\n");
    process.exitCode = 1;
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  ensureStateDir(workspaceRoot);

  const review = listReviews(workspaceRoot).find((entry) => entry.id === reviewId);
  if (!review) {
    process.stderr.write(`review-worker: no queued review found for ${reviewId}\n`);
    process.exitCode = 1;
    return;
  }

  const request = review.request;
  if (!request || typeof request !== "object" || typeof request.prompt !== "string") {
    upsertReview(workspaceRoot, {
      id: reviewId,
      status: "failed",
      errorMessage: "Queued review is missing its request payload."
    });
    process.exitCode = 1;
    return;
  }

  const logFile = review.logFile || path.join(resolveReviewsDir(workspaceRoot), `${reviewId}.log`);
  const outputFile = path.join(resolveReviewsDir(workspaceRoot), `${reviewId}.output.txt`);

  appendLog(logFile, `Starting ${review.kind} review with model=${request.model} effort=${request.effort}.`);
  upsertReview(workspaceRoot, { id: reviewId, status: "running" });

  const availability = getCodexAvailability(request.cwd ?? cwd);
  if (!availability.available) {
    const detail = availability.detail ? ` (${availability.detail})` : "";
    appendLog(logFile, `Codex CLI unavailable${detail}.`);
    upsertReview(workspaceRoot, {
      id: reviewId,
      status: "failed",
      errorMessage: `Codex CLI is not available${detail}.`
    });
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = runCodexReview({
      cwd: request.cwd ?? cwd,
      prompt: request.prompt,
      model: request.model,
      effort: request.effort,
      outputFile,
      env: process.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(logFile, `codex exec threw: ${message}`);
    upsertReview(workspaceRoot, {
      id: reviewId,
      status: "failed",
      errorMessage: `codex exec failed: ${message}`
    });
    process.exitCode = 1;
    return;
  }

  // The authoritative verdict is the --output-last-message file. `codex exec`
  // prints its session transcript to stderr (not stdout) and may exit non-zero
  // even when it produced a partial answer, so the file — not the exit code —
  // is the source of truth for "did we get a verdict".
  let finalMessage = "";
  try {
    if (fs.existsSync(outputFile)) {
      finalMessage = fs.readFileSync(outputFile, "utf8").trim();
    }
  } catch {
    finalMessage = "";
  }

  if (!finalMessage) {
    const detail =
      (result.error &&
        (result.error instanceof Error ? result.error.message : String(result.error))) ||
      extractCodexError(result.stderr) ||
      (result.signal ? `codex exec was killed (signal ${result.signal})` : null) ||
      `codex exec exited with status ${result.status} and produced no verdict`;
    appendLog(logFile, `Review failed: ${detail}`);
    upsertReview(workspaceRoot, {
      id: reviewId,
      status: "failed",
      output: null,
      errorMessage: detail
    });
    process.exitCode = result.status === 0 ? 1 : result.status || 1;
    return;
  }

  const verdict = extractVerdictLine(finalMessage);
  appendLog(logFile, `Review completed. Verdict: ${verdict ?? "(none)"}`);
  upsertReview(workspaceRoot, {
    id: reviewId,
    status: "completed",
    verdict,
    output: finalMessage,
    errorMessage: null
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
