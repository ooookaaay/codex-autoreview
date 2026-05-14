/**
 * Phase 2 — Wave B tests: the CLI subcommands (`config` extended surface,
 * `run`, `onboard`, `doctor`), the slash-command `.md` contract, the reviewer
 * backends (`external`, `exec-review`, `app-server`), and the two-reviewer
 * comparison/consensus logic.
 *
 * Pure-unit where possible; the CLI paths run the real `codex-autoreview.mjs`
 * against a temp repo with a fake `codex` on PATH (shared test helpers).
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  buildEnv,
  buildEnvWithoutCodex,
  initGitRepo,
  installFakeCodex,
  makeTempDir,
  run
} from "./helpers.mjs";

// Reviewer backends — Wave 2B.
import {
  buildExternalChildEnv,
  externalBackend,
  parseExternalOutput,
  resolveDotPath,
  spawnWithTimeout,
  validateExternalConfig
} from "../scripts/lib/reviewers/external.mjs";
import {
  buildCodexExecReviewArgs,
  execReviewBackend
} from "../scripts/lib/reviewers/exec-review.mjs";
import {
  appServerBackend,
  buildInitializeRequest,
  buildReviewStartRequest,
  buildReviewTarget,
  buildThreadStartRequest,
  extractReviewTextFromEvent,
  isExitedReviewModeEvent
} from "../scripts/lib/reviewers/app-server.mjs";

// Two-reviewer consensus — Wave 2B.
import {
  buildMergedVerdictLine,
  compareFindings,
  compareReviews,
  findingsOverlap,
  fingerprintFinding,
  mergeVerdicts,
  normalizeTitle,
  verdictSeverity
} from "../scripts/lib/comparison.mjs";

import { loadState } from "../scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "codex-autoreview.mjs");
const COMMANDS_DIR = path.join(ROOT, "commands");

/**
 * @returns {{ repo: string, binDir: string }}
 */
function setupRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  return { repo, binDir };
}

// =========================================================================
// CLI — `config` extended surface (backend, backend-config, profile, pricing)
// =========================================================================

test("config persists a known reviewer backend and rejects an unknown one", () => {
  const { repo, binDir } = setupRepo();
  const set = run("node", [CLI, "config", "--backend", "exec-review", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).backend, "exec-review");

  const bad = run("node", [CLI, "config", "--backend", "not-a-backend", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown reviewer backend/);
  // The bad write must not have changed the persisted backend.
  assert.equal(loadState(repo).config.backend, "exec-review");
});

test("config clears the backend back to the default with --backend ''", () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--backend", "external", "--cwd", repo], { env: buildEnv(binDir) });
  const cleared = run("node", [CLI, "config", "--backend", "", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(JSON.parse(cleared.stdout).backend, "exec-generic");
});

test("config validates and persists a valid externalCommand backend config", () => {
  const { repo, binDir } = setupRepo();
  const cfg = JSON.stringify({
    command: "claude",
    args: ["-p", "--output-format", "json"],
    promptDelivery: "stdin",
    outputCapture: "stdout",
    outputFormat: "json",
    resultPath: "result"
  });
  const set = run(
    "node",
    [CLI, "config", "--backend", "external", "--backend-config", cfg, "--cwd", repo, "--json"],
    { env: buildEnv(binDir) }
  );
  assert.equal(set.status, 0, set.stderr);
  const payload = JSON.parse(set.stdout);
  assert.equal(payload.backend, "external");
  assert.equal(payload.backendConfigured, true);
  assert.equal(loadState(repo).config.backendConfig.command, "claude");
});

test("config rejects a malformed externalCommand config and leaves state untouched", () => {
  const { repo, binDir } = setupRepo();
  const bad = run(
    "node",
    [CLI, "config", "--backend-config", JSON.stringify({ args: ["x"] }), "--cwd", repo, "--json"],
    { env: buildEnv(binDir) }
  );
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Invalid externalCommand config/);
  assert.equal(loadState(repo).config.backendConfig, null);
});

test("config --clear-backend-config removes a previously-set externalCommand config", () => {
  const { repo, binDir } = setupRepo();
  run(
    "node",
    [
      CLI,
      "config",
      "--backend-config",
      JSON.stringify({ command: "gemini" }),
      "--cwd",
      repo
    ],
    { env: buildEnv(binDir) }
  );
  assert.equal(loadState(repo).config.backendConfig.command, "gemini");
  run("node", [CLI, "config", "--clear-backend-config", "--cwd", repo], { env: buildEnv(binDir) });
  assert.equal(loadState(repo).config.backendConfig, null);
});

test("config persists a known review profile and rejects an unknown one", () => {
  const { repo, binDir } = setupRepo();
  const set = run(
    "node",
    [CLI, "config", "--profile", "security-review", "--cwd", repo, "--json"],
    { env: buildEnv(binDir) }
  );
  assert.equal(JSON.parse(set.stdout).profile, "security-review");

  const bad = run("node", [CLI, "config", "--profile", "nonsense", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown review profile/);
});

test("config persists pricing overrides and rejects malformed rates", () => {
  const { repo, binDir } = setupRepo();
  const set = run(
    "node",
    [
      CLI,
      "config",
      "--pricing",
      JSON.stringify({ "gpt-5.5": { in: 5, out: 30 } }),
      "--cwd",
      repo,
      "--json"
    ],
    { env: buildEnv(binDir) }
  );
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout).pricingOverrides, ["gpt-5.5"]);
  assert.equal(loadState(repo).config.pricing["gpt-5.5"].in, 5);

  const bad = run(
    "node",
    [CLI, "config", "--pricing", JSON.stringify({ "gpt-5.5": { in: -1 } }), "--cwd", repo],
    { env: buildEnv(binDir) }
  );
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Invalid pricing override/);
});

