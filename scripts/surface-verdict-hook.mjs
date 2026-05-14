#!/usr/bin/env node
/**
 * UserPromptSubmit hook — surfaces finished Codex reviews into the session.
 *
 * The plugin's reviews run in a detached background worker, so a review settles
 * in state asynchronously, after the hook that dispatched it already returned.
 * This hook closes the loop: on the user's next prompt it checks state and
 * injects what matters into the session context via
 * `hookSpecificOutput.additionalContext`. Claude then sees the Codex findings
 * inline and decides whether to act on them.
 *
 * Phase 2C — severity gating & failure surfacing:
 *   - SEVERITY GATING. Only what matters goes into the session: the verdict,
 *     high/medium findings, critical `unverified[]` gaps, and one suggested
 *     next action. A CLEAN/SOUND review with no high/medium findings is still
 *     CLAIMED (stamped `surfacedAt` so it never re-surfaces) but injects
 *     nothing — it goes quietly to `/codex-autoreview:last`.
 *   - ACCEPT/REJECT MEMORY. A finding the user already dismissed
 *     ({@link isFindingDismissed}) is not re-surfaced. If gating leaves a
 *     review with nothing worth showing, it is dropped to `/last`.
 *   - FAILED / STUCK REVIEWS. A silently failed or stuck (timed-out) review
 *     injects a single one-line notice — once, session-scoped — so the user
 *     knows the automation failed instead of assuming it is still running.
 *   - REVIEW-GAP RECORDING. When a completed review carries `unverified[]`
 *     items, they are appended to the persistent `reviewGaps[]` accumulator so
 *     `/last` and the docs can show "could not verify — no oracle exists;
 *     suggested harness improvement: …".
 *
 * The injected context respects the platform's hard 10,000-char
 * `additionalContext` cap (claude-code-platform.md §2.1): on overflow the block
 * is truncated to a preview plus a pointer to `/codex-autoreview:last`.
 *
 * Each surfaced review is stamped `surfacedAt` (completed reviews via
 * {@link claimUnsurfacedCompletedReviews}; failed/stuck reviews via a
 * compare-and-set {@link updateReviewIf}) so it is acted on exactly once,
 * never re-injected on a later prompt.
 *
 * No-ops cleanly (exit 0, empty stdout) when the toggle is off or there is
 * nothing new to surface.
 *
 * @file
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import process from "node:process";

import {
  appendReviewGaps,
  claimUnsurfacedCompletedReviews,
  getConfig,
  isFindingDismissed,
  isReviewLikelyStuck,
  listReviews,
  updateReviewIf
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/**
 * Hard cap on the whole injected context block. The platform caps
 * `additionalContext` at 10,000 chars (claude-code-platform.md §2.1); staying
 * comfortably under it leaves headroom for the framing text and guarantees the
 * block is never silently spilled to a file by Claude Code.
 */
const MAX_CONTEXT_CHARS = 8000;
/** Per-review body budget — keeps any single noisy review from crowding out others. */
const MAX_REVIEW_BODY_CHARS = 2400;
/** Most reviews to surface in a single prompt (newest-relevant batching). */
const MAX_REVIEWS_PER_PROMPT = 3;
/**
 * Most failed/stuck notices to surface in a single prompt. A failure notice is
 * one terse line, but a burst of them on one prompt is still noise — cap it and
 * let the rest ride the next prompt (they stay unclaimed until then).
 */
const MAX_FAILURE_NOTICES_PER_PROMPT = 3;

/**
 * Verdicts that, with no high/medium findings and no critical gaps, carry no
 * actionable signal — they are claimed but not injected (they live in `/last`).
 */
const QUIET_VERDICTS = new Set(["CLEAN", "SOUND"]);

/**
 * @returns {Record<string, unknown>}
 */
