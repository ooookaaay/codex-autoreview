/**
 * End-to-end tests for codex-autoreview: config CLI, both hooks, the statusline,
 * the detached worker, and the unit-level resolvers.
 *
 * Uses a fake `codex` CLI fixture so no test touches the real Codex.
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
  run,
  waitFor
} from "./helpers.mjs";

import {
  VALID_REASONING_EFFORTS,
  buildCodexExecArgs,
  extractVerdictLine,
  normalizeModel,
  normalizeReasoningEffort,
  resolveReviewEffort,
  resolveReviewModel
} from "../scripts/lib/codex.mjs";
import {
  resolveStateDir,
  getLatestReview,
  loadState,
  updateReviewIf,
  updateState,
  upsertReview
} from "../scripts/lib/state.mjs";
import { buildStatuslineSegment } from "../scripts/statusline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");
const CLI = path.join(SCRIPTS, "codex-autoreview.mjs");
const PLAN_HOOK = path.join(SCRIPTS, "auto-plan-review-hook.mjs");
const CODE_HOOK = path.join(SCRIPTS, "auto-code-review-hook.mjs");
const STATUSLINE = path.join(SCRIPTS, "statusline.mjs");

const LARGE_PLAN = [
  "## Implementation plan",
  "",
  "1. Add a new module that wires the feature end to end.",
  "2. Update the configuration loader so the toggle is honored everywhere.",
  "3. Add tests that exercise the enable and disable paths.",
  "4. Update the documentation and the changelog for the release.",
  "5. Re-run the full suite and confirm there are no regressions."
].join("\n");

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

/**
 * @param {string} repo
 * @returns {ReturnType<typeof loadState>}
 */
function readState(repo) {
  return loadState(repo);
}

// --- unit: resolvers and normalizers -------------------------------------

test("resolveReviewModel and resolveReviewEffort return null when unset (use codex's own default)", () => {
  // null means "omit the flag, let ~/.codex/config.toml decide" — the plugin
  // never hardcodes a model that the account might reject.
  assert.equal(resolveReviewModel({}), null);
  assert.equal(resolveReviewEffort({}), null);
  assert.equal(resolveReviewModel({ model: "gpt-5.4-mini" }), "gpt-5.4-mini");
  assert.equal(resolveReviewEffort({ effort: "high" }), "high");
  assert.equal(resolveReviewModel({ model: "  " }), null);
  assert.equal(resolveReviewEffort({ effort: "  " }), null);
});

test("normalizeReasoningEffort validates against the codex-accepted set", () => {
  for (const effort of VALID_REASONING_EFFORTS) {
    assert.equal(normalizeReasoningEffort(effort), effort);
  }
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.equal(normalizeReasoningEffort(""), null);
  assert.equal(normalizeReasoningEffort(null), null);
  assert.throws(() => normalizeReasoningEffort("turbo"), /Unsupported reasoning effort/i);
  // 'xhigh' is accepted (history: it was briefly mis-documented upstream).
  assert.equal(normalizeReasoningEffort("xhigh"), "xhigh");
});

test("normalizeModel trims and nulls empty input", () => {
  assert.equal(normalizeModel("  gpt-5.4-codex "), "gpt-5.4-codex");
  assert.equal(normalizeModel(""), null);
  assert.equal(normalizeModel(null), null);
});

test("buildCodexExecArgs produces a read-only codex exec invocation", () => {
  const args = buildCodexExecArgs({
    model: "gpt-5.4-codex",
    effort: "medium",
    cwd: "/tmp/x",
    outputFile: "/tmp/x/out.txt"
  });
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--model") && args.includes("gpt-5.4-codex"));
  assert.ok(args.includes("-c") && args.includes("model_reasoning_effort=medium"));
  assert.ok(args.includes("--sandbox") && args.includes("read-only"));
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.ok(args.includes("--output-last-message") && args.includes("/tmp/x/out.txt"));
});