test("config --clear-pricing empties the pricing overrides", () => {
  const { repo, binDir } = setupRepo();
  run(
    "node",
    [CLI, "config", "--pricing", JSON.stringify({ "gpt-5.4": { in: 2.5, out: 15 } }), "--cwd", repo],
    { env: buildEnv(binDir) }
  );
  run("node", [CLI, "config", "--clear-pricing", "--cwd", repo], { env: buildEnv(binDir) });
  assert.deepEqual(loadState(repo).config.pricing, {});
});

test("config report surfaces the onboarding state", () => {
  const { repo, binDir } = setupRepo();
  const before = run("node", [CLI, "config", "--cwd", repo], { env: buildEnv(binDir) });
  assert.match(before.stdout, /onboarded: NO/);
});

// =========================================================================
// CLI — `onboard`
// =========================================================================

test("onboard reports a checklist and the not-onboarded state", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "onboard", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.onboarded, false);
  assert.ok(Array.isArray(payload.steps) && payload.steps.length >= 2);
  // The codex-installed step reflects the fake codex on PATH.
  const codexStep = payload.steps.find((s) => s.id === "codex-installed");
  assert.equal(codexStep.done, true);
});

test("onboard --complete marks the project onboarded (idempotently)", () => {
  const { repo, binDir } = setupRepo();
  const first = run("node", [CLI, "onboard", "--complete", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  const firstPayload = JSON.parse(first.stdout);
  assert.equal(firstPayload.onboarded, true);
  assert.ok(firstPayload.onboardedAt);
  assert.equal(loadState(repo).config.onboardedAt, firstPayload.onboardedAt);

  // Re-running --complete must NOT overwrite the original timestamp.
  const second = run("node", [CLI, "onboard", "--complete", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(JSON.parse(second.stdout).onboardedAt, firstPayload.onboardedAt);
});

// =========================================================================
// CLI — `doctor`
// =========================================================================

test("doctor reports OK for the codex CLI when a fake codex is on PATH", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "doctor", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const codexCheck = payload.checks.find((c) => c.name === "codex CLI");
  assert.equal(codexCheck.status, "ok");
});

test("doctor flags a missing codex CLI as an error and exits non-zero", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const result = run("node", [CLI, "doctor", "--cwd", repo, "--json"], {
    env: buildEnvWithoutCodex()
  });
  // overall === "error" exits 1.
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.overall, "error");
  const codexCheck = payload.checks.find((c) => c.name === "codex CLI");
  assert.equal(codexCheck.status, "error");
  assert.ok(codexCheck.action.includes("npm install -g @openai/codex"));
});

test("doctor flags a not-onboarded project with a warning", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "doctor", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  const payload = JSON.parse(result.stdout);
  const onboarding = payload.checks.find((c) => c.name === "onboarding");
  assert.equal(onboarding.status, "warn");
});

