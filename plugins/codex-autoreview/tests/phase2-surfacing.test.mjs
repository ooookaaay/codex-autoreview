/**
 * Phase 2 — Wave A2 tests: severity-gated verdict surfacing and the
 * end-of-session digest.
 *
 * Covers `scripts/surface-verdict-hook.mjs` and the digest addition to
 * `scripts/session-end-cleanup-hook.mjs`. Uses the shared test helpers (temp
 * git repos, fake codex) — no test touches the real Codex.
 *
 * @file
 */

import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, initGitRepo, installFakeCodex, makeTempDir, run } from "./helpers.mjs";

import {
  REVIEW_SCHEMA_VERSION
} from "../scripts/lib/review-schema.mjs";
import {
  STALE_RUNNING_MS,
  dismissFinding,
  listReviewGaps,
  loadState,
  resolveStateDir,
  updateState,
  upsertReview
} from "../scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");
const CLI = path.join(SCRIPTS, "codex-autoreview.mjs");
const SURFACE_HOOK = path.join(SCRIPTS, "surface-verdict-hook.mjs");
const SESSION_END_HOOK = path.join(SCRIPTS, "session-end-cleanup-hook.mjs");

/**
 * Fresh enabled repo with a fake codex on PATH.
 *
 * @returns {{ repo: string, binDir: string }}
 */
function setupEnabledRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  return { repo, binDir };
}

/**
 * Build a minimal-but-valid structured ReviewResult for a review record.
 *
 * @param {object} overrides
 * @returns {import("../scripts/lib/review-schema.mjs").ReviewResult}
 */
function makeResult(overrides = {}) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    kind: "code",
    profile: "generic-code",
    verdict: "ISSUES",
    confidence: "FEEDBACK",
    summary: "structured review summary",
    reviewedInputHash: null,
    claims: [],
    findings: [],
    unverified: [],
    usage: null,
    ...overrides
  };
}

