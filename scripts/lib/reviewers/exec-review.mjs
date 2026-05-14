/**
 * `exec-review` reviewer backend — SCAFFOLD, non-default.
 *
 * Uses the purpose-built `codex exec review` subcommand (new in codex-cli
 * 0.130.0): a first-class, well-scoped review primitive (`--uncommitted` /
 * `--base` / `--commit`) running Codex's own tuned review system prompt.
 *
 * Capability posture (decided via `codex` consult — "Option C: exec-review is
 * a non-default backend that returns the same ParsedReview shape in DEGRADED
 * form"). The research is explicit on why it cannot be the full path:
 *   - `codex exec review` does NOT accept `--output-schema` → no claim-based
 *     JSON; findings come back as `[P1]/[P2] … — path:line` PROSE.
 *   - its `turn.completed.usage` is reported as ALL ZEROS → no real token
 *     accounting. Treated as `usage: null` (unavailable), never a fake `$0`.
 *
 * So this backend advertises `reviewScoped: true` but `structuredOutput: false`
 * and `accurateUsage: false`. It parses the prose findings with a regex into
 * the F2 `findings[]` shape, leaves `claims[]`/`unverified[]` empty, and marks
 * the result `degraded` so Phase 2 (severity-gating, two-reviewer consensus)
 * knows the claim-level fields are absent.
 *
 * Wave 2B wires `run()`: `codex exec review` with `--uncommitted` (code) or
 * `--base <ref>` (when a base ref is known), the custom review instructions on
 * stdin, `--json` + `-o` for the prose block. Reuses the shared
 * `spawnWithTimeout` hang-protection machinery from the external backend (the
 * codex helper in `lib/codex.mjs` is hardcoded to a generic `codex exec` arg
 * vector; `codex exec review` is a different subcommand with a different
 * flag set — see `docs/research/codex-cli.md` §3).
 *
 * @file
 */

import process from "node:process";

import { REVIEW_SCHEMA_VERSION, REVIEW_PROFILES } from "../review-schema.mjs";
import {
  buildCodexChildEnv,
  getCodexAvailability,
  parseCodexJsonStream
} from "../codex.mjs";
import {
  extractCodexStderrError,
  failedParsedReview,
  finalizeParsedReview,
  readOutputFile
} from "./exec-shared.mjs";
import { spawnWithTimeout } from "./external.mjs";

/**
 * Parse `codex exec review` prose into the F2 `findings[]` shape.
 *
 * Verified finding format (`docs/research/codex-cli.md` §3.3):
 *   `- [P1] <title> — <abs-path>:<startline>-<endline>` then an indented
 *   explanation paragraph. `P1` = blocking, `P2` = should-fix, `P3` = minor.
 *
 * @param {string} prose
 * @returns {Array<object>} normalized F2 findings
 */
export function parseReviewProseFindings(prose) {
  const text = String(prose ?? "");
  if (!text.trim()) {
    return [];
  }
  /** @type {Array<object>} */
  const findings = [];
  const lines = text.split(/\r?\n/);
  /** @type {Record<string, "high" | "medium" | "low">} */
  const severityByTag = { P1: "high", P2: "medium", P3: "low" };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // `- [P1] title — path:line-range`  (em-dash or hyphen separator)
    const match = line.match(
      /^\s*[-*]\s*\[(P[123])\]\s*(.+?)\s*(?:[—-]\s*(.+?))?\s*$/
    );
    if (!match) {
      continue;
    }
    const severity = severityByTag[match[1]] ?? "medium";
    const title = match[2].trim();
    let file = null;
    let lineNo = null;
    const locator = match[3] ? match[3].trim() : "";
    if (locator) {
      const locMatch = locator.match(/^(.+?):(\d+)(?:-\d+)?$/);
      if (locMatch) {
        file = locMatch[1];
        lineNo = Number(locMatch[2]);
        if (!Number.isFinite(lineNo)) {
          lineNo = null;
        }
      } else {
        file = locator;
      }
    }
    // Gather the indented explanation lines that follow.
    const detailLines = [];
    let lookahead = index + 1;
    while (lookahead < lines.length && /^\s+\S/.test(lines[lookahead])) {
      detailLines.push(lines[lookahead].trim());
      lookahead += 1;
    }
    const impact = detailLines.join(" ").slice(0, 300);
    findings.push({
      severity,
      file,
      line: lineNo,
      claim: title.slice(0, 280),
      impact,
      // The review subcommand's prose does not separate a fix from the impact;
      // leave `fix` empty rather than fabricate one.
      fix: "",
      confidence: "medium",
      validity: "needs-human-check",
      cost: severity === "high" ? "must-fix-now" : "can-defer"
    });
  }
  return findings;
}

/**
 * Build a DEGRADED {@link import("../review-schema.mjs").ReviewResult} from a
 * `codex exec review` prose block: regex-parsed `findings[]`, a verdict derived
 * from finding severities, empty `claims[]`/`unverified[]`, `usage: null`.
 *
 * @param {string} prose
 * @param {{ kind?: "plan" | "code", profile?: string }} [ctx]
 * @returns {import("../review-schema.mjs").ReviewResult}
 */