function readHookInput() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8").trim();
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed hook payload is a clean no-op, never a crash.
    return {};
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Deterministic fingerprint for a finding — the dedupe key for the accept/reject
 * memory ({@link isFindingDismissed} / `dismissFinding`). Per the
 * `DismissedFinding` contract in `state.mjs`, the fingerprint folds together the
 * file, a coarse line window, and the normalized finding title.
 *
 * NOTE (file-ownership): this primitive logically belongs in `review-schema.mjs`
 * alongside the schema it keys on, but Phase 2 file ownership keeps that module
 * out of this wave. It is implemented locally here so the accept/reject check
 * actually works now; a later pass should hoist a shared
 * `computeFindingFingerprint()` into `review-schema.mjs` and have both this hook
 * and the (future) dismiss command import it. See the wave summary.
 *
 * @param {{ file?: string | null, line?: number | null, claim?: string }} finding
 * @returns {string}
 */
function computeFindingFingerprint(finding) {
  const file = asString(finding && finding.file).trim().toLowerCase();
  // Coarse line window (buckets of 10) so a finding that drifts a few lines
  // after an edit still matches a prior dismissal.
  const rawLine =
    finding && typeof finding.line === "number" && Number.isFinite(finding.line)
      ? Math.trunc(finding.line)
      : null;
  const lineWindow = rawLine == null ? "noline" : String(Math.floor(rawLine / 10) * 10);
  const title = asString(finding && finding.claim)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  // Join with an explicit ASCII unit separator so the canonical form is
  // unambiguous and stable regardless of whitespace in any component.
  const canonical = [file, lineWindow, title].join("|");
  return `sha256-${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * The compact "next action" line for a surfaced review — what Claude should do
 * with it. Derived from the verdict so the hook never has to editorialize.
 *
 * @param {import("./lib/state.mjs").ReviewRecord} review
 * @param {{ highCount: number, mediumCount: number, criticalGapCount: number }} counts
 * @returns {string}
 */
function suggestedNextAction(review, counts) {
  const verdict = String(review.verdict ?? "").split(":")[0].trim().toUpperCase();
  if (verdict === "ISSUES" || verdict === "FEEDBACK" || verdict === "CONCERNS") {
    if (counts.highCount > 0) {
      return "Next action: assess the high-severity finding(s) above and fix or explicitly dismiss each before continuing.";
    }
    return "Next action: weigh the finding(s) above on their merits and tell the user what you will or will not act on.";
  }
  if (verdict === "STALE") {
    return "Next action: the working tree moved under this review — re-run the review (or treat it as advisory only).";
  }
  if (counts.criticalGapCount > 0) {
    return "Next action: the review verdict is acceptable, but note the unverified gap(s) — they were not proven.";
  }
  return "Next action: no blocking findings — continue, treating this as an advisory pass.";
}

/**
 * Severity-gate a completed review into a bounded, session-worthy context block,
 * or `null` when nothing about it is worth injecting (a clean pass with no
 * actionable findings, or a review whose only findings the user has dismissed).
 *
 * The dropped-but-claimed reviews still live in `/codex-autoreview:last`.
 *
 * @param {string} workspaceRoot
 * @param {import("./lib/state.mjs").ReviewRecord} review
 * @returns {string | null}
 */
function renderGatedReview(workspaceRoot, review) {
  const verdict = String(review.verdict ?? "").trim();
  const verdictPrefix = verdict.split(":")[0].trim().toUpperCase();
  const result = review.result && typeof review.result === "object" ? review.result : null;

  const findings = Array.isArray(result && result.findings) ? result.findings : [];
  const unverified = Array.isArray(result && result.unverified) ? result.unverified : [];

  // Severity gate + accept/reject memory: keep only high/medium findings the
  // user has NOT already dismissed.
  const surfacedFindings = findings.filter((finding) => {
    if (!finding || (finding.severity !== "high" && finding.severity !== "medium")) {
      return false;
    }
    return !isFindingDismissed(workspaceRoot, computeFindingFingerprint(finding));
  });
  const criticalGaps = unverified.filter((gap) => gap && gap.critical);

  const highCount = surfacedFindings.filter((f) => f.severity === "high").length;
  const mediumCount = surfacedFindings.filter((f) => f.severity === "medium").length;

  // QUIET path: a CLEAN/SOUND verdict with nothing high/medium and no critical
  // gap carries no session-worthy signal — drop it to `/last` (it is still
  // claimed/stamped by the caller, so it never re-surfaces).
  if (
    QUIET_VERDICTS.has(verdictPrefix) &&
    surfacedFindings.length === 0 &&
    criticalGaps.length === 0
  ) {
    return null;
  }
  // A non-quiet verdict whose every finding was dismissed AND that has no
  // critical gaps is also not worth re-surfacing — the user already triaged it.
  if (
    !QUIET_VERDICTS.has(verdictPrefix) &&
    findings.length > 0 &&
    surfacedFindings.length === 0 &&
    criticalGaps.length === 0 &&
    // ...but only drop it when there genuinely were findings to dismiss. A
    // structured-result-less review (prose backend) still surfaces its verdict.
    result != null
  ) {
    return null;
  }

  const kindLabel =
    review.kind === "plan" ? "plan review (devil's advocate)" : "code review (bug-finding)";
  const lines = [];
  lines.push(`### Codex ${kindLabel} — ${review.id}`);
  lines.push(`Verdict: ${verdict || "(none)"}`);

  const summary = asString(result && result.summary).trim();
  if (summary && !verdict.includes(summary)) {
    lines.push(summary);
  }

  if (surfacedFindings.length > 0) {
    lines.push("");
    lines.push("Findings (high/medium only — low-severity stays in /codex-autoreview:last):");
    for (const finding of surfacedFindings) {
      const where = finding.file
        ? ` — ${finding.file}${finding.line != null ? `:${finding.line}` : ""}`
        : "";
      lines.push(`[${finding.severity}] ${asString(finding.claim)}${where}`);
      const impact = asString(finding.impact).trim();
      const fix = asString(finding.fix).trim();
      if (impact) {
        lines.push(`  impact: ${impact}`);
      }
      if (fix) {
        lines.push(`  fix: ${fix}`);
      }
    }
  } else if (!result) {
    // Prose-only backend: no structured findings, fall back to the compact
    // `output` body so the verdict still carries detail.
    let body = asString(review.output).trim();
    if (body.startsWith(verdict)) {
      body = body.slice(verdict.length).trim();
    }
    if (body) {
      lines.push("");
      lines.push(body);
    }
  }

  if (criticalGaps.length > 0) {
    lines.push("");
    lines.push("Unverified (critical — could not be proven):");
    for (const gap of criticalGaps) {
      const oracle = asString(gap.suggestedOracle).trim();
      lines.push(`! ${asString(gap.gap)}${oracle ? ` — needs: ${oracle}` : ""}`);
    }
  }

  lines.push("");
  lines.push(
    suggestedNextAction(review, {
      highCount,
      mediumCount,
      criticalGapCount: criticalGaps.length
    })
  );

  let block = lines.join("\n");
  if (block.length > MAX_REVIEW_BODY_CHARS) {
    block = `${block
      .slice(0, MAX_REVIEW_BODY_CHARS)
      .trimEnd()}\n…(truncated — run /codex-autoreview:last for the full review)`;
  }
  return block;
}

