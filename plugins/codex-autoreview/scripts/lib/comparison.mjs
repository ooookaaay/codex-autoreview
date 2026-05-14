/**
 * Two-reviewer comparison / consensus logic.
 *
 * When a project enables a second reviewer (e.g. `codex` + `claude`), the
 * dispatcher runs both under a shared `comparisonGroupId`; when both reach a
 * terminal state, {@link compareReviews} produces ONE merged result that
 * highlights agreement and divergence.
 *
 * The algorithm is intentionally TEXT / STRUCTURAL — no embeddings, no extra
 * model call (semantic comparison is a deliberate Phase-4 swap of just Step 2).
 * It is the design from `docs/research/external-reviewer-architecture.md` §4:
 *
 *   Step 1 — verdict-axis agreement. Map each verdict to a 3-level ordinal
 *            severity (CLEAN/SOUND=0, CONCERNS=1, ISSUES=2); equal → `agree`,
 *            differ by 1 → `partial`, differ by 2 → `conflict`; one side
 *            failed → `single`; both failed → `inconclusive`.
 *   Step 2 — finding-level overlap. Each finding → a fingerprint
 *            (`{file, ±3-line window, normalized title}`); same file AND
 *            overlapping window on both sides → AGREED, else UNIQUE.
 *   Step 3 — consensus score (0–100) for the statusline/digest:
 *            `100 * agreementRatio − verdictPenalty`, clamped. Special case:
 *            both CLEAN/SOUND with zero findings on both sides → 100 (the two
 *            AIs fully agree there is nothing to fix).
 *   Step 4 — merged verdict line = the MORE SEVERE of the two verdicts
 *            (conservative — a real bug seen by one model is not hidden by the
 *            other's CLEAN), annotated with the consensus label.
 *
 * @file
 */

/**
 * Ordinal severity of a verdict on the 3-level consensus axis. `null` means
 * the reviewer produced no usable verdict (failed / stale) and is excluded
 * from scoring.
 *
 * @param {string | null | undefined} verdict - An F2 verdict enum value.
 * @returns {0 | 1 | 2 | null}
 */
export function verdictSeverity(verdict) {
  switch (String(verdict ?? "").toUpperCase()) {
    case "CLEAN":
    case "SOUND":
      return 0;
    case "CONCERNS":
      return 1;
    case "ISSUES":
      return 2;
    // FAILED / STALE / unknown → excluded from scoring.
    default:
      return null;
  }
}

/**
 * Normalize a finding title for fingerprint comparison: lowercase, strip
 * punctuation, collapse whitespace.
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Half-width of the line window two findings may differ by and still be
 * considered the "same location" (±3 lines, per research §4 Step 2).
 */
const LINE_WINDOW = 3;

/**
 * Build a comparable fingerprint for one finding: `{file, lineStart, lineEnd,
 * title}`. `lineStart`/`lineEnd` are the ±{@link LINE_WINDOW} window around the
 * finding's line; a finding with no line gets a `null` window (file-level
 * match only).
 *
 * @param {object} finding - An F2 `findings[]` entry.
 * @returns {{ file: string | null, lineStart: number | null, lineEnd: number | null, title: string, raw: object }}
 */
export function fingerprintFinding(finding) {
  const file =
    finding && typeof finding.file === "string" && finding.file.trim()
      ? finding.file.trim()
      : null;
  const line =
    finding && typeof finding.line === "number" && Number.isFinite(finding.line)
      ? Math.trunc(finding.line)
      : null;
  return {
    file,
    lineStart: line == null ? null : line - LINE_WINDOW,
    lineEnd: line == null ? null : line + LINE_WINDOW,
    title: normalizeTitle(finding ? finding.claim : ""),
    raw: finding && typeof finding === "object" ? finding : {}
  };
}

/**
 * Whether two finding fingerprints refer to the same location: same file AND
 * overlapping line window. When either has no line window, a same-file match
 * is accepted (file-level agreement). When either has no file, fall back to a
 * non-trivial title match.
 *
 * @param {ReturnType<typeof fingerprintFinding>} a
 * @param {ReturnType<typeof fingerprintFinding>} b
 * @returns {boolean}
 */
export function findingsOverlap(a, b) {
  if (a.file && b.file) {
    if (a.file !== b.file) {
      return false;
    }
    // Same file. If both have a line window, require overlap; otherwise a
    // same-file match stands (title similarity is a tie-breaker, not required).
    if (a.lineStart != null && a.lineEnd != null && b.lineStart != null && b.lineEnd != null) {
      return a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
    }
    return true;
  }
  // No file on at least one side — fall back to a non-trivial normalized-title
  // match (avoid matching two empty titles).
  return a.title.length > 0 && a.title === b.title;
}

