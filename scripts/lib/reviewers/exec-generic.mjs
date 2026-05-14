/**
 * `exec-generic` reviewer backend — the DEFAULT, and today's behavior.
 *
 * Shells out to a generic `codex exec` with the review prompt on stdin and
 * reads the verdict from the `--output-last-message` file. This is the backend
 * the plugin has always used; making it the registry default means the F1
 * migration is non-breaking — an old queued review record with no `backend`
 * field resolves here and behaves bit-for-bit as before.
 *
 * Capability posture (decided via `codex` consult — "Option C, exec-generic as
 * the default full path"): generic `codex exec` is the ONLY Phase 1 backend
 * that can deliver the full claim-based F2 schema, because only it accepts
 * `--output-schema`, and only it reports real `turn.completed.usage` token
 * counts (F6). So `exec-generic` advertises `structuredOutput`, `accurateUsage`
 * — but NOT `reviewScoped` (the caller must construct the diff/prompt itself).
 *
 * Output handling:
 *   - When `runCtx.schemaFile` is set, the final message is schema-constrained
 *     JSON → parsed via {@link normalizeReviewResult} into the full structured
 *     result.
 *   - Otherwise (today's free-form prompt path) the final message is prose with
 *     a pinned verdict first line → {@link fromVerdictLine} produces a valid
 *     minimal result. Either way the worker gets the same `ParsedReview` shape.
 *   - `usage` is merged from the `--json` token stream regardless.
 *
 * @file
 */

import { getCodexAvailability, parseCodexJsonStream, runCodexReview } from "../codex.mjs";
import {
  fromVerdictLine,
  normalizeReviewResult,
  renderVerdictLine
} from "../review-schema.mjs";
import {
  buildUsageBlock,
  extractCodexStderrError,
  failedParsedReview,
  finalizeParsedReview,
  readOutputFile
} from "./exec-shared.mjs";

/** @type {import("./index.mjs").ReviewerBackend} */
export const execGenericBackend = {
  id: "exec-generic",

  capabilities: {
    structuredOutput: true,
    accurateUsage: true,
    reviewScoped: false,
    claimBased: true
  },

  /**
   * @param {import("./index.mjs").ProbeCtx} ctx
   * @returns {{ available: boolean, detail: string }}
   */
  probe(ctx) {
    return getCodexAvailability(ctx.cwd, { env: ctx.env });
  },

  /**
   * @param {import("./index.mjs").RunCtx} ctx
   * @returns {Promise<import("./index.mjs").RawRunResult>}
   */
  async run(ctx) {
    const raw = await runCodexReview({
      cwd: ctx.cwd,
      prompt: ctx.prompt,
      model: ctx.model ?? null,
      effort: ctx.effort ?? null,
      outputFile: ctx.outputFile,
      // F6: --json gives the turn.completed.usage token event.
      json: true,
      // F2: --output-schema constrains the final message to the claim schema,
      // when the worker provided one.
      schemaFile: ctx.schemaFile ?? null,
      timeoutMs: ctx.timeoutMs,
      env: ctx.env,
      onChild: ctx.onChild
    });
    return {
      status: raw.status,
      stdout: raw.stdout,
      stderr: raw.stderr,
      signal: raw.signal,
      error: raw.error,
      timedOut: raw.timedOut,
      timeoutMs: raw.timeoutMs,
      outputFileContent: readOutputFile(ctx.outputFile)
    };
  },

  /**
   * @param {import("./index.mjs").RawRunResult} raw
   * @param {import("./index.mjs").RunCtx} ctx
   * @returns {import("./index.mjs").ParsedReview}
   */
  parse(raw, ctx) {
    if (raw.timedOut) {
      const seconds = Math.round((raw.timeoutMs ?? 0) / 1000);
      return failedParsedReview(`codex exec timed out after ${seconds}s and was killed`);
    }

    const finalMessage = raw.outputFileContent || "";
    const stream = parseCodexJsonStream(raw.stdout);

    if (!finalMessage) {
      const detail =
        (raw.error && (raw.error instanceof Error ? raw.error.message : String(raw.error))) ||
        stream.errorMessage ||
        extractCodexStderrError(raw.stderr) ||
        (raw.signal ? `codex exec was killed (signal ${raw.signal})` : null) ||
        `codex exec exited with status ${raw.status} and produced no verdict`;
      return failedParsedReview(detail);
    }

    // When a schema was requested the final message IS the JSON object; parse
    // it. Otherwise treat it as prose with a pinned verdict first line.
    /** @type {import("../review-schema.mjs").ReviewResult} */
    let result;
    if (ctx.schemaFile) {
      result = normalizeReviewResult(finalMessage, {
        kind: ctx.kind,
        profile: ctx.profile
      });
    } else {
      const verdictLine = finalMessage.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
      result = fromVerdictLine(verdictLine, {
        kind: ctx.kind,
        profile: ctx.profile,
        fullOutput: finalMessage
      });
      // Keep the FULL prose available — the free-form path has no structured
      // findings, so the prose body is the only detail the user gets.
      result.summary = result.summary || verdictLine;
    }

    // F6: merge real token usage from the --json stream. Never trust the model
    // to count its own tokens.
    result.usage = buildUsageBlock({
      streamUsage: stream.usage,
      model: ctx.model ?? "",
      rateOverride: ctx.rateOverride ?? null
    });

    const finalized = finalizeParsedReview({ result, degraded: false });
    // For the free-form path the rendered compact text would lose the prose
    // body (no structured findings) — keep the original prose as `output` so
    // nothing the user would have seen before is dropped.
    if (!ctx.schemaFile) {
      finalized.output = finalMessage;
      finalized.verdict = renderVerdictLine(result);
    }
    return finalized;
  }
};
