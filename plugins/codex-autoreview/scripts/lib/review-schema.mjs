/**
 * Claim-based structured review output — the F2 deliverable.
 *
 * This module is the single source of truth for the plugin's structured review
 * result: the JSON Schema fed to `codex exec --output-schema`, a tolerant
 * parser/normalizer, and the compact text renderer. The schema is versioned
 * ({@link REVIEW_SCHEMA_VERSION}) so future shape changes stay migratable.
 *
 * Design (verifier-patterns research):
 *   - The MODEL emits `verdict`/`confidence`/`summary`/`claims[]`/`findings[]`/
 *     `unverified[]`/`reviewedInputHash`. The WORKER merges `usage` in
 *     post-run from `codex exec --json` token events — a model cannot count its
 *     own tokens, so `usage` is OPTIONAL in the model-facing schema.
 *   - The compact text view is RENDERED from the JSON, never the other way
 *     round. {@link renderCompactText} is what the worker stores as `verdict`/
 *     compact `output` for backward-compatible surfacing.
 *   - Parsing is defensive: a backend that can only produce a verdict line
 *     (e.g. the `exec-review` prose backend, or today's free-form
 *     `exec-generic` prompt) still yields a valid {@link ParsedReview} via
 *     {@link fromVerdictLine} — the structured fields just stay empty.
 *
 * @file
 */

import { createHash } from "node:crypto";

/**
 * Schema version. Bumped independently of the persisted STATE schema version
 * (see `state.mjs`) — this versions the review-RESULT object, that versions the
 * on-disk state file.
 */
export const REVIEW_SCHEMA_VERSION = 1;

/** Verdict values, ordered by the headline they produce. */
export const REVIEW_VERDICTS = Object.freeze([
  "SOUND",
  "CONCERNS",
  "CLEAN",
  "ISSUES",
  "STALE",
  "FAILED"
]);

/** Confidence ladder (verifier-agent research): completeness × outcome. */
export const REVIEW_CONFIDENCE_LEVELS = Object.freeze([
  "PERFECT",
  "VERIFIED",
  "PARTIAL",
  "FEEDBACK",
  "FAILED"
]);

/** Review profiles (Phase 2 builds the prompt bodies; F2 fixes the enum). */
export const REVIEW_PROFILES = Object.freeze([
  "generic-code",
  "plan-devils-advocate",
  "security-review",
  "migration-review",
  "ai-eval-review",
  "gsd-plan-review"
]);

/**
 * The JSON Schema document handed to `codex exec --output-schema`. `usage` is
 * intentionally OUT of `required` — the worker merges it post-run.
 *
 * @returns {object} a fresh deep copy (callers may write it to a temp file)
 */
export function getReviewOutputSchema() {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: `codex-autoreview review result v${REVIEW_SCHEMA_VERSION}`,
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "kind",
      "profile",
      "verdict",
      "confidence",
      "summary",
      "claims",
      "findings",
      "unverified",
      "reviewedInputHash"
    ],
    properties: {
      schemaVersion: { const: REVIEW_SCHEMA_VERSION },
      kind: { enum: ["plan", "code"] },
      profile: { enum: [...REVIEW_PROFILES] },
      verdict: { enum: [...REVIEW_VERDICTS] },
      confidence: { enum: [...REVIEW_CONFIDENCE_LEVELS] },
      summary: { type: "string", maxLength: 500 },
      reviewedInputHash: { type: "string", pattern: "^sha256-[0-9a-f]{64}$" },
      claims: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "source", "verdict"],
          properties: {
            claim: { type: "string", maxLength: 280 },
            source: {
              enum: ["builder-message", "plan-text", "user-request", "derived"]
            },
            evidence: { type: ["string", "null"], maxLength: 400 },
            evidenceKind: {
              enum: [
                "file-content",
                "git-diff",
                "command-output",
                "exit-code",
                "test-output",
                "static-analysis",
                "schema",
                "config",
                "project-rule",
                "none"
              ]
            },
            verdict: { enum: ["verified", "failed", "unverified"] },
            confidence: { enum: ["high", "medium", "low"] }
          }
        }
      },
      findings: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "claim", "impact", "fix", "confidence"],
          properties: {
            severity: { enum: ["high", "medium", "low"] },
            file: { type: ["string", "null"] },
            line: { type: ["integer", "null"] },
            claim: { type: "string", maxLength: 280 },
            impact: { type: "string", maxLength: 300 },
            fix: { type: "string", maxLength: 300 },
            confidence: { enum: ["high", "medium", "low"] },
            validity: {
              enum: ["likely-valid", "needs-human-check", "probably-false"]
            },
            cost: { enum: ["must-fix-now", "can-defer", "not-worth-it"] }
          }
        }
      },
      unverified: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["gap", "suggestedOracle"],
          properties: {
            gap: { type: "string", maxLength: 280 },
            suggestedOracle: { type: "string", maxLength: 300 },
            critical: { type: "boolean" }
          }
        }
      },
      usage: {
        type: "object",
        additionalProperties: false,
        required: ["tokensIn", "tokensOut"],
        properties: {
          tokensIn: { type: "integer", minimum: 0 },
          tokensCachedIn: { type: "integer", minimum: 0 },
          tokensOut: { type: "integer", minimum: 0 },
          costUsd: { type: ["number", "null"], minimum: 0 },
          costEstimated: { type: "boolean" },
          model: { type: "string" },
          pricedWith: { type: ["string", "null"] }
        }
      }
    }
  };
}