test("doctor flags an invalid externalCommand config", () => {
  const { repo, binDir } = setupRepo();
  // Force an invalid config directly into state, then set the backend.
  run("node", [CLI, "config", "--backend", "external", "--cwd", repo], { env: buildEnv(binDir) });
  const stateFile = path.join(
    JSON.parse(
      run("node", [CLI, "doctor", "--cwd", repo, "--json"], { env: buildEnv(binDir) }).stdout
    ).stateDir,
    "state.json"
  );
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.config.backendConfig = { args: ["x"] }; // no `command`
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const result = run("node", [CLI, "doctor", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  const payload = JSON.parse(result.stdout);
  const configCheck = payload.checks.find((c) => c.name === "config");
  assert.equal(configCheck.status, "error");
  assert.match(configCheck.detail, /externalCommand/);
});

test("doctor reports the pricing table check", () => {
  const { repo, binDir } = setupRepo();
  const payload = JSON.parse(
    run("node", [CLI, "doctor", "--cwd", repo, "--json"], { env: buildEnv(binDir) }).stdout
  );
  const pricing = payload.checks.find((c) => c.name === "pricing table");
  assert.ok(pricing);
  assert.ok(["ok", "warn"].includes(pricing.status));
});

// =========================================================================
// CLI — `run`
// =========================================================================

test("run refuses cleanly when the working tree has no uncommitted changes", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "run", "code", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ran, false);
  assert.match(payload.reason, /no uncommitted changes/);
});

test("run refuses when the codex CLI is absent", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "change.txt"), "dirty\n");
  const result = run("node", [CLI, "run", "code", "--cwd", repo, "--json"], {
    env: buildEnvWithoutCodex()
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ran, false);
  assert.match(payload.reason, /not available/i);
});

test("run --no-wait dispatches a manual code review and returns immediately", () => {
  const { repo, binDir } = setupRepo();
  fs.writeFileSync(path.join(repo, "change.txt"), "dirty content\n");
  const result = run("node", [CLI, "run", "code", "--no-wait", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ran, true);
  assert.equal(payload.waited, false);
  assert.ok(payload.reviewId);
  // The review record was persisted.
  const review = loadState(repo).reviews.find((r) => r.id === payload.reviewId);
  assert.ok(review);
  assert.equal(review.kind, "code");
});

test("run waits for the verdict and prints it (fake codex)", async () => {
  const { repo, binDir } = setupRepo();
  fs.writeFileSync(path.join(repo, "change.txt"), "dirty content\n");
  const result = run(
    "node",
    [CLI, "run", "code", "--poll-ms", "250", "--timeout-ms", "20000", "--cwd", repo, "--json"],
    { env: buildEnv(binDir) }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ran, true);
  assert.equal(payload.waited, true);
  assert.ok(["completed", "failed"].includes(payload.review.status));
  // The fake codex returns a CLEAN verdict.
  if (payload.review.status === "completed") {
    assert.match(payload.review.verdict, /CLEAN/);
  }
});

test("run rejects an invalid kind", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "run", "banana", "--cwd", repo], { env: buildEnv(binDir) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /kind must be/);
});

// =========================================================================
// Slash-command `.md` contract
// =========================================================================

/**
 * Parse the YAML-ish frontmatter of a command `.md` file into a flat map.
 *
 * @param {string} text
 * @returns {{ frontmatter: Record<string, string>, body: string }}
 */
function parseCommandFile(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "command file must start with a --- frontmatter block");
  /** @type {Record<string, string>} */
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) {
      frontmatter[kv[1]] = kv[2];
    }
  }
  return { frontmatter, body: match[2] };
}

