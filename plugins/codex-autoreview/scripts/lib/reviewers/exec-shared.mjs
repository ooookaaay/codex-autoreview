/**
 * Shared helpers for the codex `exec-*` reviewer backends.
 *
 * The `exec-generic` and `exec-review` backends both shell out to `codex` and
 * both reuse the SAME hang-protection machinery
 * ({@link runCodexReview} → detached process group, hard wall-clock timeout,
 * SIGTERM→SIGKILL tree kill, `onChild` reaping). This module factors out the
 * pieces both need so neither backend re-implements them.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";

import { computeCostUsd } from "../pricing.mjs";
import {
  normalizeUsage,
  renderCompactText,
  renderVerdictLine
} from "../review-schema.mjs";

/**
 * Read a `codex exec --output-last-message` file, trimmed. Returns `""` when
 * the file is missing or unreadable — the worker treats an empty final message
 * as "no verdict produced" (the authoritative signal, not the exit code).
 *
 * @param {string} outputFile
 * @returns {string}
 */
export function readOutputFile(outputFile) {
  try {
    if (outputFile && fs.existsSync(outputFile)) {
      return fs.readFileSync(outputFile, "utf8").trim();
    }
  } catch {
    // fall through
  }
  return "";
}

/**
 * Extract a human-readable error from `codex exec` stderr. The CLI emits
 * machine errors as `ERROR: {"type":"error",...,"error":{"message":"..."}}`
 * lines; pull the inner message when present, else return the last few
 * non-empty stderr lines. (Mirrors the worker's previous `extractCodexError`.)
 *
 * @param {string} stderr
 * @returns {string | null}
 */
export function extractCodexStderrError(stderr) {
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
        // fall through
      }
      return `codex error: ${match[1]}`;
    }
  }
  const tail = lines.filter(Boolean).slice(-3).join(" ");
  return tail || null;
}

/**
 * Build the F2 `usage` block for a {@link import("../review-schema.mjs").ReviewResult}
 * from a parsed `codex exec --json` token stream plus the resolved model.
 *
 * Cost is computed via {@link computeCostUsd}: an unknown model yields
 * `costUsd: null` (honest "cost unknown"), never a throw, never a misleading
 * `$0`. Returns `null` when there is no usable token data at all (e.g. the
 * `exec-review` subcommand, whose usage is all-zeros — see the research).
 *
 * @param {object} params
 * @param {{ tokensIn: number, tokensCachedIn: number, tokensOut: number, tokensReasoningOut?: number } | null} params.streamUsage
 * @param {string} params.model - Resolved model id used for the run.
 * @param {import("../pricing.mjs").ModelRate | null} [params.rateOverride]
 * @returns {import("../review-schema.mjs").ReviewUsage | null}
 */
export function buildUsageBlock(params) {
  const streamUsage = params && params.streamUsage ? params.streamUsage : null;
  if (!streamUsage) {
    return null;
  }
  const tokensIn = streamUsage.tokensIn ?? 0;
  const tokensOut = streamUsage.tokensOut ?? 0;
  if (tokensIn === 0 && tokensOut === 0) {
    return null;
  }
  const tokensCachedIn = streamUsage.tokensCachedIn ?? 0;
  const cost = computeCostUsd({
    model: params.model,
    usage: { tokensIn, tokensCachedIn, tokensOut },
    rateOverride: params.rateOverride ?? null
  });
  return normalizeUsage({
    tokensIn,
    tokensCachedIn,
    tokensOut,
    costUsd: cost.costUsd,
    costEstimated: cost.costEstimated,
    model: typeof params.model === "string" ? params.model : "",
    pricedWith: cost.pricedWith
  });
}

/**
 * Finalize a {@link import("../review-schema.mjs").ReviewResult} into the
 * worker-facing {@link import("./index.mjs").ParsedReview} shape: render the
 * compact text + verdict line FROM the JSON so what the worker persists as
 * `verdict`/`output` is always derived, never hand-rolled.
 *
 * @param {object} params
 * @param {import("../review-schema.mjs").ReviewResult} params.result
 * @param {boolean} [params.degraded] - `true` for prose-only backends whose
 *   structured fields could not be fully populated (e.g. `exec-review`).
 * @param {string | null} [params.errorMessage]
 * @returns {import("./index.mjs").ParsedReview}
 */
export function finalizeParsedReview(params) {
  const result = params.result;
  return {
    ok: true,
    verdict: renderVerdictLine(result),
    output: renderCompactText(result),
    result,
    usage: result.usage ?? null,
    degraded: Boolean(params.degraded),
    errorMessage: params.errorMessage ?? null
  };
}

/**
 * Build a failed {@link import("./index.mjs").ParsedReview}. Used when a
 * backend cannot produce any verdict at all.
 *
 * @param {string} errorMessage
 * @returns {import("./index.mjs").ParsedReview}
 */
export function failedParsedReview(errorMessage) {
  return {
    ok: false,
    verdict: null,
    output: null,
    result: null,
    usage: null,
    degraded: false,
    errorMessage: errorMessage || "Review failed."
  };
}

/**
 * Resolve an absolute path for a per-review temp artifact (output file, schema
 * file) inside the reviews dir, given a base dir and a suffix.
 *
 * @param {string} reviewsDir
 * @param {string} reviewId
 * @param {string} suffix - e.g. `"output.txt"`, `"schema.json"`.
 * @returns {string}
 */
export function reviewArtifactPath(reviewsDir, reviewId, suffix) {
  return path.join(reviewsDir, `${reviewId}.${suffix}`);
}
