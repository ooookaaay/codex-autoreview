/**
 * Phase 1 FOUNDATION tests (F1–F6): the reviewer backend abstraction, the
 * claim-based review schema, the state-schema extensions, the git anchoring
 * primitives, the codex-call hardening, and the token/cost capture.
 *
 * Pure-unit where possible; the few integration paths use the shared test
 * helpers (fake codex, temp git repos).
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

// F1 — reviewer abstraction
import {
  BACKEND_IDS,
  DEFAULT_BACKEND_ID,
  getReviewerBackend,
  isKnownBackend
} from "../scripts/lib/reviewers/index.mjs";
import { parseReviewProseFindings } from "../scripts/lib/reviewers/exec-review.mjs";
import { validateExternalConfig } from "../scripts/lib/reviewers/external.mjs";

// F2 — claim-based schema
import {
  REVIEW_SCHEMA_VERSION,
  REVIEW_VERDICTS,
  fromVerdictLine,
  getReviewOutputSchema,
  normalizeReviewResult,
  renderCompactText,
  renderUsageLine,
  renderVerdictLine
} from "../scripts/lib/review-schema.mjs";

// F3 — state extensions
import {
  appendReviewGaps,
  dismissFinding,
  getPricingOverride,
  isFindingDismissed,
  isOnboarded,
  listDismissedFindings,
  listReviewGaps,
  loadState,
  markOnboarded,
  resolveStateDir,
  updateState
} from "../scripts/lib/state.mjs";

// F4 — git anchoring
import {
  computeDiffFingerprint,
  computePlanHash,
  sha256
} from "../scripts/lib/git.mjs";

// F5 — codex hardening
import {
  CODEX_ENV_ALLOWLIST,
  VALID_REASONING_EFFORTS,
  buildCodexChildEnv,
  buildCodexExecArgs,
  capStreamCapture,
  normalizeReasoningEffort,
  parseCodexJsonStream,
  readUserCodexDefaultModel,
  resolveEffectiveReviewModel
} from "../scripts/lib/codex.mjs";

// F6 — pricing
import {
  PRICING_AS_OF,
  computeCostUsd,
  getModelRate,
  isPricingStale,
  normalizeRateOverride,
  pricingStaleDays
} from "../scripts/lib/pricing.mjs";

// =========================================================================
// F1 — pluggable reviewer abstraction
// =========================================================================

test("F1: registry exposes all four backends and a non-breaking default", () => {
  assert.equal(DEFAULT_BACKEND_ID, "exec-generic");
  for (const id of ["exec-generic", "exec-review", "external", "app-server"]) {
    assert.ok(BACKEND_IDS.includes(id), `registry must include ${id}`);
    assert.ok(isKnownBackend(id));
  }
  assert.ok(!isKnownBackend("nope"));
  assert.ok(!isKnownBackend(undefined));
});

test("F1: getReviewerBackend falls back to the default for unknown/missing ids", () => {
  // An old queued record from before F1 has no `backend` field → must resolve
  // to the default so the migration is non-breaking.
  assert.equal(getReviewerBackend(undefined).id, DEFAULT_BACKEND_ID);
  assert.equal(getReviewerBackend(null).id, DEFAULT_BACKEND_ID);
  assert.equal(getReviewerBackend("").id, DEFAULT_BACKEND_ID);
  assert.equal(getReviewerBackend("bogus").id, DEFAULT_BACKEND_ID);
  assert.equal(getReviewerBackend("exec-review").id, "exec-review");
});

test("F1: every backend conforms to the ReviewerBackend interface", () => {
  for (const id of BACKEND_IDS) {
    const backend = getReviewerBackend(id);
    assert.equal(typeof backend.id, "string");
    assert.equal(typeof backend.probe, "function");
    assert.equal(typeof backend.run, "function");
    assert.equal(typeof backend.parse, "function");
    assert.ok(backend.capabilities && typeof backend.capabilities === "object");
    for (const cap of ["structuredOutput", "accurateUsage", "reviewScoped", "claimBased"]) {
      assert.equal(typeof backend.capabilities[cap], "boolean", `${id}.capabilities.${cap}`);
    }
  }
});

test("F1: capability metadata matches the codex-consult decision", () => {
  // exec-generic is the full structured path; exec-review is scoped-but-degraded.
  const generic = getReviewerBackend("exec-generic").capabilities;
  assert.ok(generic.structuredOutput && generic.accurateUsage && generic.claimBased);
  assert.equal(generic.reviewScoped, false);

  const review = getReviewerBackend("exec-review").capabilities;
  assert.equal(review.structuredOutput, false);
  assert.equal(review.accurateUsage, false);
  assert.equal(review.reviewScoped, true);
});

test("F1: scaffold backends never throw — run/parse degrade to a failed ParsedReview", async () => {
  for (const id of ["exec-review", "external", "app-server"]) {
    const backend = getReviewerBackend(id);
    const raw = await backend.run({
      cwd: "/tmp",
      prompt: "x",
      kind: "code",
      profile: "generic-code",
      outputFile: "/tmp/none",
      timeoutMs: 1000,
      env: {},
      onChild: () => {}
    });
    assert.equal(typeof raw.status, "number");
    const parsed = backend.parse(raw, { kind: "code", profile: "generic-code" });
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errorMessage, `${id}.parse must carry an error message`);
  }
});

test("F1: probe is non-throwing for the scaffold backends", () => {
  const external = getReviewerBackend("external");
  const result = external.probe({ cwd: "/tmp", env: {}, backendConfig: null });
  assert.equal(result.available, false);
  assert.ok(typeof result.detail === "string");
  const appServer = getReviewerBackend("app-server").probe({ cwd: "/tmp", env: {} });
  assert.equal(appServer.available, false);
});

test("F1: exec-review prose parser extracts [P1]/[P2] findings into the F2 shape", () => {
  const prose = [
    "Found 2 issues in the diff.",
    "Full review comments:",
    "- [P1] eval on user input — /repo/calc.py:5-7",
    "  If parse_int is called with a user string, eval executes arbitrary code.",
    "- [P2] missing null guard — /repo/util.js:12",
    "  The callback may be undefined.",
    "- [P3] minor naming nit"
  ].join("\n");
  const findings = parseReviewProseFindings(prose);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].file, "/repo/calc.py");
  assert.equal(findings[0].line, 5);
  assert.ok(findings[0].impact.includes("arbitrary code"));
  assert.equal(findings[1].severity, "medium");
  assert.equal(findings[1].line, 12);
  assert.equal(findings[2].severity, "low");
  assert.equal(findings[2].file, null);
});

test("F1: validateExternalConfig flags a malformed externalCommand config", () => {
  assert.deepEqual(
    validateExternalConfig({ command: "claude", args: ["-p"] }),
    [],
    "a minimal valid config has no problems"
  );
  assert.ok(validateExternalConfig({}).length > 0, "missing command is a problem");
  assert.ok(
    validateExternalConfig({ command: "x", promptDelivery: "telepathy" }).length > 0
  );
  assert.ok(
    validateExternalConfig({ command: "x", promptDelivery: "arg", args: ["-p"] }).length > 0,
    "arg delivery without {prompt} placeholder is a problem"
  );
});

// =========================================================================
// F2 — claim-based structured output schema
// =========================================================================

test("F2: getReviewOutputSchema is a valid draft-07 doc, usage NOT required", () => {
  const schema = getReviewOutputSchema();
  assert.equal(schema.type, "object");
  assert.equal(schema.properties.schemaVersion.const, REVIEW_SCHEMA_VERSION);
  // The model emits everything except `usage` — the worker merges that post-run.
  assert.ok(schema.required.includes("verdict"));
  assert.ok(schema.required.includes("claims"));
  assert.ok(!schema.required.includes("usage"), "usage is worker-merged, not model-emitted");
  // Returns a fresh copy each call (callers may write it to a temp file).
  assert.notEqual(getReviewOutputSchema(), schema);
});

test("F2: normalizeReviewResult tolerates partial/garbage input without throwing", () => {
  const fromGarbage = normalizeReviewResult("not json at all", { kind: "code" });
  assert.equal(fromGarbage.schemaVersion, REVIEW_SCHEMA_VERSION);
  assert.equal(fromGarbage.verdict, "FAILED");
  assert.deepEqual(fromGarbage.claims, []);

  const partial = normalizeReviewResult(
    { verdict: "issues", summary: "a bug", findings: [{ severity: "HIGH", claim: "x" }] },
    { kind: "code" }
  );
  assert.equal(partial.verdict, "ISSUES", "verdict enum is case-normalized");
  assert.equal(partial.findings.length, 1);
  assert.equal(partial.findings[0].severity, "high");
  // Missing required sub-fields get safe defaults rather than throwing.
  assert.equal(typeof partial.findings[0].fix, "string");
});

test("F2: fromVerdictLine maps a pinned verdict prefix to the schema enum", () => {
  const clean = fromVerdictLine("CLEAN: no material bugs found", { kind: "code" });
  assert.equal(clean.verdict, "CLEAN");
  assert.equal(clean.summary, "no material bugs found");
  assert.equal(clean.confidence, "PARTIAL", "a prose verdict has no decomposed claims");

  const concerns = fromVerdictLine("CONCERNS: sequencing risk", { kind: "plan" });
  assert.equal(concerns.verdict, "CONCERNS");
  assert.equal(concerns.kind, "plan");

  const garbage = fromVerdictLine("hello there", { kind: "code" });
  assert.equal(garbage.verdict, "FAILED");
  assert.equal(garbage.confidence, "FAILED");
});

test("F2: renderCompactText renders FROM the JSON — verdict line, findings, gaps, usage", () => {
  const result = {
    schemaVersion: 1,
    kind: "code",
    profile: "generic-code",
    verdict: "ISSUES",
    confidence: "FEEDBACK",
    summary: "one real bug",
    reviewedInputHash: null,
    claims: [],
    findings: [
      {
        severity: "high",
        file: "src/x.mjs",
        line: 42,
        claim: "null deref",
        impact: "crashes on empty input",
        fix: "guard the input",
        confidence: "high",
        validity: "likely-valid",
        cost: "must-fix-now"
      },
      // low-severity findings are NOT surfaced into the compact view
      {
        severity: "low",
        file: null,
        line: null,
        claim: "nit",
        impact: "",
        fix: "",
        confidence: "low",
        validity: "needs-human-check",
        cost: "not-worth-it"
      }
    ],
    unverified: [
      { gap: "no runtime test", suggestedOracle: "add an integration test", critical: true },
      { gap: "minor", suggestedOracle: "n/a", critical: false }
    ],
    usage: { tokensIn: 1200, tokensOut: 340, costUsd: 0.0042, costEstimated: true }
  };
  const text = renderCompactText(result);
  const lines = text.split("\n");
  assert.equal(lines[0], "ISSUES: one real bug");
  assert.ok(text.includes("[high] null deref — src/x.mjs:42"));
  assert.ok(!text.includes("[low]"), "low-severity findings stay out of the compact view");
  assert.ok(text.includes("! no runtime test"));
  assert.ok(!text.includes("! minor"), "non-critical gaps stay out of the compact view");
  assert.ok(text.includes("tokens: 1200/340"));
  // Sub-cent costs render with 4 decimals so they are not lost to rounding.
  assert.ok(text.includes("~$0.0042"));

  assert.equal(renderVerdictLine(result), "ISSUES: one real bug");
});

test("F2: renderUsageLine is honest about an unknown cost — no fake $0", () => {
  assert.equal(renderUsageLine(null), "");
  assert.equal(renderUsageLine({ tokensIn: 0, tokensOut: 0 }), "");
  const unknown = renderUsageLine({ tokensIn: 100, tokensOut: 20, costUsd: null, model: "mystery" });
  assert.ok(unknown.includes("~$?"), "unknown cost must not render as a number");
  assert.ok(unknown.includes("mystery"));
});

test("F2: every verdict enum value round-trips through fromVerdictLine", () => {
  for (const verdict of REVIEW_VERDICTS) {
    const result = fromVerdictLine(`${verdict}: summary text`, { kind: "code" });
    assert.equal(result.verdict, verdict);
  }
});

// =========================================================================
// F3 — state schema extensions
// =========================================================================

function freshRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  return repo;
}

test("F3: a fresh state file is v2 with the new keys defaulted", () => {
  const repo = freshRepo();
  // Touch state so it persists.
  updateState(repo, (state) => {
    state.config.enabled = true;
  });
  const state = loadState(repo);
  assert.equal(state.version, 2);
  assert.equal(state.config.backend, "exec-generic");
  assert.equal(state.config.backendConfig, null);
  assert.deepEqual(state.config.pricing, {});
  assert.deepEqual(state.config.dismissedFindings, []);
  assert.equal(state.config.onboardedAt, null);
  assert.deepEqual(state.reviewGaps, []);
});

test("F3: a legacy v1 state file loads as v2 — backward compatible", () => {
  const repo = freshRepo();
  // Touch state so the per-workspace state dir exists.
  updateState(repo, (state) => {
    state.config.enabled = true;
  });
  // Overwrite it with a v1-shaped state file by hand (no F3 keys at all).
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const legacy = {
    version: 1,
    config: { enabled: true, model: "gpt-5.4", effort: "high", timeoutMs: null },
    reviews: [
      {
        id: "old-1",
        kind: "code",
        status: "completed",
        verdict: "CLEAN: ok",
        output: "CLEAN: ok",
        errorMessage: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        logFile: null
      }
    ]
  };
  fs.writeFileSync(stateFile, JSON.stringify(legacy, null, 2), "utf8");

  const loaded = loadState(repo);
  assert.equal(loaded.version, 2, "a v1 file is read as v2 in memory");
  assert.equal(loaded.config.enabled, true, "v1 config values survive");
  assert.equal(loaded.config.model, "gpt-5.4");
  assert.equal(loaded.config.backend, "exec-generic", "missing F3 keys default");
  assert.equal(loaded.config.onboardedAt, null, "absent marker = not yet onboarded");
  assert.deepEqual(loaded.reviewGaps, []);
  assert.equal(loaded.reviews.length, 1, "v1 reviews survive the load");
});

test("F3: onboarding marker — absent = not onboarded, markOnboarded is idempotent", () => {
  const repo = freshRepo();
  assert.equal(isOnboarded(repo), false, "a fresh workspace is not onboarded");
  markOnboarded(repo, { now: "2026-05-14T10:00:00.000Z" });
  assert.equal(isOnboarded(repo), true);
  // Idempotent — a second call must not overwrite the original timestamp.
  markOnboarded(repo, { now: "2026-06-01T00:00:00.000Z" });
  assert.equal(loadState(repo).config.onboardedAt, "2026-05-14T10:00:00.000Z");
});

test("F3: review-gap accumulator collects unverified claims across reviews", () => {
  const repo = freshRepo();
  assert.deepEqual(listReviewGaps(repo), []);
  appendReviewGaps(repo, {
    reviewId: "r1",
    kind: "code",
    gaps: [
      { gap: "no runtime test for the new path", suggestedOracle: "add an integration test", critical: true },
      { gap: "", suggestedOracle: "ignored — empty gap" }
    ]
  });
  appendReviewGaps(repo, {
    reviewId: "r2",
    kind: "plan",
    gaps: [{ gap: "rollback path unproven", suggestedOracle: "dry-run oracle" }]
  });
  const gaps = listReviewGaps(repo);
  assert.equal(gaps.length, 2, "empty-gap entries are skipped");
  assert.equal(gaps[0].reviewId, "r1");
  assert.equal(gaps[0].critical, true);
  assert.equal(gaps[1].kind, "plan");
  assert.ok(gaps[1].recordedAt, "each gap is timestamped");
});

test("F3: accept/reject memory — dismissFinding is idempotent on the fingerprint", () => {
  const repo = freshRepo();
  const fp = sha256("src/x.mjs:40-42|null deref");
  assert.equal(isFindingDismissed(repo, fp), false);
  dismissFinding(repo, { fingerprint: fp, disposition: "rejected", note: "false positive" });
  assert.equal(isFindingDismissed(repo, fp), true);
  assert.equal(listDismissedFindings(repo).length, 1);
  // Re-dismissing the same fingerprint updates in place, never duplicates.
  dismissFinding(repo, { fingerprint: fp, disposition: "accepted" });
  const dismissed = listDismissedFindings(repo);
  assert.equal(dismissed.length, 1);
  assert.equal(dismissed[0].disposition, "accepted");
});

test("F3: per-model pricing override is readable from config", () => {
  const repo = freshRepo();
  assert.equal(getPricingOverride(repo, "gpt-5.5"), null);
  updateState(repo, (state) => {
    state.config.pricing = { "gpt-5.5": { in: 4.0, cachedIn: 0.4, out: 25.0 } };
  });
  const override = getPricingOverride(repo, "gpt-5.5");
  assert.ok(override);
  assert.equal(override.in, 4.0);
  assert.equal(getPricingOverride(repo, "gpt-5.4"), null, "no override for an unset model");
});

// =========================================================================
// F4 — git anchoring primitives
// =========================================================================

test("F4: sha256 produces the canonical sha256-<hex> shape", () => {
  const hash = sha256("hello");
  assert.match(hash, /^sha256-[0-9a-f]{64}$/);
  assert.equal(sha256("hello"), sha256("hello"), "deterministic");
  assert.notEqual(sha256("hello"), sha256("world"));
});

test("F4: computeDiffFingerprint is stable, and moves when the diff changes", () => {
  const repo = freshRepo();
  const clean = computeDiffFingerprint(repo);
  assert.equal(clean.available, true);
  assert.match(clean.fingerprint, /^sha256-[0-9a-f]{64}$/);
  assert.deepEqual(clean.changedFiles, [], "a clean tree has no changed files");

  // Introduce a change.
  fs.writeFileSync(path.join(repo, "a.txt"), "first content\n");
  const dirtyOne = computeDiffFingerprint(repo);
  assert.notEqual(dirtyOne.fingerprint, clean.fingerprint, "a new file moves the fingerprint");
  assert.ok(dirtyOne.changedFiles.includes("a.txt"));

  // Stable when nothing changes.
  assert.equal(computeDiffFingerprint(repo).fingerprint, dirtyOne.fingerprint);

  // Editing tracked content moves it again.
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-q", "-m", "add a"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "different content\n");
  const dirtyTwo = computeDiffFingerprint(repo);
  assert.notEqual(dirtyTwo.fingerprint, dirtyOne.fingerprint, "edited content moves the fingerprint");
});

test("F4: computeDiffFingerprint reports unavailable outside a git repo", () => {
  const notARepo = makeTempDir();
  const result = computeDiffFingerprint(notARepo);
  assert.equal(result.available, false);
  assert.equal(result.fingerprint, "");
});

test("F4: computePlanHash is stable across cosmetic re-renders", () => {
  const a = computePlanHash("## Plan\n1. step one\n2. step two\n");
  const b = computePlanHash("## Plan\n1. step one  \n2. step two\n\n"); // trailing ws + newline
  assert.equal(a, b, "trailing whitespace / newline differences do not move the hash");
  assert.match(a, /^sha256-[0-9a-f]{64}$/);
  assert.notEqual(a, computePlanHash("## Plan\n1. a different step\n"));
});

// =========================================================================
// F5 — codex-call hardening
// =========================================================================

test("F5: buildCodexExecArgs adds the unattended-run hardening flags", () => {
  const args = buildCodexExecArgs({
    model: null,
    effort: null,
    cwd: "/tmp/x",
    outputFile: "/tmp/x/out.txt"
  });
  assert.ok(args.includes("--ephemeral"), "no session rollout persisted");
  assert.ok(args.includes("--ignore-user-config"), "hermetic run");
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes('approval_policy="never"'), "never block on an approval prompt");
  assert.ok(
    args.includes('shell_environment_policy.inherit="none"'),
    "child shell inherits no env (research: 'core' is not minimal)"
  );
  assert.ok(args.includes('history.persistence="none"'));
  assert.ok(args.includes("--sandbox") && args.includes("read-only"));
});

test("F5: buildCodexExecArgs gates --json and --output-schema behind opt-in flags", () => {
  const plain = buildCodexExecArgs({ cwd: "/x", outputFile: "/x/o" });
  assert.ok(!plain.includes("--json"), "the legacy path is unaffected by default");
  assert.ok(!plain.includes("--output-schema"));

  const structured = buildCodexExecArgs({
    cwd: "/x",
    outputFile: "/x/o",
    json: true,
    schemaFile: "/x/schema.json"
  });
  assert.ok(structured.includes("--json"));
  assert.ok(structured.includes("--output-schema") && structured.includes("/x/schema.json"));
});

test("F5: VALID_REASONING_EFFORTS drops 'minimal'/'none' (fail with the review toolset)", () => {
  assert.deepEqual([...VALID_REASONING_EFFORTS], ["low", "medium", "high", "xhigh"]);
  assert.throws(() => normalizeReasoningEffort("minimal"), /Unsupported reasoning effort/);
  assert.throws(() => normalizeReasoningEffort("none"), /Unsupported reasoning effort/);
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
});

test("F5: buildCodexChildEnv copies ONLY allowlisted vars — secrets are dropped", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    CODEX_HOME: "/home/u/.codex",
    OPENAI_API_KEY: "sk-secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    SOME_RANDOM_TOKEN: "leak-me",
    EMPTY: ""
  };
  const child = buildCodexChildEnv(source);
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.HOME, "/home/u");
  assert.equal(child.CODEX_HOME, "/home/u/.codex");
  assert.equal(child.OPENAI_API_KEY, undefined, "API keys must never reach the child");
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(child.SOME_RANDOM_TOKEN, undefined);
  assert.equal(child.EMPTY, undefined, "empty values are not copied");
  // The allowlist is what governs — every copied key is on it.
  for (const key of Object.keys(child)) {
    assert.ok(CODEX_ENV_ALLOWLIST.includes(key), `${key} must be on the allowlist`);
  }
});

test("F5: capStreamCapture bounds a runaway stream, keeping the tail", () => {
  const small = "short text";
  assert.equal(capStreamCapture(small, 1024), small);
  const big = "x".repeat(5000) + "ERROR_AT_THE_END";
  const capped = capStreamCapture(big, 1000);
  assert.ok(capped.length < big.length);
  assert.ok(capped.includes("ERROR_AT_THE_END"), "the tail (where errors surface) is kept");
  assert.ok(capped.includes("truncated"), "the cut is marked");
});

test("F5: parseCodexJsonStream extracts usage, final message, and errors from JSONL", () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"abc-123"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"{\\"verdict\\":\\"pass\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1900,"cached_input_tokens":600,"output_tokens":42,"reasoning_output_tokens":20}}',
    "garbage line that is not json",
    '{"type":"some.future.event","ignored":true}'
  ].join("\n");
  const parsed = parseCodexJsonStream(jsonl);
  assert.equal(parsed.threadId, "abc-123");
  assert.equal(parsed.finalMessage, '{"verdict":"pass"}');
  assert.ok(parsed.usage);
  assert.equal(parsed.usage.tokensIn, 1900);
  assert.equal(parsed.usage.tokensCachedIn, 600);
  assert.equal(parsed.usage.tokensOut, 42);
  assert.equal(parsed.errorMessage, null, "no error in a clean stream");
});

test("F5: parseCodexJsonStream treats all-zeros usage as null (unavailable, not free)", () => {
  // `codex exec review` reports usage as all-zeros — must not be priced as $0.
  const jsonl =
    '{"type":"turn.completed","usage":{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}}';
  assert.equal(parseCodexJsonStream(jsonl).usage, null);
});

test("F5: parseCodexJsonStream double-decodes a JSON-encoded error message", () => {
  const jsonl = [
    '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"message\\":\\"model not supported\\"}}"}',
    '{"type":"turn.failed","error":{"message":"{...}"}}'
  ].join("\n");
  const parsed = parseCodexJsonStream(jsonl);
  assert.equal(parsed.errorMessage, "model not supported");
});

test("F5: readUserCodexDefaultModel reads ONLY the top-level model key", () => {
  const codexHome = makeTempDir();
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      "# user config",
      'model = "gpt-5.4"',
      'approval_policy = "on-request"',
      "[profiles.fast]",
      'model = "gpt-5.4-mini"' // nested — must NOT be picked up
    ].join("\n"),
    "utf8"
  );
  assert.equal(
    readUserCodexDefaultModel({ env: { CODEX_HOME: codexHome } }),
    "gpt-5.4"
  );
  // Missing config → null, never a throw.
  assert.equal(readUserCodexDefaultModel({ env: { CODEX_HOME: makeTempDir() } }), null);
});

test("F5: resolveEffectiveReviewModel — plugin override wins, else user config, else null", () => {
  const codexHome = makeTempDir();
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.4"\n', "utf8");
  const env = { CODEX_HOME: codexHome };
  // Plugin override wins.
  assert.equal(
    resolveEffectiveReviewModel({ model: "gpt-5.3-codex" }, { env }),
    "gpt-5.3-codex"
  );
  // No plugin override → fall back to the user's config.toml default.
  assert.equal(resolveEffectiveReviewModel({ model: null }, { env }), "gpt-5.4");
  // Neither → null (codex built-in default applies).
  assert.equal(
    resolveEffectiveReviewModel({ model: null }, { env: { CODEX_HOME: makeTempDir() } }),
    null
  );
});

// =========================================================================
// F6 — token / cost capture
// =========================================================================

test("F6: getModelRate returns hardcoded rates and null for unknown models", () => {
  const rate = getModelRate("gpt-5.5");
  assert.ok(rate && rate.in === 5.0 && rate.out === 30.0);
  assert.equal(getModelRate("gpt-9-imaginary"), null);
  assert.equal(getModelRate(""), null);
  assert.equal(getModelRate(undefined), null);
});

test("F6: computeCostUsd prices a known model — cached input billed cheaper", () => {
  // gpt-5.5: in 5.00, cachedIn 0.50, out 30.00 per 1M.
  // 1M fresh in + 1M cached in + 1M out = 5 + 0.5 + 30 = 35.50
  const result = computeCostUsd({
    model: "gpt-5.5",
    usage: { tokensIn: 2_000_000, tokensCachedIn: 1_000_000, tokensOut: 1_000_000 }
  });
  assert.equal(result.costUsd, 35.5);
  assert.equal(result.costEstimated, true);
  assert.equal(result.pricedWith, PRICING_AS_OF);
});

test("F6: computeCostUsd — unknown model yields costUsd:null, never throws, never $0", () => {
  const result = computeCostUsd({
    model: "gpt-totally-unknown",
    usage: { tokensIn: 1_000_000, tokensOut: 500_000 }
  });
  assert.equal(result.costUsd, null, "unknown model must not be priced as $0");
  assert.equal(result.costEstimated, false);
  assert.equal(result.pricedWith, null);
});

test("F6: computeCostUsd honors a per-run rate override over the table", () => {
  const result = computeCostUsd({
    model: "gpt-5.5",
    usage: { tokensIn: 1_000_000, tokensOut: 0 },
    rateOverride: { in: 1.0, out: 2.0 }
  });
  assert.equal(result.costUsd, 1.0, "override rate (1.0/1M in) wins over the table's 5.0");
  assert.equal(result.pricedWith, "override");
});

test("F6: computeCostUsd clamps nonsense token counts and never throws", () => {
  const result = computeCostUsd({
    model: "gpt-5.5",
    usage: { tokensIn: -100, tokensCachedIn: 999999, tokensOut: NaN }
  });
  // negative/NaN → 0; cached can't exceed input → 0; cost is 0, not an error.
  assert.equal(result.costUsd, 0);
});

test("F6: normalizeRateOverride validates shape and defaults cachedIn", () => {
  assert.equal(normalizeRateOverride(null), null);
  assert.equal(normalizeRateOverride({ in: "abc", out: 5 }), null);
  const ok = normalizeRateOverride({ in: 3.0, out: 12.0 });
  assert.ok(ok);
  assert.equal(ok.cachedIn, 0.3, "cachedIn defaults to in/10 when omitted");
  assert.equal(normalizeRateOverride({ in: 3.0, cachedIn: 0.1, out: 12.0 }).cachedIn, 0.1);
});

test("F6: pricing staleness is a soft signal, computed from PRICING_AS_OF", () => {
  assert.equal(typeof PRICING_AS_OF, "string");
  // Fresh today.
  const asOfMs = Date.parse(`${PRICING_AS_OF}T00:00:00Z`);
  assert.equal(pricingStaleDays({ now: asOfMs }), 0);
  assert.equal(isPricingStale({ now: asOfMs }), false);
  // 200 days later it is stale.
  const later = asOfMs + 200 * 24 * 60 * 60 * 1000;
  assert.ok(pricingStaleDays({ now: later }) > 120);
  assert.equal(isPricingStale({ now: later }), true);
});