test("buildCodexExecArgs omits --model and effort when they are null", () => {
  const args = buildCodexExecArgs({
    model: null,
    effort: null,
    cwd: "/tmp/x",
    outputFile: "/tmp/x/out.txt"
  });
  assert.equal(args[0], "exec");
  assert.ok(!args.includes("--model"), "must not pass --model when unset");
  assert.ok(
    !args.some((arg) => arg.startsWith("model_reasoning_effort=")),
    "must not pass effort when unset"
  );
  // The fixed flags are still present.
  assert.ok(args.includes("--sandbox") && args.includes("read-only"));
  assert.ok(args.includes("--output-last-message"));
});

test("extractVerdictLine returns the first non-empty line", () => {
  assert.equal(extractVerdictLine("\n\nCLEAN: all good\nmore detail"), "CLEAN: all good");
  assert.equal(extractVerdictLine(""), null);
  assert.equal(extractVerdictLine("   "), null);
});

// --- config CLI ----------------------------------------------------------

test("config --enable / --disable flips the per-project toggle", () => {
  const { repo, binDir } = setupRepo();

  const enabled = run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(enabled.stdout).enabled, true);
  assert.equal(readState(repo).config.enabled, true);

  const disabled = run("node", [CLI, "config", "--disable", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(JSON.parse(disabled.stdout).enabled, false);
  assert.equal(readState(repo).config.enabled, false);
});

test("config persists model and effort overrides", () => {
  const { repo, binDir } = setupRepo();
  const result = run(
    "node",
    [CLI, "config", "--enable", "--model", "gpt-5.4-mini", "--effort", "high", "--cwd", repo, "--json"],
    { env: buildEnv(binDir) }
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "gpt-5.4-mini");
  assert.equal(payload.effort, "high");
  const config = readState(repo).config;
  assert.equal(config.model, "gpt-5.4-mini");
  assert.equal(config.effort, "high");
});

test("config defaults model and effort to null (codex's own config decides)", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, null);
  assert.equal(payload.effort, null);
});

test("config rejects an invalid effort", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "config", "--effort", "turbo", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported reasoning effort/i);
});

test("config with no flags just reports current settings", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "config", "--cwd", repo], { env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status:\s+OFF/);
  assert.match(result.stdout, /codex:\s+available/);
});

// --- plan review hook ----------------------------------------------------

test("plan review hook no-ops cleanly when the toggle is disabled", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [PLAN_HOOK], {
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-plan-off",
      tool_name: "ExitPlanMode",
      tool_input: { plan: LARGE_PLAN }
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.equal(result.stderr.trim(), "");
});

test("plan review hook dispatches a background job when enabled and never blocks", async () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });

  const result = run("node", [PLAN_HOOK], {
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-plan-on",
      tool_name: "ExitPlanMode",
      tool_input: { plan: LARGE_PLAN }
    })
  });

  assert.equal(result.status, 0, result.stderr);
  // The hook must NOT emit a permission decision: plan-mode exit is never blocked.
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /devil's-advocate plan review started in the background/i);

  // The detached worker should finish and record a completed verdict.
  const done = await waitFor(() => {
    const review = getLatestReview(repo, { kind: "plan" });
    return Boolean(review && review.status === "completed");
  });
  assert.equal(done, true, "worker did not complete the plan review");
  const review = getLatestReview(repo, { kind: "plan" });
  assert.equal(review.kind, "plan");
  assert.match(review.verdict, /^CLEAN:/);
});

test("plan review hook skips trivially small plans", () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });

  const result = run("node", [PLAN_HOOK], {
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-plan-tiny",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "Fix the typo." }
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /too small to be worth a devil's-advocate pass/i);
});

test("plan review hook no-ops when the codex CLI is absent", () => {
  const { repo } = setupRepo();
  // Enable using a real-ish env, then strip codex from PATH for the hook run.
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });

  const result = run("node", [PLAN_HOOK], {
    env: buildEnvWithoutCodex(),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-plan-nocodex",
      tool_name: "ExitPlanMode",
      tool_input: { plan: LARGE_PLAN }
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /Codex CLI is not available/i);
});