/**
 * The `findings[]` array of a review record's `result`, or `[]`.
 *
 * @param {object | null | undefined} review
 * @returns {object[]}
 */
function findingsOf(review) {
  const result = review && review.result ? review.result : null;
  return result && Array.isArray(result.findings) ? result.findings : [];
}

/**
 * Compare two reviews' finding sets: partition into AGREED (both reviewers
 * independently saw it) and UNIQUE-per-reviewer. Within "agreed", the more
 * specific finding text is kept (tighter line range wins; longer body wins on
 * ties).
 *
 * @param {object} reviewA
 * @param {object} reviewB
 * @returns {{ agreed: object[], uniqueA: object[], uniqueB: object[], totalDistinct: number }}
 */
export function compareFindings(reviewA, reviewB) {
  const fpsA = findingsOf(reviewA).map(fingerprintFinding);
  const fpsB = findingsOf(reviewB).map(fingerprintFinding);

  /** @type {object[]} */
  const agreed = [];
  const matchedB = new Set();
  /** @type {object[]} */
  const uniqueA = [];

  for (const a of fpsA) {
    let matchIndex = -1;
    for (let i = 0; i < fpsB.length; i += 1) {
      if (matchedB.has(i)) {
        continue;
      }
      if (findingsOverlap(a, fpsB[i])) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex === -1) {
      uniqueA.push(a.raw);
      continue;
    }
    matchedB.add(matchIndex);
    const b = fpsB[matchIndex];
    // Keep the more specific finding: tighter line range loses to none... no —
    // a finding WITH a line range is more specific than one without; between
    // two with ranges, the longer body wins. Pick the raw finding that is more
    // informative.
    agreed.push(pickMoreSpecific(a.raw, b.raw));
  }

  /** @type {object[]} */
  const uniqueB = [];
  for (let i = 0; i < fpsB.length; i += 1) {
    if (!matchedB.has(i)) {
      uniqueB.push(fpsB[i].raw);
    }
  }

  const totalDistinct = agreed.length + uniqueA.length + uniqueB.length;
  return { agreed, uniqueA, uniqueB, totalDistinct };
}

/**
 * Pick the more specific / informative of two findings that fingerprinted to
 * the same location: a finding with a concrete line wins over one without;
 * between two comparable findings, the longer combined body (impact + fix)
 * wins.
 *
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
function pickMoreSpecific(a, b) {
  const aHasLine = typeof a.line === "number" && Number.isFinite(a.line);
  const bHasLine = typeof b.line === "number" && Number.isFinite(b.line);
  if (aHasLine !== bHasLine) {
    return aHasLine ? a : b;
  }
  const bodyLen = (f) =>
    String(f.claim ?? "").length + String(f.impact ?? "").length + String(f.fix ?? "").length;
  return bodyLen(a) >= bodyLen(b) ? a : b;
}

/**
 * Verdict-penalty applied to the consensus score per consensus label
 * (research §4 Step 3).
 * @type {Readonly<Record<string, number>>}
 */
const VERDICT_PENALTY = Object.freeze({
  agree: 0,
  partial: 20,
  conflict: 50,
  single: 30,
  inconclusive: 100
});

/**
 * @typedef {object} ComparisonResult
 * @property {"agree" | "partial" | "conflict" | "single" | "inconclusive"} consensus
 * @property {number} consensusScore - 0–100; high = the two AIs broadly agree.
 * @property {string} mergedVerdict - The merged headline verdict ENUM (the
 *   more severe of the two), e.g. `"ISSUES"`.
 * @property {string} mergedVerdictLine - The annotated one-line headline.
 * @property {object[]} agreedFindings - Findings both reviewers flagged.
 * @property {object[]} uniqueFindings - `{reviewer, finding}` for one-sided
 *   findings.
 * @property {{ id: string, backend: string | null, verdict: string | null, status: string }} reviewerA
 * @property {{ id: string, backend: string | null, verdict: string | null, status: string }} reviewerB
 * @property {string} surfaced - The full surfaced output block (feeds 2C
 *   severity-gating).
 */