/**
 * Run the surface hook for `sessionId` against `repo`.
 *
 * @param {string} repo
 * @param {string} binDir
 * @param {string | null} sessionId
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runSurface(repo, binDir, sessionId) {
  return run("node", [SURFACE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: sessionId }),
    env: buildEnv(binDir)
  });
}

// --- severity gating ------------------------------------------------------

test("surface hook injects high/medium findings and a next action for an ISSUES verdict", () => {
  const { repo, binDir } = setupEnabledRepo();
  upsertReview(repo, {
    id: "gated-issues",
    kind: "code",
    status: "completed",
    verdict: "ISSUES: two real bugs",
    output: "ISSUES: two real bugs",
    result: makeResult({
      verdict: "ISSUES",
      summary: "two real bugs",
      findings: [
        {
          severity: "high",
          file: "src/auth.js",
          line: 40,
          claim: "token is never checked for expiry",
          impact: "expired sessions stay valid",
          fix: "compare exp claim against now",
          confidence: "high",
          validity: "likely-valid",
          cost: "must-fix-now"
        },
        {
          severity: "medium",
          file: "src/util.js",
          line: 12,
          claim: "off-by-one in slice bound",
          impact: "last element dropped",
          fix: "use <= not <",
          confidence: "medium",
          validity: "likely-valid",
          cost: "can-defer"
        },
        {
          severity: "low",
          file: "src/util.js",
          line: 99,
          claim: "stale comment",
          impact: "minor confusion",
          fix: "update comment",
          confidence: "low",
          validity: "likely-valid",
          cost: "not-worth-it"
        }
      ]
    })
  });

  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);
  const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /ISSUES: two real bugs/);
  assert.match(ctx, /\[high\] token is never checked for expiry/);
  assert.match(ctx, /src\/auth\.js:40/);
  assert.match(ctx, /\[medium\] off-by-one in slice bound/);
  // Low-severity findings are gated OUT of the session.
  assert.doesNotMatch(ctx, /stale comment/);
  // A concrete next action is included.
  assert.match(ctx, /Next action:/);
});

test("surface hook keeps a CLEAN review quiet — claimed but not injected", () => {
  const { repo, binDir } = setupEnabledRepo();
  upsertReview(repo, {
    id: "quiet-clean",
    kind: "code",
    status: "completed",
    verdict: "CLEAN: no material bugs",
    output: "CLEAN: no material bugs",
    result: makeResult({
      verdict: "CLEAN",
      confidence: "VERIFIED",
      summary: "no material bugs",
      findings: [
        {
          severity: "low",
          file: "x.js",
          line: 1,
          claim: "nit",
          impact: "none",
          fix: "n/a",
          confidence: "low",
          validity: "likely-valid",
          cost: "not-worth-it"
        }
      ]
    })
  });

  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "a CLEAN review with no high/medium findings injects nothing");
  // ...but it IS claimed, so it never re-surfaces and lives in /last.
  const review = loadState(repo).reviews.find((r) => r.id === "quiet-clean");
  assert.ok(review.surfacedAt, "the quiet review must still be stamped surfacedAt");
});

test("surface hook injects a critical unverified gap even when the verdict is acceptable", () => {
  const { repo, binDir } = setupEnabledRepo();
  upsertReview(repo, {
    id: "clean-with-gap",
    kind: "code",
    status: "completed",
    verdict: "CLEAN: looks fine",
    output: "CLEAN: looks fine",
    result: makeResult({
      verdict: "CLEAN",
      confidence: "PARTIAL",
      summary: "looks fine but unproven",
      findings: [],
      unverified: [
        {
          gap: "no test exercises the migration rollback path",
          suggestedOracle: "add a dry-run rollback test",
          critical: true
        },
        {
          gap: "minor: lint not run",
          suggestedOracle: "run eslint",
          critical: false
        }
      ]
    })
  });

  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);
  const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Unverified \(critical/);
  assert.match(ctx, /migration rollback path/);
  assert.match(ctx, /add a dry-run rollback test/);
  // The non-critical gap is NOT surfaced into the session.
  assert.doesNotMatch(ctx, /lint not run/);
});

// --- accept/reject memory -------------------------------------------------

test("surface hook does not re-surface a finding the user already dismissed", () => {
  const { repo, binDir } = setupEnabledRepo();
  // The fingerprint must match the hook's computeFindingFingerprint:
  // sha256("<file lowercased>|<floor(line/10)*10>|<normalized claim>").
  // Use the same canonicalization the hook applies.
  const finding = {
    severity: "high",
    file: "src/Auth.js",
    line: 44,
    claim: "Token   is never checked for expiry",
    impact: "expired sessions stay valid",
    fix: "check exp",
    confidence: "high",
    validity: "likely-valid",
    cost: "must-fix-now"
  };
  // Derive the fingerprint the same way the hook does (see
  // computeFindingFingerprint): file lowercased/trimmed, line bucketed to 10s,
  // claim lowercased + whitespace-collapsed, joined with "|".
  const canonical = [
    finding.file.toLowerCase().trim(),
    String(Math.floor(finding.line / 10) * 10),
    finding.claim.toLowerCase().replace(/\s+/g, " ").trim()
  ].join("|");
  const fingerprint = `sha256-${createHash("sha256").update(canonical).digest("hex")}`;
  dismissFinding(repo, { fingerprint, disposition: "rejected", note: "false positive" });

  upsertReview(repo, {
    id: "dismissed-finding",
    kind: "code",
    status: "completed",
    verdict: "ISSUES: one finding",
    output: "ISSUES: one finding",
    result: makeResult({
      verdict: "ISSUES",
      summary: "one finding the user already rejected",
      findings: [finding]
    })
  });

  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);
  // The review's only finding was dismissed and there are no critical gaps —
  // so the whole review drops to /last and nothing is injected.
  assert.equal(result.stdout, "", "a review whose only finding was dismissed must not re-surface");
  const review = loadState(repo).reviews.find((r) => r.id === "dismissed-finding");
  assert.ok(review.surfacedAt, "the review is still claimed even when gated to /last");
});

// --- review-gap recording -------------------------------------------------

test("surface hook appends unverified gaps to the persistent reviewGaps accumulator", () => {
  const { repo, binDir } = setupEnabledRepo();
  upsertReview(repo, {
    id: "gap-recorder",
    kind: "code",
    status: "completed",
    verdict: "ISSUES: a bug plus a gap",
    output: "ISSUES: a bug plus a gap",
    result: makeResult({
      verdict: "ISSUES",
      summary: "a bug plus a gap",
      findings: [
        {
          severity: "high",
          file: "a.js",
          line: 1,
          claim: "real bug",
          impact: "boom",
          fix: "fix it",
          confidence: "high",
          validity: "likely-valid",
          cost: "must-fix-now"
        }
      ],
      unverified: [
        {
          gap: "behavior under concurrency not proven",
          suggestedOracle: "add a concurrent-access test",
          critical: false
        }
      ]
    })
  });

  assert.equal(listReviewGaps(repo).length, 0, "no gaps recorded before surfacing");
  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);

  const gaps = listReviewGaps(repo);
  assert.equal(gaps.length, 1, "the unverified gap should be persisted to reviewGaps[]");
  assert.equal(gaps[0].gap, "behavior under concurrency not proven");
  assert.equal(gaps[0].suggestedOracle, "add a concurrent-access test");
  assert.equal(gaps[0].reviewId, "gap-recorder");

  // Surfacing again (a later prompt) must NOT double-record — the review is
  // already claimed.
  const second = runSurface(repo, binDir, "s1");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(listReviewGaps(repo).length, 1, "gaps must not be re-recorded on a later prompt");
});

// --- failed / stuck surfacing ---------------------------------------------

test("surface hook injects a one-line notice for a silently failed review", () => {
  const { repo, binDir } = setupEnabledRepo();
  upsertReview(repo, {
    id: "failed-review",
    kind: "code",
    status: "failed",
    verdict: null,
    output: null,
    errorMessage: "Reviewer backend \"exec-generic\" failed: codex exited 1",
    request: { cwd: repo, prompt: "x", sessionId: "s1" }
  });

  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);
  const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /did NOT complete/i);
  assert.match(ctx, /FAILED to complete/);
  assert.match(ctx, /codex exited 1/);

  // The failed review is now stamped so it surfaces exactly once.
  const review = loadState(repo).reviews.find((r) => r.id === "failed-review");
  assert.ok(review.surfacedAt, "a surfaced failure notice must be stamped surfacedAt");
  assert.equal(review.surfacedSessionId, "s1");

  // A second prompt must not re-inject the same failure notice.
  const second = runSurface(repo, binDir, "s1");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "", "a failure notice must surface exactly once");
});

test("surface hook injects a stuck-review notice for a timed-out running review", () => {
  const { repo, binDir } = setupEnabledRepo();
  upsertReview(repo, {
    id: "stuck-review",
    kind: "plan",
    status: "running",
    request: { cwd: repo, prompt: "x", sessionId: "s1" }
  });
  // Backdate it well past the stale bound.
  updateState(repo, (state) => {
    const review = state.reviews.find((r) => r.id === "stuck-review");
    review.updatedAt = new Date(Date.now() - STALE_RUNNING_MS - 120_000).toISOString();
  });

  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);
  const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /appears STUCK/);
  assert.match(ctx, /did not complete/i);

  const review = loadState(repo).reviews.find((r) => r.id === "stuck-review");
  assert.ok(review.surfacedAt, "a surfaced stuck notice must be stamped surfacedAt");

  const second = runSurface(repo, binDir, "s1");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "", "a stuck notice must surface exactly once");
});

test("surface hook never steals another session's failure notice", () => {
  const { repo, binDir } = setupEnabledRepo();
  upsertReview(repo, {
    id: "failed-owned-by-A",
    kind: "code",
    status: "failed",
    errorMessage: "boom",
    request: { cwd: repo, prompt: "x", sessionId: "session-A" }
  });

  const fromB = runSurface(repo, binDir, "session-B");
  assert.equal(fromB.status, 0, fromB.stderr);
  assert.equal(fromB.stdout, "", "session B must not receive session A's failure notice");
  assert.ok(
    !loadState(repo).reviews.find((r) => r.id === "failed-owned-by-A").surfacedAt,
    "session B must not stamp session A's failed review"
  );

  const fromA = runSurface(repo, binDir, "session-A");
  assert.equal(fromA.status, 0, fromA.stderr);
  assert.match(
    JSON.parse(fromA.stdout).hookSpecificOutput.additionalContext,
    /FAILED to complete/
  );
});

// --- 10,000-char additionalContext cap ------------------------------------

test("surface hook truncates the injected context to stay under the additionalContext cap", () => {
  const { repo, binDir } = setupEnabledRepo();
  // Three reviews, each with a long structured finding, to push the combined
  // block toward the cap.
  const longText = "x".repeat(900);
  for (let i = 0; i < 3; i += 1) {
    upsertReview(repo, {
      id: `bulky-${i}`,
      kind: "code",
      status: "completed",
      verdict: `ISSUES: bulky review ${i}`,
      output: `ISSUES: bulky review ${i}`,
      result: makeResult({
        verdict: "ISSUES",
        summary: `bulky review ${i}`,
        findings: Array.from({ length: 4 }, (_, j) => ({
          severity: j % 2 === 0 ? "high" : "medium",
          file: `file-${i}-${j}.js`,
          line: j,
          claim: `finding ${j} ${longText}`,
          impact: `impact ${longText}`,
          fix: `fix ${longText}`,
          confidence: "high",
          validity: "likely-valid",
          cost: "must-fix-now"
        }))
      })
    });
  }

  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);
  const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  // Hard platform cap is 10,000 chars; the hook stays comfortably under it.
  assert.ok(ctx.length <= 10_000, `injected context must stay under the 10k cap (was ${ctx.length})`);
  assert.match(ctx, /truncated/i, "an over-budget block must carry a truncation marker");
  assert.match(ctx, /\/codex-autoreview:last/, "truncation must point at the full record");
});

test("surface hook still no-ops cleanly when the toggle is disabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  // Not enabled.
  upsertReview(repo, {
    id: "disabled-failed",
    kind: "code",
    status: "failed",
    errorMessage: "boom",
    request: { cwd: repo, prompt: "x", sessionId: "s1" }
  });
  const result = runSurface(repo, binDir, "s1");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "a disabled toggle injects nothing, not even failure notices");
});

// --- session-end digest ---------------------------------------------------

test("session-end hook emits a digest summarizing this session's review activity", () => {
  const { repo, binDir } = setupEnabledRepo();
  // A completed review with findings and usage.
  upsertReview(repo, {
    id: "digest-completed",
    kind: "code",
    status: "completed",
    verdict: "ISSUES: bugs",
    output: "ISSUES: bugs",
    request: { cwd: repo, prompt: "x", sessionId: "s1" },
    result: makeResult({
      verdict: "ISSUES",
      summary: "bugs",
      findings: [
        {
          severity: "high",
          file: "a.js",
          line: 1,
          claim: "h",
          impact: "i",
          fix: "f",
          confidence: "high",
          validity: "likely-valid",
          cost: "must-fix-now"
        },
        {
          severity: "low",
          file: "b.js",
          line: 2,
          claim: "l",
          impact: "i",
          fix: "f",
          confidence: "low",
          validity: "likely-valid",
          cost: "not-worth-it"
        }
      ],
      usage: {
        tokensIn: 1200,
        tokensOut: 340,
        costUsd: 0.0123,
        costEstimated: true,
        model: "gpt-5.5"
      }
    })
  });
  // A second completed review owned by this session, no usage.
  upsertReview(repo, {
    id: "digest-completed-2",
    kind: "plan",
    status: "completed",
    verdict: "SOUND: ok",
    output: "SOUND: ok",
    request: { cwd: repo, prompt: "y", sessionId: "s1" },
    result: makeResult({ kind: "plan", verdict: "SOUND", summary: "ok", findings: [] })
  });
  // A review owned by ANOTHER session — must not be counted.
  upsertReview(repo, {
    id: "digest-other-session",
    kind: "code",
    status: "completed",
    verdict: "CLEAN: ok",
    output: "CLEAN: ok",
    request: { cwd: repo, prompt: "z", sessionId: "other" },
    result: makeResult({ verdict: "CLEAN", summary: "ok" })
  });

  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1", reason: "clear" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  // The digest goes to stderr (SessionEnd has no additionalContext channel).
  assert.match(result.stderr, /session digest/);
  assert.match(result.stderr, /2 review\(s\)/, "only this session's 2 reviews are counted");
  assert.match(result.stderr, /2 completed/);
  assert.match(result.stderr, /2 finding\(s\) \[1 high, 0 medium, 1 low\]/);
  assert.match(result.stderr, /tokens: 1,200 in \/ 340 out/);
  assert.match(result.stderr, /est\. cost: ~\$0\.0123/);
  // The cleanup line is still emitted — the digest does not replace it.
  assert.match(result.stderr, /session cleanup/);
});

test("session-end hook emits no digest when this session ran no reviews", () => {
  const { repo, binDir } = setupEnabledRepo();
  // A review owned by a different session only.
  upsertReview(repo, {
    id: "not-mine",
    kind: "code",
    status: "completed",
    verdict: "CLEAN: ok",
    output: "CLEAN: ok",
    request: { cwd: repo, prompt: "x", sessionId: "someone-else" },
    result: makeResult({ verdict: "CLEAN", summary: "ok" })
  });

  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1", reason: "clear" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /session digest/, "no digest when the session ran no reviews");
  // Cleanup still runs.
  assert.match(result.stderr, /session cleanup/);
});

test("session-end digest counts reviews this session's cleanup just reconciled to failed", () => {
  const { repo, binDir } = setupEnabledRepo();
  // An in-flight review owned by this session — cleanup reconciles it to failed.
  upsertReview(repo, {
    id: "inflight-then-failed",
    kind: "code",
    status: "running",
    request: { cwd: repo, prompt: "x", sessionId: "s1" }
  });

  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1", reason: "clear" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /session digest/);
  assert.match(result.stderr, /1 review\(s\)/);
  assert.match(result.stderr, /1 failed/, "the reconciled in-flight review is counted as failed");
});

// helper: makeResult is exercised indirectly above; resolveStateDir import keeps
// the state-dir path resolvable in case a future test inspects it directly.
test("state dir resolves for the surfacing test repos", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  assert.ok(resolveStateDir(repo), "resolveStateDir must return a path");
});