/**
 * One terse line for a failed or stuck review — enough for the user to know the
 * automation did not silently succeed.
 *
 * @param {import("./lib/state.mjs").ReviewRecord} review
 * @param {"failed" | "stuck"} reason
 * @returns {string}
 */
function renderFailureNotice(review, reason) {
  const kindLabel = review.kind === "plan" ? "plan review" : "code review";
  if (reason === "stuck") {
    return (
      `! Codex ${kindLabel} (${review.id}) appears STUCK — its background worker ` +
      "outlived its timeout without producing a verdict. The automatic review did not complete; " +
      "re-run it with /codex-autoreview:run if you still want it."
    );
  }
  const detail = asString(review.errorMessage).trim();
  return (
    `! Codex ${kindLabel} (${review.id}) FAILED to complete` +
    `${detail ? ` — ${detail}` : ""}. ` +
    "The automatic review did not produce a verdict; re-run it with /codex-autoreview:run if you still want it."
  );
}

/**
 * Atomically CLAIM up to `limit` failed/stuck reviews for this session that have
 * not been surfaced yet — one compare-and-set per review via
 * {@link updateReviewIf} (predicate `!surfacedAt`), so two concurrent
 * UserPromptSubmit hooks can never both claim the same failure notice.
 *
 * "Stuck" here means a `queued`/`running` review past its staleness bound; the
 * SessionEnd hook eventually self-heals such a review to `failed`, but this path
 * surfaces it sooner — and on sessions where SessionEnd never fires at all.
 *
 * @param {string} workspaceRoot
 * @param {string | null} sessionId
 * @param {number} limit
 * @returns {Array<{ review: import("./lib/state.mjs").ReviewRecord, reason: "failed" | "stuck" }>}
 */