/**
 * @typedef {object} ReviewUsage
 * @property {number} tokensIn
 * @property {number} [tokensCachedIn]
 * @property {number} tokensOut
 * @property {number | null} [costUsd]
 * @property {boolean} [costEstimated]
 * @property {string} [model]
 * @property {string | null} [pricedWith]
 */

/**
 * @typedef {object} ReviewResult
 * The plugin's normalized structured review. Persisted under
 * `state.reviews[id].result`. `usage` is merged in by the worker post-run.
 * @property {number} schemaVersion
 * @property {"plan" | "code"} kind
 * @property {string} profile
 * @property {string} verdict
 * @property {string} confidence
 * @property {string} summary
 * @property {string | null} reviewedInputHash
 * @property {Array<object>} claims
 * @property {Array<object>} findings
 * @property {Array<object>} unverified
 * @property {ReviewUsage | null} usage
 */

/** @returns {string} */
function asString(value) {
  return typeof value === "string" ? value : "";
}

/** @returns {string} normalized to one of `set`, else `fallback`. */
function pickEnum(value, set, fallback) {
  const raw = asString(value).trim();
  if (set.includes(raw)) {
    return raw;
  }
  const upper = raw.toUpperCase();
  if (set.includes(upper)) {
    return upper;
  }
  const lower = raw.toLowerCase();
  if (set.includes(lower)) {
    return lower;
  }
  return fallback;
}

/** @returns {any[]} */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Tolerantly normalize a raw object (e.g. parsed from `--output-schema` JSON,
 * which is high-reliability but not guaranteed) into a {@link ReviewResult}.
 * Unknown/missing fields degrade to safe defaults; this NEVER throws.
 *
 * @param {unknown} raw - Parsed JSON, or a JSON string.
 * @param {{ kind?: "plan" | "code", profile?: string }} [ctx]
 * @returns {ReviewResult}
 */
export function normalizeReviewResult(raw, ctx = {}) {
  /** @type {Record<string, unknown>} */
  let obj = {};
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  } else if (raw && typeof raw === "object") {
    obj = /** @type {Record<string, unknown>} */ (raw);
  }

  const kind = ctx.kind === "plan" || obj.kind === "plan" ? "plan" : "code";
  const profile = pickEnum(
    obj.profile ?? ctx.profile,
    REVIEW_PROFILES,
    kind === "plan" ? "plan-devils-advocate" : "generic-code"
  );
  const verdict = pickEnum(obj.verdict, REVIEW_VERDICTS, "FAILED");
  const confidence = pickEnum(obj.confidence, REVIEW_CONFIDENCE_LEVELS, "FAILED");

  const claims = asArray(obj.claims).map((entry) => {
    const item = entry && typeof entry === "object" ? entry : {};
    return {
      claim: asString(item.claim),
      source: pickEnum(
        item.source,
        ["builder-message", "plan-text", "user-request", "derived"],
        "derived"
      ),
      evidence: item.evidence == null ? null : asString(item.evidence),
      evidenceKind: pickEnum(
        item.evidenceKind,
        [
          "file-content",
          "git-diff",
          "command-output",
          "exit-code",
          "test-output",
          "static-analysis",
          "schema",
          "config",
          "project-rule",
          "none"
        ],
        "none"
      ),
      verdict: pickEnum(item.verdict, ["verified", "failed", "unverified"], "unverified"),
      confidence: pickEnum(item.confidence, ["high", "medium", "low"], "low")
    };
  });

  const findings = asArray(obj.findings).map((entry) => {
    const item = entry && typeof entry === "object" ? entry : {};
    const line =
      typeof item.line === "number" && Number.isFinite(item.line)
        ? Math.trunc(item.line)
        : null;
    return {
      severity: pickEnum(item.severity, ["high", "medium", "low"], "medium"),
      file: item.file == null ? null : asString(item.file),
      line,
      claim: asString(item.claim),
      impact: asString(item.impact),
      fix: asString(item.fix),
      confidence: pickEnum(item.confidence, ["high", "medium", "low"], "low"),
      validity: pickEnum(
        item.validity,
        ["likely-valid", "needs-human-check", "probably-false"],
        "needs-human-check"
      ),
      cost: pickEnum(item.cost, ["must-fix-now", "can-defer", "not-worth-it"], "can-defer")
    };
  });

  const unverified = asArray(obj.unverified).map((entry) => {
    const item = entry && typeof entry === "object" ? entry : {};
    return {
      gap: asString(item.gap),
      suggestedOracle: asString(item.suggestedOracle),
      critical: Boolean(item.critical)
    };
  });

  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    kind,
    profile,
    verdict,
    confidence,
    summary: asString(obj.summary).slice(0, 500),
    reviewedInputHash:
      typeof obj.reviewedInputHash === "string" && obj.reviewedInputHash
        ? obj.reviewedInputHash
        : null,
    claims,
    findings,
    unverified,
    usage: normalizeUsage(obj.usage)
  };
}