/**
 * Compare two terminal review records and produce one merged consensus result.
 *
 * NEVER throws — a missing/odd review degrades to the `inconclusive` /
 * `single` paths. The inputs are review RECORDS (the `ReviewRecord` shape:
 * `{id, status, verdict, backend, result, ...}`); only `status`, `verdict`,
 * `backend`, and `result.findings` are read.
 *
 * @param {object} reviewA - First review record.
 * @param {object} reviewB - Second review record.
 * @returns {ComparisonResult}
 */
export function compareReviews(reviewA, reviewB) {
  const a = reviewA && typeof reviewA === "object" ? reviewA : {};
  const b = reviewB && typeof reviewB === "object" ? reviewB : {};

  const verdictA = verdictEnumOf(a);
  const verdictB = verdictEnumOf(b);
  const sevA = verdictSeverity(verdictA);
  const sevB = verdictSeverity(verdictB);

  // Step 1 — verdict-axis agreement.
  /** @type {"agree" | "partial" | "conflict" | "single" | "inconclusive"} */
  let consensus;
  if (sevA == null && sevB == null) {
    consensus = "inconclusive";
  } else if (sevA == null || sevB == null) {
    consensus = "single";
  } else if (sevA === sevB) {
    consensus = "agree";
  } else if (Math.abs(sevA - sevB) === 1) {
    consensus = "partial";
  } else {
    consensus = "conflict";
  }

  // Step 2 — finding-level overlap.
  const { agreed, uniqueA, uniqueB, totalDistinct } = compareFindings(a, b);

  // Step 3 — consensus score.
  let consensusScore;
  const bothClean =
    consensus === "agree" && sevA === 0 && sevB === 0 && totalDistinct === 0;
  if (consensus === "inconclusive") {
    consensusScore = 0;
  } else if (bothClean) {
    // Codex Fork-3 decision: both reviewers say CLEAN/SOUND with zero findings
    // is FULL agreement — the agreementRatio formula would otherwise read
    // 0/1 = 0 and tank the score. Special-case it before the ratio math.
    consensusScore = 100;
  } else {
    const agreementRatio = totalDistinct === 0 ? 0 : agreed.length / totalDistinct;
    const penalty = VERDICT_PENALTY[consensus] ?? 100;
    consensusScore = Math.round(Math.max(0, 100 * agreementRatio - penalty));
  }

  // Step 4 — merged verdict = the MORE SEVERE of the two (conservative).
  const mergedVerdict = mergeVerdicts(verdictA, verdictB, sevA, sevB);
  const mergedVerdictLine = buildMergedVerdictLine({
    mergedVerdict,
    consensus,
    consensusScore,
    verdictA,
    verdictB,
    backendA: backendOf(a),
    backendB: backendOf(b)
  });

  /** @type {Array<{ reviewer: string, finding: object }>} */
  const uniqueFindings = [
    ...uniqueA.map((finding) => ({ reviewer: backendOf(a) ?? "reviewer A", finding })),
    ...uniqueB.map((finding) => ({ reviewer: backendOf(b) ?? "reviewer B", finding }))
  ];

  const reviewerA = describeReviewer(a);
  const reviewerB = describeReviewer(b);

  const surfaced = renderComparison({
    mergedVerdictLine,
    consensus,
    consensusScore,
    agreed,
    uniqueA,
    uniqueB,
    backendA: backendOf(a),
    backendB: backendOf(b)
  });

  return {
    consensus,
    consensusScore,
    mergedVerdict,
    mergedVerdictLine,
    agreedFindings: agreed,
    uniqueFindings,
    reviewerA,
    reviewerB,
    surfaced
  };
}

/**
 * The F2 verdict enum of a review record — prefers `result.verdict`, falls
 * back to parsing the `verdict` line prefix, else `null`.
 *
 * @param {object} review
 * @returns {string | null}
 */