function claimFailureNotices(workspaceRoot, sessionId, limit) {
  if (limit <= 0) {
    return [];
  }
  const candidates = listReviews(workspaceRoot)
    .filter((review) => {
      if (review.surfacedAt) {
        return false;
      }
      // Session scoping: a failure notice is for the session that dispatched
      // the review, or for any session when the review has no attribution.
      const reviewSession =
        review.request && typeof review.request === "object"
          ? review.request.sessionId
          : undefined;
      if (sessionId && reviewSession && reviewSession !== sessionId) {
        return false;
      }
      if (review.status === "failed") {
        return true;
      }
      return isReviewLikelyStuck(review);
    })
    // Oldest first — surface failures in the order they happened.
    .sort((left, right) =>
      String(left.updatedAt ?? "").localeCompare(String(right.updatedAt ?? ""))
    )
    .slice(0, limit);

  /** @type {Array<{ review: import("./lib/state.mjs").ReviewRecord, reason: "failed" | "stuck" }>} */
  const claimed = [];
  for (const review of candidates) {
    const reason = review.status === "failed" ? "failed" : "stuck";
    const surfacedAt = new Date().toISOString();
    // Compare-and-set: only claim it if it is STILL unsurfaced (and, for a
    // "stuck" claim, still non-terminal — a worker may have settled it in the
    // meantime; that completion will surface through the normal path instead).
    const { applied } = updateReviewIf(
      workspaceRoot,
      review.id,
      (current) =>
        !current.surfacedAt &&
        (current.status === "failed" ||
          ((current.status === "queued" || current.status === "running") &&
            isReviewLikelyStuck(current))),
      { surfacedAt, surfacedSessionId: sessionId ?? undefined }
    );
    if (applied) {
      claimed.push({ review, reason });
    }
  }
  return claimed;
}

/**
 * Append a completed review's `unverified[]` gaps to the persistent
 * `reviewGaps[]` accumulator. Best-effort and idempotent-enough: a review is
 * claimed (stamped `surfacedAt`) exactly once, so its gaps are recorded exactly
 * once on the prompt that surfaces it.
 *
 * @param {string} workspaceRoot
 * @param {import("./lib/state.mjs").ReviewRecord} review
 */
function recordReviewGaps(workspaceRoot, review) {
  const result = review.result && typeof review.result === "object" ? review.result : null;
  const unverified = Array.isArray(result && result.unverified) ? result.unverified : [];
  if (unverified.length === 0) {
    return;
  }
  try {
    appendReviewGaps(workspaceRoot, {
      reviewId: review.id,
      kind: review.kind === "plan" ? "plan" : "code",
      gaps: unverified.map((gap) => ({
        gap: asString(gap && gap.gap),
        suggestedOracle: asString(gap && gap.suggestedOracle),
        critical: Boolean(gap && gap.critical)
      }))
    });
  } catch (error) {
    // Recording a gap must never break surfacing — log and move on.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codex-autoreview: could not record review gaps: ${message}\n`);
  }
}

