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
  installHangingCodex,
  makeTempDir,
  run,
  waitFor
} from "./helpers.mjs";

import {
  DEFAULT_REVIEW_EFFORT,
  DEFAULT_REVIEW_TIMEOUT_MS,
  VALID_REASONING_EFFORTS,
  buildCodexExecArgs,
  extractVerdictLine,
  hasEffortOverride,
  normalizeModel,
  normalizeReasoningEffort,
  normalizeTimeoutMs,
  resolveReviewEffort,
  resolveReviewModel,
  resolveReviewTimeoutMs,
  runCodexReview
} from "../scripts/lib/codex.mjs";
import {
  STALE_RUNNING_MS,
  resolveStateDir,
  getLatestReview,
  isReviewLikelyStuck,
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

test("resolveReviewModel returns null when unset (model stays inherited for auth-compat)", () => {
  // null means "omit --model, let ~/.codex/config.toml decide" — the plugin
  // never hardcodes a model that a ChatGPT-auth account might reject.
  assert.equal(resolveReviewModel({}), null);
  assert.equal(resolveReviewModel({ model: "gpt-5.4-mini" }), "gpt-5.4-mini");
  assert.equal(resolveReviewModel({ model: "  " }), null);
});

test("resolveReviewEffort falls back to the plugin's own default (NOT inherited)", () => {
  // Effort, unlike the model, is pinned to an explicit plugin default so an
  // automatic review never silently inherits a slow global xhigh.
  assert.equal(resolveReviewEffort({}), DEFAULT_REVIEW_EFFORT);
  assert.equal(resolveReviewEffort({ effort: "  " }), DEFAULT_REVIEW_EFFORT);
  assert.equal(DEFAULT_REVIEW_EFFORT, "medium");
  // An explicit override always wins.
  assert.equal(resolveReviewEffort({ effort: "high" }), "high");
  assert.equal(resolveReviewEffort({ effort: "low" }), "low");
  // hasEffortOverride distinguishes "default" from "explicitly set".
  assert.equal(hasEffortOverride({}), false);
  assert.equal(hasEffortOverride({ effort: "  " }), false);
  assert.equal(hasEffortOverride({ effort: "high" }), true);
});

test("resolveReviewTimeoutMs uses the default when unset and clamps overrides", () => {
  assert.equal(resolveReviewTimeoutMs({}), DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(resolveReviewTimeoutMs({ timeoutMs: null }), DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(resolveReviewTimeoutMs({ timeoutMs: 0 }), DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(resolveReviewTimeoutMs({ timeoutMs: 60_000 }), 60_000);
  // Out-of-range values clamp into the accepted band rather than throwing here.
  assert.equal(resolveReviewTimeoutMs({ timeoutMs: 1 }), 10_000);
  assert.equal(resolveReviewTimeoutMs({ timeoutMs: 9_999_999 }), 1_800_000);
});

test("normalizeTimeoutMs accepts valid input and rejects bad input", () => {
  assert.equal(normalizeTimeoutMs(null), null);
  assert.equal(normalizeTimeoutMs(""), null);
  assert.equal(normalizeTimeoutMs("  "), null);
  assert.equal(normalizeTimeoutMs("120000"), 120_000);
  assert.equal(normalizeTimeoutMs(90_000), 90_000);
  assert.throws(() => normalizeTimeoutMs("not-a-number"), /Invalid timeout/);
  assert.throws(() => normalizeTimeoutMs("-5"), /Invalid timeout/);
  assert.throws(() => normalizeTimeoutMs("5000"), /out of range/);
  assert.throws(() => normalizeTimeoutMs("99999999"), /out of range/);
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

test("config defaults: model stays null, effort is the plugin default (medium)", () => {
  const { repo, binDir } = setupRepo();
  const result = run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Model: still inherited (auth-compat) — reported as null.
  assert.equal(payload.model, null);
  // Effort: the plugin's OWN explicit default, NOT inherited from ~/.codex.
  assert.equal(payload.effort, DEFAULT_REVIEW_EFFORT);
  assert.equal(payload.effort, "medium");
  assert.equal(payload.effortIsDefault, true);
  // Timeout: the plugin default, flagged as a default.
  assert.equal(payload.timeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(payload.timeoutIsDefault, true);
  // The rendered (non-JSON) report names the effort default explicitly.
  const rendered = run("node", [CLI, "config", "--cwd", repo], { env: buildEnv(binDir) });
  assert.match(rendered.stdout, /effort:\s+medium \(plugin default/);
  assert.match(rendered.stdout, /independent of ~\/\.codex\/config\.toml/);
});

test("config persists and clears a timeout override", () => {
  const { repo, binDir } = setupRepo();
  const set = run("node", [CLI, "config", "--timeout", "90000", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(set.status, 0, set.stderr);
  assert.equal(JSON.parse(set.stdout).timeoutMs, 90_000);
  assert.equal(JSON.parse(set.stdout).timeoutIsDefault, false);
  assert.equal(readState(repo).config.timeoutMs, 90_000);

  // Clearing it (empty value) reverts to the default.
  const cleared = run("node", [CLI, "config", "--timeout", "", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).timeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
  assert.equal(JSON.parse(cleared.stdout).timeoutIsDefault, true);

  // A bad timeout is rejected with a nonzero exit.
  const bad = run("node", [CLI, "config", "--timeout", "abc", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Invalid timeout/i);
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

  // Enabled with no overrides: model shows the codex-default label (inherited),
  // effort shows the plugin's own default (medium — never inherited).
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  assert.match(
    buildStatuslineSegment(repo),
    /^codex-autoreview: ON \(codex default, medium\)$/
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

// --- hang protection -----------------------------------------------------

const WORKER = path.join(SCRIPTS, "review-worker.mjs");

/**
 * Seed a queued review record straight into state (bypassing the hooks) so a
 * test can drive `review-worker.mjs` directly.
 *
 * @param {string} repo
 * @param {object} request
 * @returns {string} the review id
 */
function seedQueuedReview(repo, request) {
  const id = `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  upsertReview(repo, {
    id,
    kind: "code",
    status: "queued",
    request: { cwd: repo, prompt: "review this", model: null, effort: "medium", ...request }
  });
  return id;
}

test("runCodexReview enforces a hard timeout and kills the codex process tree", async () => {
  const binDir = makeTempDir();
  const { pidFile } = installHangingCodex(binDir);
  const repo = makeTempDir();
  initGitRepo(repo);
  const outputFile = path.join(makeTempDir(), "out.txt");

  const started = Date.now();
  const result = await runCodexReview({
    cwd: repo,
    prompt: "hello",
    model: null,
    effort: "medium",
    outputFile,
    timeoutMs: 1500,
    env: buildEnv(binDir)
  });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true, "result must be flagged as timed out");
  assert.ok(elapsed < 12000, `should return shortly after the timeout, took ${elapsed}ms`);
  assert.ok(!fs.existsSync(outputFile), "hanging codex never produced an output file");

  // The grandchild spawned by the fake codex must have been reaped along with
  // the direct child — that is the process-TREE kill working.
  assert.ok(fs.existsSync(pidFile), "fake codex should have recorded its grandchild pid");
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  const stillAlive = await waitFor(
    () => {
      try {
        process.kill(grandchildPid, 0);
        return false; // still alive
      } catch {
        return true; // gone
      }
    },
    { timeoutMs: 8000, intervalMs: 100 }
  );
  assert.ok(stillAlive, `grandchild pid ${grandchildPid} should have been killed with the tree`);
});

test("review-worker marks a hung review failed (timeout) — never left running", async () => {
  const binDir = makeTempDir();
  installHangingCodex(binDir);
  const repo = makeTempDir();
  initGitRepo(repo);
  // A short timeout override so the test is fast.
  const reviewId = seedQueuedReview(repo, { timeoutMs: 1500 });

  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir)
  });
  assert.notEqual(result.status, 0, "worker should exit nonzero on a timed-out review");

  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "failed", "a hung review must land in 'failed', not 'running'");
  assert.match(review.errorMessage, /timed out after \d+s/);
});

test("review-worker reaches a terminal state when the codex CLI is absent", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const reviewId = seedQueuedReview(repo, {});
  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnvWithoutCodex()
  });
  assert.notEqual(result.status, 0);
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "failed");
  assert.match(review.errorMessage, /Codex CLI is not available/i);
});

test("review-worker reaches a terminal state when codex exec fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, { mode: "fail" });
  const repo = makeTempDir();
  initGitRepo(repo);
  const reviewId = seedQueuedReview(repo, {});
  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir)
  });
  assert.notEqual(result.status, 0);
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "failed");
  assert.ok(review.errorMessage, "a failed review must carry an error message");
});

test("review-worker flushes a 'failed' terminal state when killed by SIGTERM", async () => {
  const binDir = makeTempDir();
  // A codex that hangs long enough for us to SIGTERM the worker mid-run.
  installHangingCodex(binDir);
  const repo = makeTempDir();
  initGitRepo(repo);
  // Long timeout so the worker is still in `running` when we kill it.
  const reviewId = seedQueuedReview(repo, { timeoutMs: 120_000 });

  const { spawn } = await import("node:child_process");
  const worker = spawn("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir),
    stdio: "ignore"
  });

  // Wait until the worker has flipped the review to `running`, then SIGTERM it.
  await waitFor(
    () => loadState(repo).reviews.find((r) => r.id === reviewId)?.status === "running",
    { timeoutMs: 8000, intervalMs: 100 }
  );
  worker.kill("SIGTERM");
  await waitFor(() => worker.exitCode !== null || worker.signalCode !== null, {
    timeoutMs: 8000,
    intervalMs: 100
  });

  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(
    review.status,
    "failed",
    "a SIGTERM'd worker must flush 'failed', never leave the review 'running'"
  );
  assert.match(review.errorMessage, /terminated by SIGTERM/i);
});

test("isReviewLikelyStuck flags non-terminal reviews past the stale bound", () => {
  const fresh = { status: "running", updatedAt: new Date().toISOString() };
  assert.equal(isReviewLikelyStuck(fresh), false);

  const stale = {
    status: "running",
    updatedAt: new Date(Date.now() - STALE_RUNNING_MS - 60_000).toISOString()
  };
  assert.equal(isReviewLikelyStuck(stale), true);

  // Terminal states are never "stuck", however old.
  const oldCompleted = {
    status: "completed",
    updatedAt: new Date(Date.now() - STALE_RUNNING_MS * 10).toISOString()
  };
  assert.equal(isReviewLikelyStuck(oldCompleted), false);

  // A queued review with no usable timestamp is surfaced (treated as stuck).
  assert.equal(isReviewLikelyStuck({ status: "queued", updatedAt: "" }), true);
  assert.equal(isReviewLikelyStuck(null), false);
});

test("last surfaces a stuck review instead of implying it is healthy", () => {
  const { repo, binDir } = setupRepo();
  upsertReview(repo, {
    id: "stuck-1",
    kind: "code",
    status: "running"
  });
  // Backdate the record well past the stale bound.
  const stale = loadState(repo);
  const idx = stale.reviews.findIndex((r) => r.id === "stuck-1");
  stale.reviews[idx].updatedAt = new Date(Date.now() - STALE_RUNNING_MS - 120_000).toISOString();
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "state.json"),
    `${JSON.stringify(stale, null, 2)}\n`,
    "utf8"
  );

  const result = run("node", [CLI, "last", "code", "--cwd", repo], { env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LIKELY STUCK/);
  assert.match(result.stdout, /worker has most likely died/i);

  const json = run("node", [CLI, "last", "code", "--cwd", repo, "--json"], {
    env: buildEnv(binDir)
  });
  assert.equal(JSON.parse(json.stdout).likelyStuck, true);
});

// --- auto-inject verdict into session (UserPromptSubmit hook) -------------

const SURFACE_HOOK = path.join(SCRIPTS, "surface-verdict-hook.mjs");
const SESSION_END_HOOK = path.join(SCRIPTS, "session-end-cleanup-hook.mjs");

test("surface-verdict hook no-ops when the toggle is disabled", () => {
  const { repo, binDir } = setupRepo();
  upsertReview(repo, {
    id: "done-1",
    kind: "code",
    status: "completed",
    verdict: "ISSUES: a bug",
    output: "ISSUES: a bug\n\nfile.js:1 details"
  });
  const result = run("node", [SURFACE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "disabled toggle must inject nothing");
});

test("surface-verdict hook injects a completed verdict exactly once", () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  upsertReview(repo, {
    id: "done-2",
    kind: "code",
    status: "completed",
    verdict: "ISSUES: off-by-one in loop",
    output: "ISSUES: off-by-one in loop\n\nfile.js:42 the index should be < not <="
  });

  // First prompt: the verdict is injected as additionalContext.
  const first = run("node", [SURFACE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(first.status, 0, first.stderr);
  const payload = JSON.parse(first.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(payload.hookSpecificOutput.additionalContext, /ISSUES: off-by-one in loop/);
  assert.match(payload.hookSpecificOutput.additionalContext, /file\.js:42/);
  assert.match(payload.hookSpecificOutput.additionalContext, /advisory peer review/i);

  // The review is now stamped surfaced.
  const surfaced = loadState(repo).reviews.find((r) => r.id === "done-2");
  assert.ok(surfaced.surfacedAt, "review should be stamped surfacedAt");
  assert.equal(surfaced.surfacedSessionId, "s1");

  // Second prompt: nothing re-injected.
  const second = run("node", [SURFACE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "", "an already-surfaced verdict must not be re-injected");
});

test("surface-verdict hook ignores queued/running/failed reviews", () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  upsertReview(repo, { id: "r-queued", kind: "code", status: "queued" });
  upsertReview(repo, { id: "r-running", kind: "plan", status: "running" });
  upsertReview(repo, {
    id: "r-failed",
    kind: "code",
    status: "failed",
    errorMessage: "codex exec timed out"
  });
  const result = run("node", [SURFACE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "only completed reviews with a verdict are injected");
});

test("surface-verdict hook truncates an oversized Codex output", () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  const huge = "ISSUES: big\n\n" + "x".repeat(5000);
  upsertReview(repo, {
    id: "done-huge",
    kind: "code",
    status: "completed",
    verdict: "ISSUES: big",
    output: huge
  });
  const result = run("node", [SURFACE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length < 2500, `injected context should be bounded, was ${ctx.length}`);
  assert.match(ctx, /truncated/i);
});

// --- SessionEnd cleanup hook ---------------------------------------------

test("session-end hook reconciles this session's in-flight reviews to failed", () => {
  const { repo, binDir } = setupRepo();
  // An in-flight review from session s1, plus a completed one that must survive.
  upsertReview(repo, {
    id: "inflight-s1",
    kind: "code",
    status: "running",
    request: { cwd: repo, prompt: "x", sessionId: "s1" }
  });
  upsertReview(repo, {
    id: "done-keep",
    kind: "plan",
    status: "completed",
    verdict: "SOUND: ok",
    output: "SOUND: ok"
  });
  // An in-flight review from a DIFFERENT session must NOT be touched.
  upsertReview(repo, {
    id: "inflight-s2",
    kind: "code",
    status: "running",
    request: { cwd: repo, prompt: "y", sessionId: "s2" }
  });

  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /session cleanup/i);

  const reviews = loadState(repo).reviews;
  const s1 = reviews.find((r) => r.id === "inflight-s1");
  const s2 = reviews.find((r) => r.id === "inflight-s2");
  const kept = reviews.find((r) => r.id === "done-keep");
  assert.equal(s1.status, "failed", "this session's in-flight review must be reconciled to failed");
  assert.match(s1.errorMessage, /session ended/i);
  assert.equal(s2.status, "running", "another session's review must be left untouched");
  assert.equal(kept.status, "completed", "completed reviews are kept so /last still works");
});

test("session-end hook prunes stale review files but keeps recent state", () => {
  const { repo, binDir } = setupRepo();
  const reviewsDir = path.join(resolveStateDir(repo), "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });
  // A log file for a review that is NOT in state (orphan) and one that IS.
  fs.writeFileSync(path.join(reviewsDir, "orphan-xyz.log"), "stale\n", "utf8");
  fs.writeFileSync(path.join(reviewsDir, "orphan-xyz.output.txt"), "stale\n", "utf8");
  upsertReview(repo, {
    id: "live-rev",
    kind: "code",
    status: "completed",
    verdict: "CLEAN: ok",
    output: "CLEAN: ok"
  });
  fs.writeFileSync(path.join(reviewsDir, "live-rev.log"), "kept\n", "utf8");

  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  assert.equal(fs.existsSync(path.join(reviewsDir, "orphan-xyz.log")), false, "orphan log removed");
  assert.equal(
    fs.existsSync(path.join(reviewsDir, "orphan-xyz.output.txt")),
    false,
    "orphan output removed"
  );
  assert.equal(fs.existsSync(path.join(reviewsDir, "live-rev.log")), true, "live review file kept");
  // The completed review itself is still there for /last.
  assert.ok(loadState(repo).reviews.find((r) => r.id === "live-rev"));
});

test("session-end hook never errors out, even with no state and no session id", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo }),
    env: buildEnvWithoutCodex()
  });
  assert.equal(result.status, 0, "cleanup hook must always exit 0 to not disrupt shutdown");
});