const COMMAND_FILES = ["config.md", "last.md", "doctor.md", "run.md", "onboard.md"];

for (const file of COMMAND_FILES) {
  test(`command ${file} has a valid frontmatter contract`, () => {
    const full = path.join(COMMANDS_DIR, file);
    assert.ok(fs.existsSync(full), `${file} must exist`);
    const { frontmatter, body } = parseCommandFile(fs.readFileSync(full, "utf8"));
    // Every command must describe itself.
    assert.ok(
      typeof frontmatter.description === "string" && frontmatter.description.length > 10,
      `${file}: needs a non-trivial description`
    );
    // Every command must declare allowed-tools.
    assert.ok(
      typeof frontmatter["allowed-tools"] === "string" && frontmatter["allowed-tools"].length > 0,
      `${file}: needs allowed-tools`
    );
    // The body must reference the plugin root variable so it is portable.
    assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${file}: body must use \${CLAUDE_PLUGIN_ROOT}`);
  });
}

test("command run.md spawns a native Agent subagent (declares the Task tool)", () => {
  const { frontmatter, body } = parseCommandFile(
    fs.readFileSync(path.join(COMMANDS_DIR, "run.md"), "utf8")
  );
  // The plan requires /run to spawn a native Claude Agent-tool subagent.
  assert.match(frontmatter["allowed-tools"], /Task/, "run.md must allow the Task (Agent) tool");
  assert.match(body, /Agent tool|Task/, "run.md body must instruct using the Agent/Task tool");
  assert.match(body, /codex-autoreview\.mjs" run/, "run.md must invoke the run subcommand");
});

test("command config.md documents the new config surface", () => {
  const body = fs.readFileSync(path.join(COMMANDS_DIR, "config.md"), "utf8");
  assert.match(body, /--backend/, "config.md must document --backend");
  assert.match(body, /--profile/, "config.md must document --profile");
  assert.match(body, /--pricing/, "config.md must document --pricing");
});

test("commands doctor.md and onboard.md invoke their CLI subcommands", () => {
  const doctorBody = fs.readFileSync(path.join(COMMANDS_DIR, "doctor.md"), "utf8");
  assert.match(doctorBody, /codex-autoreview\.mjs" doctor/);
  const onboardBody = fs.readFileSync(path.join(COMMANDS_DIR, "onboard.md"), "utf8");
  assert.match(onboardBody, /codex-autoreview\.mjs" onboard/);
});

// =========================================================================
// Reviewer backend — `external`
// =========================================================================

test("validateExternalConfig accepts a minimal valid config and flags problems", () => {
  assert.deepEqual(validateExternalConfig({ command: "claude" }), []);
  assert.ok(validateExternalConfig({}).length > 0, "missing command is a problem");
  assert.ok(
    validateExternalConfig({ command: "x", promptDelivery: "telepathy" }).length > 0,
    "bad promptDelivery is a problem"
  );
  assert.ok(
    validateExternalConfig({ command: "x", promptDelivery: "arg", args: ["--no-placeholder"] })
      .length > 0,
    "arg delivery without {prompt} is a problem"
  );
});

test("resolveDotPath walks into nested JSON and tolerates a leading $.", () => {
  const obj = { a: { b: { c: "deep" } } };
  assert.equal(resolveDotPath(obj, "a.b.c"), "deep");
  assert.equal(resolveDotPath(obj, "$.a.b.c"), "deep");
  assert.equal(resolveDotPath(obj, "a.x.y"), undefined);
});

test("parseExternalOutput tier 3: a prompt-enforced text verdict line", () => {
  const { result } = parseExternalOutput({
    rawOutput: "ISSUES: found a real bug\nmore detail here",
    outputFormat: "text",
    resultPath: "result",
    kind: "code",
    profile: "generic-code"
  });
  assert.equal(result.verdict, "ISSUES");
  assert.match(result.summary, /found a real bug/);
});

test("parseExternalOutput tier 2: extracts the answer from a JSON envelope", () => {
  const { result } = parseExternalOutput({
    rawOutput: JSON.stringify({ result: "CLEAN: nothing wrong" }),
    outputFormat: "json",
    resultPath: "result",
    kind: "code",
    profile: "generic-code"
  });
  assert.equal(result.verdict, "CLEAN");
});

test("parseExternalOutput tier 1: parses a structured claim-based object", () => {
  const structured = {
    verdict: "ISSUES",
    confidence: "FEEDBACK",
    summary: "two bugs",
    findings: [
      { severity: "high", claim: "npe", impact: "crash", fix: "guard", confidence: "high" }
    ],
    claims: [],
    unverified: []
  };
  const { result } = parseExternalOutput({
    rawOutput: JSON.stringify({ structured_output: structured }),
    outputFormat: "json",
    resultPath: "structured_output",
    kind: "code",
    profile: "generic-code"
  });
  assert.equal(result.verdict, "ISSUES");
  assert.equal(result.findings.length, 1);
});

test("parseExternalOutput falls back to text when JSON parsing fails", () => {
  // gemini-cli has shipped incomplete --output-format json — defensive fallback.
  const { result } = parseExternalOutput({
    rawOutput: "CONCERNS: not valid json at all { ",
    outputFormat: "json",
    resultPath: "response",
    kind: "plan",
    profile: "plan-devils-advocate"
  });
  assert.equal(result.verdict, "CONCERNS");
});

test("buildExternalChildEnv restricts to the allowlist and injects placeholder vars", () => {
  const env = buildExternalChildEnv({
    allowlist: ["PATH"],
    sourceEnv: { PATH: "/usr/bin", SECRET_KEY: "do-not-leak", HOME: "/home/u" },
    promptFile: "/tmp/p.txt",
    outputFile: "/tmp/o.txt",
    cwd: "/repo",
    kind: "code",
    base: null
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SECRET_KEY, undefined, "secret-bearing var must not reach the child");
  assert.equal(env.HOME, undefined, "non-allowlisted var must not reach the child");
  assert.equal(env.CODEX_AUTOREVIEW_PROMPT_FILE, "/tmp/p.txt");
  assert.equal(env.CODEX_AUTOREVIEW_KIND, "code");
});

test("spawnWithTimeout runs a command and captures stdout", async () => {
  const raw = await spawnWithTimeout({
    command: "node",
    args: ["-e", "process.stdout.write('hello from child')"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    input: null,
    timeoutMs: 10000,
    onChild: () => {}
  });
  assert.equal(raw.status, 0);
  assert.equal(raw.timedOut, false);
  assert.match(raw.stdout, /hello from child/);
});

test("spawnWithTimeout enforces a hard timeout and reports timedOut", async () => {
  const raw = await spawnWithTimeout({
    command: "node",
    args: ["-e", "setInterval(() => {}, 1e9)"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    input: null,
    timeoutMs: 600,
    onChild: () => {}
  });
  assert.equal(raw.timedOut, true);
});

test("spawnWithTimeout never throws on a missing command", async () => {
  const raw = await spawnWithTimeout({
    command: "definitely-not-a-real-binary-xyz",
    args: [],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    input: null,
    timeoutMs: 5000
  });
  assert.ok(raw.error, "a missing command must resolve with an error, not throw");
  assert.equal(raw.timedOut, false);
});

test("externalBackend.run + parse: end-to-end with `cat` as the tool (stdin/stdout/text)", async () => {
  const raw = await externalBackend.run({
    cwd: process.cwd(),
    prompt: "CLEAN: a piped verdict line",
    kind: "code",
    profile: "generic-code",
    backendConfig: {
      command: "cat",
      args: [],
      promptDelivery: "stdin",
      outputCapture: "stdout",
      outputFormat: "text"
    },
    timeoutMs: 10000,
    env: process.env,
    onChild: () => {},
    outputFile: path.join(makeTempDir(), "out.txt")
  });
  assert.equal(raw.status, 0, raw.stderr);
  const parsed = externalBackend.parse(raw, {
    cwd: process.cwd(),
    kind: "code",
    profile: "generic-code",
    backendConfig: { outputCapture: "stdout", outputFormat: "text" }
  });
  assert.equal(parsed.ok, true);
  assert.match(parsed.verdict, /CLEAN/);
  // A bare text tool has no claim-level structure → degraded.
  assert.equal(parsed.degraded, true);
  // The external backend never fabricates token usage.
  assert.equal(parsed.usage, null);
});

test("externalBackend.run refuses an invalid config without spawning", async () => {
  const raw = await externalBackend.run({
    cwd: process.cwd(),
    prompt: "x",
    kind: "code",
    profile: "generic-code",
    backendConfig: { args: ["no-command"] },
    timeoutMs: 5000,
    env: process.env,
    onChild: () => {},
    outputFile: "/tmp/never.txt"
  });
  assert.ok(raw.error);
  assert.match(raw.error.message, /config invalid/);
});

test("externalBackend.run refuses an oversized argv under `arg` delivery", async () => {
  const huge = "x".repeat(200 * 1024);
  const raw = await externalBackend.run({
    cwd: process.cwd(),
    prompt: huge,
    kind: "code",
    profile: "generic-code",
    backendConfig: {
      command: "true",
      args: ["{prompt}"],
      promptDelivery: "arg",
      outputCapture: "stdout",
      outputFormat: "text"
    },
    timeoutMs: 5000,
    env: process.env,
    onChild: () => {},
    outputFile: "/tmp/never.txt"
  });
  assert.ok(raw.error);
  assert.match(raw.error.message, /ARG_MAX/);
});

// =========================================================================
// Reviewer backend — `exec-review`
// =========================================================================

test("buildCodexExecReviewArgs uses --uncommitted by default and --base when given", () => {
  const uncommitted = buildCodexExecReviewArgs({ cwd: "/repo", outputFile: "/tmp/o.txt" });
  assert.ok(uncommitted.includes("--uncommitted"));
  assert.ok(!uncommitted.includes("--base"));
  // It must be the review subcommand and hardened.
  assert.equal(uncommitted[0], "exec");
  assert.equal(uncommitted[1], "review");
  assert.ok(uncommitted.includes("--ephemeral"));
  assert.ok(uncommitted.includes("--ignore-user-config"));
  // codex exec review takes sandbox via -c, NOT -s.
  assert.ok(uncommitted.includes('sandbox_mode="read-only"'));
  assert.ok(!uncommitted.includes("--sandbox"));

  const based = buildCodexExecReviewArgs({
    cwd: "/repo",
    outputFile: "/tmp/o.txt",
    base: "main",
    model: "gpt-5.5"
  });
  assert.ok(based.includes("--base"));
  assert.ok(based.includes("main"));
  assert.ok(!based.includes("--uncommitted"));
  assert.ok(based.includes("--model") && based.includes("gpt-5.5"));
});

test("execReviewBackend advertises a degraded (prose-only, no-usage) capability posture", () => {
  assert.equal(execReviewBackend.capabilities.structuredOutput, false);
  assert.equal(execReviewBackend.capabilities.accurateUsage, false);
  assert.equal(execReviewBackend.capabilities.reviewScoped, true);
});

test("execReviewBackend.parse fails cleanly when codex produced no output", () => {
  const parsed = execReviewBackend.parse(
    {
      status: 1,
      stdout: "",
      stderr: "ERROR: something went wrong",
      signal: null,
      error: null,
      timedOut: false,
      timeoutMs: 0,
      outputFileContent: ""
    },
    { cwd: "/repo", kind: "code", profile: "generic-code" }
  );
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errorMessage);
});

// =========================================================================
// Reviewer backend — `app-server` (documented stub)
// =========================================================================

test("app-server JSON-RPC request builders produce the documented wire shapes", () => {
  const init = buildInitializeRequest({ id: 1 });
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.method, "initialize");
  assert.ok(init.params.clientInfo.name);

  const threadStart = buildThreadStartRequest({ id: 2, cwd: "/repo" });
  assert.equal(threadStart.method, "thread/start");
  assert.equal(threadStart.params.cwd, "/repo");

  const reviewStart = buildReviewStartRequest({
    id: 3,
    threadId: "t-1",
    kind: "code",
    prompt: "review this"
  });
  assert.equal(reviewStart.method, "review/start");
  assert.equal(reviewStart.params.threadId, "t-1");
  assert.equal(reviewStart.params.delivery, "detached");
  assert.equal(reviewStart.params.target.type, "uncommittedChanges");
  assert.equal(reviewStart.params.instructions, "review this");
});

test("buildReviewTarget maps kind + base to the right target type", () => {
  assert.equal(buildReviewTarget("plan").type, "custom");
  assert.equal(buildReviewTarget("code").type, "uncommittedChanges");
  assert.equal(buildReviewTarget("code", "main").type, "baseBranch");
});

test("app-server event matchers detect and extract the exitedReviewMode item", () => {
  const event = {
    method: "item/completed",
    params: { item: { type: "exitedReviewMode", review: { text: "the final review" } } }
  };
  assert.equal(isExitedReviewModeEvent(event), true);
  assert.equal(extractReviewTextFromEvent(event), "the final review");
  assert.equal(isExitedReviewModeEvent({ method: "turn/started" }), false);
  assert.equal(extractReviewTextFromEvent({ method: "turn/started" }), "");
});

test("app-server backend is a stub: probe is unavailable, run/parse never throw", async () => {
  assert.equal(appServerBackend.probe({ cwd: "/repo", env: process.env }).available, false);
  const raw = await appServerBackend.run({ cwd: "/repo", prompt: "x", kind: "code" });
  assert.ok(raw.error);
  const parsed = appServerBackend.parse(raw, { cwd: "/repo", kind: "code" });
  assert.equal(parsed.ok, false);
});

// =========================================================================
// Two-reviewer comparison / consensus
// =========================================================================

test("verdictSeverity maps the ordinal axis and excludes failed/stale", () => {
  assert.equal(verdictSeverity("CLEAN"), 0);
  assert.equal(verdictSeverity("SOUND"), 0);
  assert.equal(verdictSeverity("CONCERNS"), 1);
  assert.equal(verdictSeverity("ISSUES"), 2);
  assert.equal(verdictSeverity("FAILED"), null);
  assert.equal(verdictSeverity("STALE"), null);
});

test("normalizeTitle lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(normalizeTitle("  SQL  Injection!! (db.js) "), "sql injection db js");
});

test("findingsOverlap matches same file within a ±3-line window", () => {
  const a = fingerprintFinding({ file: "db.js", line: 10, claim: "sql injection" });
  const b = fingerprintFinding({ file: "db.js", line: 12, claim: "sqli" });
  const c = fingerprintFinding({ file: "db.js", line: 99, claim: "different" });
  const d = fingerprintFinding({ file: "other.js", line: 10, claim: "sql injection" });
  assert.equal(findingsOverlap(a, b), true, "within window → overlap");
  assert.equal(findingsOverlap(a, c), false, "outside window → no overlap");
  assert.equal(findingsOverlap(a, d), false, "different file → no overlap");
});

test("compareFindings partitions agreed vs unique findings", () => {
  const reviewA = {
    result: {
      findings: [
        { severity: "high", claim: "sql injection", file: "db.js", line: 10 },
        { severity: "low", claim: "only A saw this", file: "a.js", line: 1 }
      ]
    }
  };
  const reviewB = {
    result: {
      findings: [
        { severity: "high", claim: "SQL Injection", file: "db.js", line: 11 },
        { severity: "medium", claim: "only B saw this", file: "b.js", line: 5 }
      ]
    }
  };
  const { agreed, uniqueA, uniqueB, totalDistinct } = compareFindings(reviewA, reviewB);
  assert.equal(agreed.length, 1);
  assert.equal(uniqueA.length, 1);
  assert.equal(uniqueB.length, 1);
  assert.equal(totalDistinct, 3);
});

test("mergeVerdicts takes the more severe verdict and survives a single failure", () => {
  assert.equal(mergeVerdicts("CLEAN", "ISSUES", 0, 2), "ISSUES");
  assert.equal(mergeVerdicts("CONCERNS", "SOUND", 1, 0), "CONCERNS");
  assert.equal(mergeVerdicts("ISSUES", null, 2, null), "ISSUES", "survivor stands");
  assert.equal(mergeVerdicts(null, null, null, null), "FAILED");
});

test("compareReviews: both CLEAN with zero findings is full consensus (score 100)", () => {
  const a = { id: "a", status: "completed", backend: "codex", result: { verdict: "CLEAN", findings: [] } };
  const b = { id: "b", status: "completed", backend: "claude", result: { verdict: "CLEAN", findings: [] } };
  const r = compareReviews(a, b);
  assert.equal(r.consensus, "agree");
  assert.equal(r.consensusScore, 100, "both-clean-zero-findings special case → 100");
  assert.equal(r.mergedVerdict, "CLEAN");
  assert.match(r.mergedVerdictLine, /2 reviewers/);
});

test("compareReviews: a CLEAN-vs-ISSUES disagreement is a conflict", () => {
  const a = {
    id: "a",
    status: "completed",
    backend: "codex",
    result: { verdict: "ISSUES", findings: [{ severity: "high", claim: "bug", file: "x.js", line: 3 }] }
  };
  const b = { id: "b", status: "completed", backend: "claude", result: { verdict: "CLEAN", findings: [] } };
  const r = compareReviews(a, b);
  assert.equal(r.consensus, "conflict");
  // Merged headline is the MORE SEVERE verdict — a real bug is not hidden.
  assert.equal(r.mergedVerdict, "ISSUES");
  assert.match(r.surfaced, /codex only/);
});

test("compareReviews: one failed reviewer yields a `single` consensus", () => {
  const ok = {
    id: "ok",
    status: "completed",
    backend: "codex",
    result: { verdict: "ISSUES", findings: [{ severity: "high", claim: "bug", file: "x.js", line: 3 }] }
  };
  const failed = { id: "failed", status: "failed", verdict: null, result: null };
  const r = compareReviews(ok, failed);
  assert.equal(r.consensus, "single");
  assert.equal(r.mergedVerdict, "ISSUES");
});

test("compareReviews: two failed reviewers are inconclusive", () => {
  const f1 = { id: "f1", status: "failed", verdict: null, result: null };
  const f2 = { id: "f2", status: "failed", verdict: null, result: null };
  const r = compareReviews(f1, f2);
  assert.equal(r.consensus, "inconclusive");
  assert.equal(r.consensusScore, 0);
});

test("compareReviews: agreement on a shared finding scores high", () => {
  const a = {
    id: "a",
    status: "completed",
    backend: "codex",
    result: {
      verdict: "ISSUES",
      findings: [{ severity: "high", claim: "race condition", file: "w.js", line: 20 }]
    }
  };
  const b = {
    id: "b",
    status: "completed",
    backend: "claude",
    result: {
      verdict: "ISSUES",
      findings: [{ severity: "high", claim: "Race Condition", file: "w.js", line: 22 }]
    }
  };
  const r = compareReviews(a, b);
  assert.equal(r.consensus, "agree");
  assert.equal(r.consensusScore, 100, "fully-overlapping findings + agree → 100");
  assert.equal(r.agreedFindings.length, 1);
});

test("buildMergedVerdictLine annotates each consensus label", () => {
  assert.match(
    buildMergedVerdictLine({
      mergedVerdict: "CLEAN",
      consensus: "agree",
      consensusScore: 100,
      verdictA: "CLEAN",
      verdictB: "CLEAN",
      backendA: "codex",
      backendB: "claude"
    }),
    /agree/
  );
  assert.match(
    buildMergedVerdictLine({
      mergedVerdict: "ISSUES",
      consensus: "conflict",
      consensusScore: 0,
      verdictA: "ISSUES",
      verdictB: "CLEAN",
      backendA: "codex",
      backendB: "claude"
    }),
    /conflict/
  );
});