// --- code review (Stop) hook ---------------------------------------------

test("code review hook no-ops cleanly when the toggle is disabled", () => {
  const { repo, binDir } = setupRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const result = run("node", [CODE_HOOK], {
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-code-off",
      last_assistant_message: "I changed the README."
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.equal(result.stderr.trim(), "");
});

test("code review hook dispatches a background job when enabled and never blocks", async () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [CODE_HOOK], {
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-code-on",
      last_assistant_message: "I changed the README."
    })
  });

  assert.equal(result.status, 0, result.stderr);
  // No blocking decision: the automatic code review is advisory, not a gate.
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /bug-finding code review started in the background/i);

  const done = await waitFor(() => {
    const review = getLatestReview(repo, { kind: "code" });
    return Boolean(review && review.status === "completed");
  });
  assert.equal(done, true, "worker did not complete the code review");
  const review = getLatestReview(repo, { kind: "code" });
  assert.equal(review.kind, "code");
  assert.match(review.verdict, /^CLEAN:/);
});

test("code review records a failure with a useful error when codex exec fails", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, { mode: "fail" });
  initGitRepo(repo);
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  fs.writeFileSync(path.join(repo, "README.md"), "broken change\n");

  const result = run("node", [CODE_HOOK], {
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-code-fail",
      last_assistant_message: "I changed the README."
    })
  });
  // The hook itself still succeeds and never blocks — failure is the worker's.
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");

  const done = await waitFor(() => {
    const review = getLatestReview(repo, { kind: "code" });
    return Boolean(review && review.status === "failed");
  });
  assert.equal(done, true, "worker did not record the failure");
  const review = getLatestReview(repo, { kind: "code" });
  assert.equal(review.status, "failed");
  assert.equal(review.output, null);
  assert.match(review.errorMessage, /simulated rejection/i);
});

test("code review hook skips when the working tree is clean", () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });

  const result = run("node", [CODE_HOOK], {
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-code-clean",
      last_assistant_message: "Nothing changed."
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /no uncommitted changes to review/i);
});

test("code review hook no-ops when the codex CLI is absent", () => {
  const { repo } = setupRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");

  const result = run("node", [CODE_HOOK], {
    env: buildEnvWithoutCodex(),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-code-nocodex",
      last_assistant_message: "I changed the README."
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /Codex CLI is not available/i);
});

// --- last command --------------------------------------------------------

test("last command replays the most recent verdict", async () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  run("node", [CODE_HOOK], {
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-last",
      last_assistant_message: "I changed the README."
    })
  });

  await waitFor(() => {
    const review = getLatestReview(repo, { kind: "code" });
    return Boolean(review && review.status === "completed");
  });

  const result = run("node", [CLI, "last", "--cwd", repo], { env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Last Codex code review/);
  assert.match(result.stdout, /status:\s+completed/);
  assert.match(result.stdout, /CLEAN:/);
});

test("last command reports cleanly when no review has run", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "last", "--cwd", repo], { env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No Codex review has run yet/);
});

// --- statusline ----------------------------------------------------------