/**
 * Assemble the final `additionalContext` block from the gated review blocks and
 * the failure notices, enforcing the platform's 10,000-char cap with a clean
 * preview + pointer on overflow.
 *
 * @param {string[]} reviewBlocks - Already-gated, already-bounded review blocks.
 * @param {string[]} failureNotices - One-line failed/stuck notices.
 * @returns {string}
 */
function buildAdditionalContext(reviewBlocks, failureNotices) {
  const sections = [];
  if (reviewBlocks.length > 0) {
    sections.push(
      [
        "Automatic Codex review results just completed in the background.",
        "Treat these as advisory peer review — assess each finding on its merits,",
        "decide whether it is valid, and tell the user what you will or won't act on.",
        "Only high/medium findings and critical unverified gaps are shown here;",
        "the full review (including low-severity notes) is in /codex-autoreview:last.",
        "",
        reviewBlocks.join("\n\n")
      ].join("\n")
    );
  }
  if (failureNotices.length > 0) {
    sections.push(
      [
        "Some automatic Codex reviews did NOT complete — the automation failed, it is not still running:",
        "",
        failureNotices.join("\n")
      ].join("\n")
    );
  }
  let context = sections.join("\n\n");
  if (context.length > MAX_CONTEXT_CHARS) {
    // Hard cap (claude-code-platform.md §2.1: additionalContext is capped at
    // 10,000 chars). Truncate to a preview and point at the full record rather
    // than let Claude Code spill it to a file.
    const preview = context.slice(0, MAX_CONTEXT_CHARS).trimEnd();
    context = `${preview}\n\n…(Codex review context truncated to fit the injection budget — run /codex-autoreview:last for the complete results.)`;
  }
  return context;
}

function main() {
  const input = readHookInput();
  const cwd =
    (typeof input.cwd === "string" && input.cwd) ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const sessionId = typeof input.session_id === "string" ? input.session_id : null;

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  // No-op when the per-project toggle is off — nothing should be surfaced.
  if (!config.enabled) {
    return;
  }

  // 1. Atomically CLAIM the oldest-finished few unsurfaced COMPLETED verdicts.
  //    The eligibility check and the `surfacedAt` stamp happen in one locked
  //    critical section, so two concurrent UserPromptSubmit hooks can never both
  //    claim the same review. Scoped to this session. Note: a review is CLAIMED
  //    here even if severity gating later drops it from the injection — that is
  //    intentional, it just means it goes quietly to `/last`.
  const claimedCompleted = claimUnsurfacedCompletedReviews(workspaceRoot, {
    sessionId,
    limit: MAX_REVIEWS_PER_PROMPT
  });

  // 2. Record review-gap feedback for every claimed completed review BEFORE
  //    severity gating — the accumulated gaps power `/last` and the docs
  //    regardless of whether the review itself is loud enough to inject.
  for (const review of claimedCompleted) {
    recordReviewGaps(workspaceRoot, review);
  }

  // 3. Severity-gate each claimed review into a session-worthy block (or drop
  //    it to `/last`).
  const reviewBlocks = [];
  for (const review of claimedCompleted) {
    const block = renderGatedReview(workspaceRoot, review);
    if (block) {
      reviewBlocks.push(block);
    }
  }

  // 4. Claim and render failed/stuck reviews — surface that the automation
  //    failed, once, session-scoped.
  const failures = claimFailureNotices(
    workspaceRoot,
    sessionId,
    MAX_FAILURE_NOTICES_PER_PROMPT
  );
  const failureNotices = failures.map(({ review, reason }) =>
    renderFailureNotice(review, reason)
  );

  if (reviewBlocks.length === 0 && failureNotices.length === 0) {
    // Everything was either quiet (clean, dropped to /last) or already
    // surfaced — inject nothing.
    return;
  }

  const additionalContext = buildAdditionalContext(reviewBlocks, failureNotices);
  if (!additionalContext.trim()) {
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext
      }
    })}\n`
  );
}

try {
  main();
} catch (error) {
  // Never block the user's prompt on a surfacing failure — log and exit 0.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-autoreview: could not surface verdict: ${message}\n`);
}
