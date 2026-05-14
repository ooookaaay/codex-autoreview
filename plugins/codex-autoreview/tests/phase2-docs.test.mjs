/**
 * Phase 2 Wave C tests: review-prompt assembly seam, the versioned verifier
 * contract and six review profiles, the live statusline indicator, and the
 * release metadata in the plugin manifest / changelog / README.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";

import {
  DEFAULT_PROFILE_FOR_KIND,
  PROJECT_INSTRUCTIONS_FILENAME,
  assembleReviewPrompt,
  findProjectInstructionsPath,
  readProjectInstructions,
  resolveProfileForKind
} from "../scripts/lib/prompts.mjs";
import { buildStatuslineSegment, formatElapsed } from "../scripts/statusline.mjs";
import { saveState, setConfig } from "../scripts/lib/state.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS_DIR = path.join(ROOT_DIR, "prompts");
const PROFILES_DIR = path.join(PROMPTS_DIR, "profiles");

const ALL_PROFILES = [
  "generic-code",
  "plan-devils-advocate",
  "security-review",
  "migration-review",
  "ai-eval-review",
  "gsd-plan-review"
];

// ── verifier contract + profile files ──────────────────────────────────────

test("2C: the verifier contract file exists and carries the core directives", () => {
  const contract = fs.readFileSync(path.join(PROMPTS_DIR, "_verifier-contract.md"), "utf8");
  assert.match(contract, /<verifier_contract>/);
  assert.match(contract, /verifier, not a builder/i);
  assert.match(contract, /DECOMPOSE/);
  assert.match(contract, /Deterministic evidence only/i);
  assert.match(contract, /is a CLAIM, never\s+evidence/i);
  assert.match(contract, /unverified\[\]/);
  assert.match(contract, /Return ONLY JSON/i);
  assert.match(contract, /PERFECT/);
  assert.match(contract, /FAILED/);
});

test("2C: all six review profiles exist with emphasis, evidence, and caps", () => {
  for (const profile of ALL_PROFILES) {
    const body = fs.readFileSync(path.join(PROFILES_DIR, `${profile}.md`), "utf8");
    assert.match(body, new RegExp(`name="${profile}"`), `${profile}: declares its name`);
    assert.match(body, /EMPHASIS/, `${profile}: has an EMPHASIS section`);
    assert.match(body, /EVIDENCE BAR/, `${profile}: has an EVIDENCE BAR section`);
    assert.match(body, /FINDING BAR/, `${profile}: has a FINDING BAR section`);
    assert.match(body, /OUTPUT CAPS/, `${profile}: has an OUTPUT CAPS section`);
    assert.match(body, /findings: at most \d+/, `${profile}: caps findings`);
    assert.match(body, /claims: at most \d+/, `${profile}: caps claims`);
  }
});

test("2C: security-review gets the higher finding cap and favors false positives", () => {
  const body = fs.readFileSync(path.join(PROFILES_DIR, "security-review.md"), "utf8");
  assert.match(body, /findings: at most 12/);
  assert.match(body, /[Ff]alse positives over false negatives/);
});

test("2C: the only profile files on disk are the six known profiles", () => {
  const onDisk = fs
    .readdirSync(PROFILES_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
  assert.deepEqual(onDisk, [...ALL_PROFILES].sort());
});

// ── assembleReviewPrompt — the stable seam ─────────────────────────────────

test("2C: assembleReviewPrompt composes contract + profile + task block", () => {
  const prompt = assembleReviewPrompt({ kind: "code", cwd: "/nonexistent-repo" });
  assert.match(prompt, /<verifier_contract>/);
  assert.match(prompt, /name="generic-code"/);
  assert.match(prompt, /<task kind="code">/);
  // placeholders are LEFT INTACT for the worker to fill
  assert.match(prompt, /\{\{CLAUDE_RESPONSE_BLOCK\}\}/);
  assert.match(prompt, /\{\{REVIEWED_INPUT_HASH\}\}/);
  // contract comes before the profile, profile before the task block
  assert.ok(
    prompt.indexOf("<verifier_contract>") <
      prompt.indexOf('name="generic-code"') &&
      prompt.indexOf('name="generic-code"') < prompt.indexOf('<task kind="code">'),
    "sections are ordered: contract → profile → task"
  );
});

test("2C: assembleReviewPrompt defaults the profile per kind", () => {
  const code = assembleReviewPrompt({ kind: "code", cwd: "/nonexistent", profile: null });
  assert.match(code, /name="generic-code"/);
  const plan = assembleReviewPrompt({ kind: "plan", cwd: "/nonexistent", profile: null });
  assert.match(plan, /name="plan-devils-advocate"/);
  assert.equal(DEFAULT_PROFILE_FOR_KIND.code, "generic-code");
  assert.equal(DEFAULT_PROFILE_FOR_KIND.plan, "plan-devils-advocate");
});

test("2C: assembleReviewPrompt honors an explicit known profile", () => {
  const prompt = assembleReviewPrompt({
    kind: "code",
    profile: "security-review",
    cwd: "/nonexistent"
  });
  assert.match(prompt, /name="security-review"/);
  assert.doesNotMatch(prompt, /name="generic-code"/);
});

test("2C: assembleReviewPrompt rejects an unsupported kind", () => {
  assert.throws(
    () => assembleReviewPrompt({ kind: "docs", cwd: "/nonexistent" }),
    /unsupported kind/
  );
});

test("2C: assembleReviewPrompt folds in project-local .codex-autoreview.md", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const instructions = "Always treat the public API surface as load-bearing.";
  fs.writeFileSync(path.join(repo, PROJECT_INSTRUCTIONS_FILENAME), `${instructions}\n`);

  const withConfig = assembleReviewPrompt({ kind: "code", cwd: repo });
  assert.match(withConfig, /<project_instructions>/);
  assert.match(withConfig, new RegExp(instructions.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // explicit null skips project instructions entirely
  const skipped = assembleReviewPrompt({
    kind: "code",
    cwd: repo,
    projectInstructionsPath: null
  });
  assert.doesNotMatch(skipped, /<project_instructions>/);
});

test("2C: assembleReviewPrompt omits the project block when no file is present", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const prompt = assembleReviewPrompt({ kind: "plan", cwd: repo });
  assert.doesNotMatch(prompt, /<project_instructions>/);
});

test("2C: findProjectInstructionsPath walks up to the git root", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, PROJECT_INSTRUCTIONS_FILENAME), "root-level config\n");
  const nested = path.join(repo, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });

  const found = findProjectInstructionsPath(nested);
  assert.equal(found, path.join(repo, PROJECT_INSTRUCTIONS_FILENAME));
  assert.equal(findProjectInstructionsPath(makeTempDir()), null);
});

test("2C: readProjectInstructions truncates a runaway file", () => {
  const repo = makeTempDir();
  const file = path.join(repo, PROJECT_INSTRUCTIONS_FILENAME);
  fs.writeFileSync(file, "x".repeat(20000));
  const read = readProjectInstructions(file, { maxChars: 500 });
  assert.ok(read.length < 700, "truncated near the cap");
  assert.match(read, /truncated at 500 chars/);
  assert.equal(readProjectInstructions(null), "");
  assert.equal(readProjectInstructions("/does/not/exist"), "");
});

test("2C: resolveProfileForKind falls back for unknown/missing profiles", () => {
  assert.equal(resolveProfileForKind("code", "ai-eval-review"), "ai-eval-review");
  assert.equal(resolveProfileForKind("code", "bogus"), "generic-code");
  assert.equal(resolveProfileForKind("plan", null), "plan-devils-advocate");
  assert.equal(resolveProfileForKind("plan", undefined), "plan-devils-advocate");
});

// ── statusline ─────────────────────────────────────────────────────────────

test("2C: formatElapsed renders compact spans", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(45_000), "45s");
  assert.equal(formatElapsed(83_000), "1m23s");
  assert.equal(formatElapsed(60_000), "1m00s");
  assert.equal(formatElapsed(7_500_000), "2h05m");
  assert.equal(formatElapsed(-100), "0s");
});

test("2C: statusline is empty when the toggle is off", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  assert.equal(buildStatuslineSegment(repo), "");
});

test("2C: statusline shows the idle marker with no review history", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  setConfig(repo, "enabled", true);
  const segment = buildStatuslineSegment(repo);
  assert.match(segment, /^codex-autoreview: ON \(/);
});

test("2C: statusline shows a live indicator while a review runs", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const now = Date.now();
  const recent = new Date(now - 83_000).toISOString();
  saveState(repo, {
    config: { enabled: true },
    reviews: [
      {
        id: "r-running",
        kind: "code",
        status: "running",
        verdict: null,
        output: null,
        errorMessage: null,
        logFile: null,
        createdAt: recent,
        updatedAt: recent
      }
    ]
  });
  const segment = buildStatuslineSegment(repo, { now });
  assert.match(segment, /⏳ code review · 1m23s/);
});

test("2C: statusline appends pending:N when reviews are backlogged", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const now = Date.now();
  const recent = new Date(now - 5_000).toISOString();
  saveState(repo, {
    config: { enabled: true },
    reviews: [
      {
        id: "r-running",
        kind: "code",
        status: "running",
        verdict: null,
        output: null,
        errorMessage: null,
        logFile: null,
        createdAt: recent,
        updatedAt: recent
      },
      {
        id: "r-queued",
        kind: "plan",
        status: "queued",
        verdict: null,
        output: null,
        errorMessage: null,
        logFile: null,
        createdAt: recent,
        updatedAt: recent
      }
    ]
  });
  const segment = buildStatuslineSegment(repo, { now });
  assert.match(segment, /⏳ code review/);
  assert.match(segment, /pending:1/);
});

test("2C: statusline flags a stuck in-flight review as FAILED · stale", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const now = Date.now();
  // 20 minutes ago — well past the 10-minute stale floor.
  const old = new Date(now - 20 * 60_000).toISOString();
  saveState(repo, {
    config: { enabled: true },
    reviews: [
      {
        id: "r-stuck",
        kind: "code",
        status: "running",
        verdict: null,
        output: null,
        errorMessage: null,
        logFile: null,
        createdAt: old,
        updatedAt: old
      }
    ]
  });
  assert.equal(buildStatuslineSegment(repo, { now }), "codex-autoreview: FAILED · stale");
});

test("2C: statusline shows pending:N when only queued reviews exist", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const now = Date.now();
  const recent = new Date(now - 2_000).toISOString();
  saveState(repo, {
    config: { enabled: true },
    reviews: [
      {
        id: "r-q1",
        kind: "code",
        status: "queued",
        verdict: null,
        output: null,
        errorMessage: null,
        logFile: null,
        createdAt: recent,
        updatedAt: recent
      },
      {
        id: "r-q2",
        kind: "plan",
        status: "queued",
        verdict: null,
        output: null,
        errorMessage: null,
        logFile: null,
        createdAt: recent,
        updatedAt: recent
      }
    ]
  });
  assert.equal(buildStatuslineSegment(repo, { now }), "codex-autoreview: pending:2");
});

test("2C: statusline reflects the latest terminal verdict + confidence", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const now = Date.now();
  const ts = new Date(now - 30_000).toISOString();
  saveState(repo, {
    config: { enabled: true },
    reviews: [
      {
        id: "r-done",
        kind: "code",
        status: "completed",
        verdict: "ISSUES: a real bug",
        output: "ISSUES: a real bug",
        errorMessage: null,
        logFile: null,
        createdAt: ts,
        updatedAt: ts,
        result: {
          schemaVersion: 1,
          kind: "code",
          profile: "generic-code",
          verdict: "ISSUES",
          confidence: "FEEDBACK",
          summary: "a real bug",
          claims: [],
          findings: [],
          unverified: [],
          reviewedInputHash: `sha256-${"0".repeat(64)}`
        }
      }
    ]
  });
  assert.equal(buildStatuslineSegment(repo, { now }), "codex-autoreview: ISSUES · FEEDBACK");
});

test("2C: statusline shows FAILED for a failed terminal review", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const now = Date.now();
  const ts = new Date(now - 30_000).toISOString();
  saveState(repo, {
    config: { enabled: true },
    reviews: [
      {
        id: "r-failed",
        kind: "code",
        status: "failed",
        verdict: null,
        output: null,
        errorMessage: "codex crashed",
        logFile: null,
        createdAt: ts,
        updatedAt: ts
      }
    ]
  });
  assert.equal(buildStatuslineSegment(repo, { now }), "codex-autoreview: FAILED");
});

// ── release metadata ───────────────────────────────────────────────────────

test("2C: plugin.json carries the public-distribution metadata", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, ".claude-plugin", "plugin.json"), "utf8")
  );
  assert.equal(manifest.name, "codex-autoreview");
  assert.match(manifest.version, /^0\.3\./);
  assert.equal(typeof manifest.repository, "string");
  assert.equal(typeof manifest.homepage, "string");
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0);
  assert.equal(manifest.license, "Apache-2.0");
  // The statusLine key is intentionally NOT registered here — Claude Code does
  // not honor it from a plugin manifest (documented in the README instead).
  assert.equal(manifest.statusLine, undefined);
});

test("2C: the changelog has a 0.3 entry", () => {
  const changelog = fs.readFileSync(path.join(ROOT_DIR, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## 0\.3\.0/);
});

test("2C: the README documents the new surfaces", () => {
  const readme = fs.readFileSync(path.join(ROOT_DIR, "README.md"), "utf8");
  assert.match(readme, /\.codex-autoreview\.md/);
  assert.match(readme, /profile/i); // review profiles
  assert.match(readme, /statusLine/); // the manual settings.json entry
  assert.match(readme, /\/codex-autoreview:doctor/); // doctor command
  assert.match(readme, /Privacy/i); // privacy notes
  assert.match(readme, /codex` CLI/i); // the separate codex CLI prerequisite
});