/**
 * Normalize a usage object (the worker-merged token/cost block). Returns `null`
 * when there is nothing usable.
 *
 * @param {unknown} raw
 * @returns {ReviewUsage | null}
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const toCount = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : 0;
  const hasAny =
    typeof obj.tokensIn === "number" ||
    typeof obj.tokensOut === "number" ||
    typeof obj.costUsd === "number";
  if (!hasAny) {
    return null;
  }
  /** @type {ReviewUsage} */
  const usage = {
    tokensIn: toCount(obj.tokensIn),
    tokensOut: toCount(obj.tokensOut)
  };
  if (typeof obj.tokensCachedIn === "number") {
    usage.tokensCachedIn = toCount(obj.tokensCachedIn);
  }
  if (obj.costUsd === null || typeof obj.costUsd === "number") {
    usage.costUsd =
      typeof obj.costUsd === "number" && Number.isFinite(obj.costUsd)
        ? obj.costUsd
        : null;
  }
  if (typeof obj.costEstimated === "boolean") {
    usage.costEstimated = obj.costEstimated;
  }
  if (typeof obj.model === "string" && obj.model) {
    usage.model = obj.model;
  }
  if (obj.pricedWith === null || typeof obj.pricedWith === "string") {
    usage.pricedWith = obj.pricedWith == null ? null : obj.pricedWith;
  }
  return usage;
}

/**
 * Build a minimal but valid {@link ReviewResult} from just a verdict line —
 * the universal floor for backends that only produce a `SOUND:`/`CONCERNS:`/
 * `CLEAN:`/`ISSUES:` first line plus free-form prose (today's `exec-generic`
 * free-form prompt, and the `exec-review` prose backend before regex parsing).
 *
 * The verdict-line PREFIX maps to the schema `verdict` enum; the rest of the
 * line becomes the `summary`. Structured arrays stay empty.
 *
 * @param {string | null} verdictLine - e.g. `"CLEAN: no material bugs"`.
 * @param {{ kind?: "plan" | "code", profile?: string, fullOutput?: string }} [ctx]
 * @returns {ReviewResult}
 */
export function fromVerdictLine(verdictLine, ctx = {}) {
  const line = asString(verdictLine).trim();
  const kind = ctx.kind === "plan" ? "plan" : "code";
  let verdict = "FAILED";
  let summary = line;
  const match = line.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
  if (match) {
    const prefix = match[1].toUpperCase();
    if (REVIEW_VERDICTS.includes(prefix)) {
      verdict = prefix;
    }
    summary = match[2].trim() || line;
  }
  // A recognized non-failure verdict line means the review ran and produced an
  // answer — grade it PARTIAL (it has no decomposed claims/evidence), not
  // FAILED. An unrecognized line is treated as a failed review.
  const confidence = verdict === "FAILED" ? "FAILED" : "PARTIAL";
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    kind,
    profile: pickEnum(
      ctx.profile,
      REVIEW_PROFILES,
      kind === "plan" ? "plan-devils-advocate" : "generic-code"
    ),
    verdict,
    confidence,
    summary: summary.slice(0, 500),
    reviewedInputHash: null,
    claims: [],
    findings: [],
    unverified: [],
    usage: null
  };
}