function verdictEnumOf(review) {
  if (review.result && typeof review.result.verdict === "string") {
    return review.result.verdict;
  }
  // A failed/stale review or a record with only a verdict LINE.
  if (typeof review.verdict === "string" && review.verdict) {
    const match = review.verdict.match(/^([A-Za-z]+)\s*:/);
    if (match) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

/**
 * @param {object} review
 * @returns {string | null}
 */
function backendOf(review) {
  if (typeof review.backend === "string" && review.backend) {
    return review.backend;
  }
  if (review.request && typeof review.request.backend === "string") {
    return review.request.backend;
  }
  return null;
}

/**
 * Build the per-reviewer descriptor used in the merged result.
 *
 * @param {object} review
 * @returns {{ id: string, backend: string | null, verdict: string | null, status: string }}
 */
function describeReviewer(review) {
  return {
    id: typeof review.id === "string" ? review.id : "(unknown)",
    backend: backendOf(review),
    verdict: verdictEnumOf(review),
    status: typeof review.status === "string" ? review.status : "(unknown)"
  };
}

/**
 * Merge two verdicts into the MORE SEVERE headline. When one reviewer failed
 * (severity `null`), the surviving reviewer's verdict stands. When both
 * failed, the headline is `FAILED`.
 *
 * @param {string | null} verdictA
 * @param {string | null} verdictB
 * @param {0 | 1 | 2 | null} sevA
 * @param {0 | 1 | 2 | null} sevB
 * @returns {string}
 */
export function mergeVerdicts(verdictA, verdictB, sevA, sevB) {
  if (sevA == null && sevB == null) {
    return "FAILED";
  }
  if (sevA == null) {
    return verdictB ?? "FAILED";
  }
  if (sevB == null) {
    return verdictA ?? "FAILED";
  }
  return sevA >= sevB ? verdictA ?? "FAILED" : verdictB ?? "FAILED";
}

/**
 * Build the annotated merged headline line (research §4 Step 4 examples).
 *
 * @param {object} params
 * @param {string} params.mergedVerdict
 * @param {string} params.consensus
 * @param {number} params.consensusScore
 * @param {string | null} params.verdictA
 * @param {string | null} params.verdictB
 * @param {string | null} params.backendA
 * @param {string | null} params.backendB
 * @returns {string}
 */
export function buildMergedVerdictLine(params) {
  const a = params.backendA ?? "reviewer A";
  const b = params.backendB ?? "reviewer B";
  switch (params.consensus) {
    case "agree":
      return `${params.mergedVerdict} · 2 reviewers · agree`;
    case "partial":
      return `${params.mergedVerdict} · partial · consensus ${params.consensusScore}`;
    case "conflict":
      return `${params.mergedVerdict} · conflict · ${a} said ${
        params.verdictA ?? "?"
      }, ${b} said ${params.verdictB ?? "?"}`;
    case "single": {
      const survivor = params.verdictA ? a : b;
      const failed = params.verdictA ? b : a;
      return `${params.mergedVerdict} · ${survivor} only · ${failed} failed`;
    }
    case "inconclusive":
    default:
      return `FAILED · inconclusive · both reviewers failed`;
  }
}

/**
 * Render one finding as a compact `[sev] claim — file:line` line.
 *
 * @param {object} finding
 * @returns {string}
 */
function renderFinding(finding) {
  const sev = typeof finding.severity === "string" ? finding.severity : "med";
  const claim = String(finding.claim ?? "").trim() || "(no description)";
  const where = finding.file
    ? ` — ${finding.file}${
        typeof finding.line === "number" && Number.isFinite(finding.line)
          ? `:${finding.line}`
          : ""
      }`
    : "";
  return `  - [${sev}] ${claim}${where}`;
}

/**
 * Render the full surfaced comparison block (research §4 "Surfaced output
 * shape") — feeds Wave 2C severity-gating.
 *
 * @param {object} params
 * @param {string} params.mergedVerdictLine
 * @param {string} params.consensus
 * @param {number} params.consensusScore
 * @param {object[]} params.agreed
 * @param {object[]} params.uniqueA
 * @param {object[]} params.uniqueB
 * @param {string | null} params.backendA
 * @param {string | null} params.backendB
 * @returns {string}
 */
export function renderComparison(params) {
  const lines = [];
  lines.push(params.mergedVerdictLine);
  lines.push(
    `Consensus: ${params.consensus}  (score ${params.consensusScore}/100)`
  );

  if (params.agreed.length > 0) {
    lines.push("");
    lines.push("Both reviewers flagged:");
    for (const finding of params.agreed) {
      lines.push(renderFinding(finding));
    }
  }

  if (params.uniqueA.length > 0) {
    lines.push("");
    lines.push(`Flagged by ${params.backendA ?? "reviewer A"} only:`);
    for (const finding of params.uniqueA) {
      lines.push(renderFinding(finding));
    }
  }
  if (params.uniqueB.length > 0) {
    lines.push("");
    lines.push(`Flagged by ${params.backendB ?? "reviewer B"} only:`);
    for (const finding of params.uniqueB) {
      lines.push(renderFinding(finding));
    }
  }

  return lines.join("\n");
}