export function buildDegradedResultFromProse(prose, ctx = {}) {
  const findings = parseReviewProseFindings(prose);
  const kind = ctx.kind === "plan" ? "plan" : "code";
  const hasBlocking = findings.some((f) => f.severity === "high");
  const hasAny = findings.length > 0;
  // Map to the kind-appropriate verdict pair.
  let verdict;
  if (kind === "plan") {
    verdict = hasAny ? "CONCERNS" : "SOUND";
  } else {
    verdict = hasAny ? "ISSUES" : "CLEAN";
  }
  // First non-empty prose line is the review's own one-line summary.
  const summaryLine =
    String(prose ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const profile = REVIEW_PROFILES.includes(ctx.profile)
    ? ctx.profile
    : kind === "plan"
      ? "plan-devils-advocate"
      : "generic-code";
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    kind,
    profile,
    verdict,
    // Prose review with no decomposed claims/evidence: PARTIAL is the honest
    // confidence grade (FEEDBACK only when an actual claim failed, which this
    // backend cannot determine).
    confidence: hasBlocking ? "FEEDBACK" : "PARTIAL",
    summary: summaryLine.slice(0, 500),
    reviewedInputHash: null,
    claims: [],
    findings,
    unverified: [],
    usage: null
  };
}

/**
 * Build the `codex exec review` argument vector for a hardened background run.
 *
 * `codex exec review` has a DIFFERENT flag set from `codex exec` (verified
 * against `codex-cli 0.130.0`, `docs/research/codex-cli.md` §3):
 *   - NO `-s/--sandbox` → sandbox is set via `-c sandbox_mode="read-only"`;
 *   - NO `--color`, NO `--output-schema`;
 *   - target scoping: `--uncommitted` (staged+unstaged+untracked) or
 *     `--base <ref>` (diff vs a base branch, deliberately new-issues-only).
 * The hermetic / anti-hang flags (`--ephemeral`, `--ignore-user-config`,
 * `--ignore-rules`, `-c approval_policy="never"`, `-c history.persistence`)
 * DO exist on the subcommand and are kept.
 *
 * @param {object} params
 * @param {string} params.cwd
 * @param {string} params.outputFile - `-o/--output-last-message` target.
 * @param {string | null} [params.model]
 * @param {string | null} [params.base] - When set, `--base <ref>`; else
 *   `--uncommitted`.
 * @returns {string[]}
 */
export function buildCodexExecReviewArgs(params) {
  const args = ["exec", "review"];
  if (params.model) {
    args.push("--model", params.model);
  }
  // Target scoping: a known base ref → `--base`; otherwise the uncommitted
  // working-tree changes (the plugin's default code-review target).
  if (params.base) {
    args.push("--base", params.base);
  } else {
    args.push("--uncommitted");
  }
  args.push(
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    'history.persistence="none"',
    "--output-last-message",
    params.outputFile
  );
  return args;
}

/** @type {import("./index.mjs").ReviewerBackend} */
export const execReviewBackend = {
  id: "exec-review",

  capabilities: {
    structuredOutput: false,
    accurateUsage: false,
    reviewScoped: true,
    claimBased: false
  },

  /**
   * @param {import("./index.mjs").ProbeCtx} ctx
   * @returns {{ available: boolean, detail: string }}
   */
  probe(ctx) {
    return getCodexAvailability(ctx.cwd, { env: ctx.env });
  },

  /**
   * Run `codex exec review` to completion under a hard wall-clock timeout.
   * Target is `--base <ref>` when `ctx.base` is set, otherwise `--uncommitted`.
   * The custom review instructions (the plugin's profile prompt) go on stdin.
   * NEVER throws — a spawn failure / timeout resolves with a
   * {@link import("./index.mjs").RawRunResult} the worker can settle.
   *
   * @param {import("./index.mjs").RunCtx} ctx
   * @returns {Promise<import("./index.mjs").RawRunResult>}
   */
  async run(ctx) {
    const args = buildCodexExecReviewArgs({
      cwd: ctx.cwd,
      outputFile: ctx.outputFile,
      model: ctx.model ?? null,
      base: ctx.base ?? null
    });
    // F5: the codex child receives only the allowlisted env subset — the same
    // hardening the generic backend applies (secret-bearing vars dropped).
    const childEnv = buildCodexChildEnv(ctx.env ?? process.env);
    const raw = await spawnWithTimeout({
      command: "codex",
      args,
      cwd: ctx.cwd,
      env: childEnv,
      // The plugin's review instructions go on stdin — `codex exec review`
      // takes custom instructions positionally or via `-`/stdin.
      input: ctx.prompt ?? "",
      timeoutMs: ctx.timeoutMs,
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
      return failedParsedReview(
        `codex exec review timed out after ${seconds}s and was killed`
      );
    }
    const prose = raw.outputFileContent || "";
    if (!prose) {
      const stream = parseCodexJsonStream(raw.stdout);
      const detail =
        (raw.error && (raw.error instanceof Error ? raw.error.message : String(raw.error))) ||
        stream.errorMessage ||
        extractCodexStderrError(raw.stderr) ||
        `codex exec review produced no review output`;
      return failedParsedReview(detail);
    }
    const result = buildDegradedResultFromProse(prose, {
      kind: ctx.kind,
      profile: ctx.profile
    });
    return finalizeParsedReview({ result, degraded: true });
  }
};