test("buildStatuslineSegment reflects the per-project toggle and config", () => {
  const { repo, binDir } = setupRepo();
  assert.equal(buildStatuslineSegment(repo), "");

  // Enabled with no overrides: both model and effort show the codex-default label.
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  assert.match(
    buildStatuslineSegment(repo),
    /^codex-autoreview: ON \(codex default, codex default\)$/
  );

  // With an explicit model + effort, both appear verbatim.
  run(
    "node",
    [CLI, "config", "--model", "gpt-5.4-mini", "--effort", "high", "--cwd", repo, "--json"],
    { env: buildEnv(binDir) }
  );
  assert.match(buildStatuslineSegment(repo), /^codex-autoreview: ON \(gpt-5\.4-mini, high\)$/);

  run("node", [CLI, "config", "--disable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  assert.equal(buildStatuslineSegment(repo), "");
});

test("statusline script prints nothing when review is disabled", () => {
  const { repo } = setupRepo();
  const result = run("node", [STATUSLINE], {
    input: JSON.stringify({ cwd: repo, workspace: { current_dir: repo } })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("statusline script prints the ON marker when review is enabled", () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  const result = run("node", [STATUSLINE], {
    input: JSON.stringify({ cwd: repo, workspace: { current_dir: repo } })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^codex-autoreview: ON \(/);
});

// --- state dir isolation -------------------------------------------------

test("resolveStateDir is stable and per-workspace", () => {
  const { repo } = setupRepo();
  const a = resolveStateDir(repo);
  const b = resolveStateDir(repo);
  assert.equal(a, b);
  const other = makeTempDir();
  initGitRepo(other);
  assert.notEqual(resolveStateDir(other), a);
});

// --- state concurrency / atomicity ---------------------------------------

test("updateReviewIf only patches when the predicate holds (compare-and-set)", () => {
  const { repo } = setupRepo();
  upsertReview(repo, { id: "r1", kind: "code", status: "queued" });

  // Worker has already advanced the review; the predicate must reject the
  // late dispatcher write so a finished review is never rolled back.
  upsertReview(repo, { id: "r1", status: "completed", verdict: "CLEAN: ok" });
  const rejected = updateReviewIf(
    repo,
    "r1",
    (review) => review.status === "queued",
    { pid: 4242 }
  );
  assert.equal(rejected.applied, false);
  const afterReject = loadState(repo).reviews.find((r) => r.id === "r1");
  assert.equal(afterReject.status, "completed");
  assert.equal(afterReject.pid, undefined);

  // When the predicate holds, the patch is applied.
  upsertReview(repo, { id: "r2", kind: "plan", status: "queued" });
  const applied = updateReviewIf(
    repo,
    "r2",
    (review) => review.status === "queued",
    { pid: 99 }
  );
  assert.equal(applied.applied, true);
  assert.equal(loadState(repo).reviews.find((r) => r.id === "r2").pid, 99);

  // A missing review id is a clean no-op.
  assert.equal(
    updateReviewIf(repo, "does-not-exist", () => true, { pid: 1 }).applied,
    false
  );
});

test("concurrent updateState writers do not lose each other's updates", async () => {
  const { repo } = setupRepo();
  // Seed twenty distinct reviews from parallel writers; with an unsynchronized
  // read-modify-write some would be lost. The lock must serialize them so all
  // twenty survive (MAX_REVIEWS is 20).
  const writers = Array.from({ length: 20 }, (_, index) =>
    Promise.resolve().then(() =>
      updateState(repo, (state) => {
        state.reviews.unshift({
          id: `concurrent-${index}`,
          kind: "code",
          status: "queued",
          verdict: null,
          output: null,
          errorMessage: null,
          logFile: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date(Date.now() + index).toISOString()
        });
      })
    )
  );
  await Promise.all(writers);

  const ids = new Set(loadState(repo).reviews.map((review) => review.id));
  for (let index = 0; index < 20; index += 1) {
    assert.ok(ids.has(`concurrent-${index}`), `lost update for concurrent-${index}`);
  }
});

test("saveState writes atomically — readers never see partial JSON", () => {
  const { repo } = setupRepo();
  // Drive a batch of updates, re-parsing the state file after every one. An
  // atomic temp-file+rename write guarantees each read parses cleanly.
  for (let index = 0; index < 30; index += 1) {
    upsertReview(repo, { id: `atomic-${index}`, kind: "code", status: "queued" });
    const parsed = loadState(repo);
    assert.ok(Array.isArray(parsed.reviews));
    assert.equal(typeof parsed.version, "number");
  }
});