/**
 * Render the compact text view FROM a {@link ReviewResult}. This is the
 * human-facing form the worker stores as the review `output` and the surface
 * hook injects. Rendering rule (verifier-patterns):
 *   line 1   `<verdict>: <summary>`
 *   then     high/medium findings (`[sev] claim — file:line`)
 *   then     critical unverified gaps (`! gap — oracle`)
 *   then     `tokens: <in>/<out> · ~$<cost>` when usage is known
 *
 * @param {ReviewResult} result
 * @returns {string}
 */
export function renderCompactText(result) {
  if (!result || typeof result !== "object") {
    return "FAILED: review produced no result.";
  }
  const lines = [];
  const summary = asString(result.summary).trim();
  lines.push(`${result.verdict}: ${summary || "(no summary)"}`);

  const surfaced = asArray(result.findings).filter(
    (finding) => finding && (finding.severity === "high" || finding.severity === "medium")
  );
  if (surfaced.length > 0) {
    lines.push("");
    for (const finding of surfaced) {
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
  }

  const criticalGaps = asArray(result.unverified).filter((gap) => gap && gap.critical);
  if (criticalGaps.length > 0) {
    lines.push("");
    lines.push("Unverified (critical):");
    for (const gap of criticalGaps) {
      const oracle = asString(gap.suggestedOracle).trim();
      lines.push(`! ${asString(gap.gap)}${oracle ? ` — needs: ${oracle}` : ""}`);
    }
  }

  const usageLine = renderUsageLine(result.usage);
  if (usageLine) {
    lines.push("");
    lines.push(usageLine);
  }

  return lines.join("\n");
}

/**
 * Render the `tokens: … · ~$…` footer line from a usage block, or `""` when
 * there is nothing to show.
 *
 * @param {ReviewUsage | null | undefined} usage
 * @returns {string}
 */
export function renderUsageLine(usage) {
  if (!usage || typeof usage !== "object") {
    return "";
  }
  const tokensIn = typeof usage.tokensIn === "number" ? usage.tokensIn : 0;
  const tokensOut = typeof usage.tokensOut === "number" ? usage.tokensOut : 0;
  if (tokensIn === 0 && tokensOut === 0) {
    return "";
  }
  let cost;
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd)) {
    cost = `~$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}`;
  } else {
    const model = asString(usage.model).trim();
    cost = model ? `~$? (${model} not priced)` : "~$? (cost unknown)";
  }
  return `tokens: ${tokensIn}/${tokensOut} · ${cost}`;
}

/**
 * Extract the compact verdict line (`<verdict>: <summary>`) from a result —
 * the value persisted as `review.verdict` for backward-compatible surfacing.
 *
 * @param {ReviewResult} result
 * @returns {string}
 */
export function renderVerdictLine(result) {
  if (!result || typeof result !== "object") {
    return "FAILED: review produced no result.";
  }
  const summary = asString(result.summary).trim();
  return `${result.verdict}: ${summary || "(no summary)"}`;
}

/**
 * Deterministic fingerprint for a finding — the dedupe key for the accept/reject
 * memory (`isFindingDismissed` / `dismissFinding` in `state.mjs`). Per the
 * `DismissedFinding` contract there, the fingerprint folds together the file, a
 * coarse line window, and the normalized finding title.
 *
 * Canonical home: this primitive keys on the {@link ReviewResult} `findings[]`
 * shape, so it lives here alongside the schema it keys on. Both the
 * surface-verdict hook and any dismiss command import it from here so the
 * accept/reject memory stays consistent.
 *
 * The line is bucketed into windows of 10 so a finding that drifts a few lines
 * after an edit still matches a prior dismissal. Components are joined with an
 * explicit `|` separator so the canonical form is stable regardless of
 * whitespace in any component.
 *
 * @param {{ file?: string | null, line?: number | null, claim?: string }} finding
 * @returns {string}
 */
export function computeFindingFingerprint(finding) {
  const file = asString(finding && finding.file).trim().toLowerCase();
  const rawLine =
    finding && typeof finding.line === "number" && Number.isFinite(finding.line)
      ? Math.trunc(finding.line)
      : null;
  const lineWindow = rawLine == null ? "noline" : String(Math.floor(rawLine / 10) * 10);
  const title = asString(finding && finding.claim)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const canonical = [file, lineWindow, title].join("|");
  return `sha256-${createHash("sha256").update(canonical).digest("hex")}`;
}
