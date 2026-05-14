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
  installVersionHangingCodex,
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
  getCodexAvailability,
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
  claimUnsurfacedCompletedReviews,
  resolveStateDir,
  getLatestReview,
  healStuckReviews,
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

test("dispatcher pid predicate still attaches when the worker raced to 'running'", () => {
  // Regression: the pid must be attached for queued OR running reviews (a
  // worker that flips to 'running' before the parent's pid write must NOT end
  // up un-killable), but never for terminal reviews, and never overwriting an
  // existing pid. This mirrors the predicate dispatchBackgroundReview uses.
  const { repo } = setupRepo();
  const predicate = (review) =>
    (review.status === "queued" || review.status === "running") && !review.pid;

  // Worker already advanced to 'running' before the parent's pid write.
  upsertReview(repo, { id: "raced", kind: "code", status: "running" });
  assert.equal(updateReviewIf(repo, "raced", predicate, { pid: 555 }).applied, true);
  assert.equal(loadState(repo).reviews.find((r) => r.id === "raced").pid, 555);

  // A pid already recorded is never overwritten.
  assert.equal(updateReviewIf(repo, "raced", predicate, { pid: 999 }).applied, false);
  assert.equal(loadState(repo).reviews.find((r) => r.id === "raced").pid, 555);

  // A terminal review never gets a pid attached.
  upsertReview(repo, { id: "terminal", kind: "code", status: "completed", verdict: "CLEAN: ok" });
  assert.equal(updateReviewIf(repo, "terminal", predicate, { pid: 111 }).applied, false);
  assert.equal(loadState(repo).reviews.find((r) => r.id === "terminal").pid, undefined);
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

test("pruneReviews never drops a non-terminal review, even past MAX_REVIEWS", () => {
  const { repo } = setupRepo();
  // Seed 30 RUNNING reviews — well past the MAX_REVIEWS (20) ring-buffer cap.
  // A naive prune would delete 10 of them; their detached workers would then
  // find no record and exit without a terminal state, losing the verdict.
  for (let index = 0; index < 30; index += 1) {
    upsertReview(repo, {
      id: `inflight-${index}`,
      kind: "code",
      status: "running",
      request: { cwd: repo, prompt: "x" }
    });
  }
  const afterInflight = loadState(repo).reviews;
  for (let index = 0; index < 30; index += 1) {
    assert.ok(
      afterInflight.find((r) => r.id === `inflight-${index}`),
      `non-terminal review inflight-${index} must NOT be pruned`
    );
  }

  // Now add 30 terminal reviews — these ARE subject to the cap, but the 30
  // running reviews must still all survive.
  for (let index = 0; index < 30; index += 1) {
    upsertReview(repo, {
      id: `done-${index}`,
      kind: "code",
      status: "completed",
      verdict: "CLEAN: ok"
    });
  }
  const finalReviews = loadState(repo).reviews;
  for (let index = 0; index < 30; index += 1) {
    assert.ok(
      finalReviews.find((r) => r.id === `inflight-${index}`),
      `non-terminal review inflight-${index} must survive even with many terminal records`
    );
  }
  // At least a few terminal records are kept (so `last` works), but they are
  // capped — not all 30 survive.
  const keptTerminal = finalReviews.filter((r) => r.status === "completed");
  assert.ok(keptTerminal.length >= 5, "a few terminal reviews are kept for /last");
  assert.ok(keptTerminal.length < 30, "terminal reviews ARE subject to the ring-buffer cap");
});

test("updateState leaves no lock file behind and tolerates a foreign stale lock", () => {
  const { repo } = setupRepo();
  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, "state.json.lock");

  // A normal update must release its own lock cleanly.
  upsertReview(repo, { id: "lock-1", kind: "code", status: "queued" });
  assert.equal(fs.existsSync(lockFile), false, "updateState must not leave its lock file behind");

  // A FOREIGN, already-stale lock file (content from some other writer, mtime
  // far in the past) must be broken so a new update still goes through — and
  // the new update must then clean up after itself.
  fs.writeFileSync(lockFile, "999999:foreign.token\n", "utf8");
  const oldTime = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, oldTime, oldTime);
  upsertReview(repo, { id: "lock-2", kind: "code", status: "queued" });
  assert.ok(
    loadState(repo).reviews.find((r) => r.id === "lock-2"),
    "an update must still succeed past a foreign stale lock"
  );
  assert.equal(fs.existsSync(lockFile), false, "the update must clean up the lock it acquired");
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

test("getCodexAvailability is time-boxed — a codex hung on --version is 'unavailable'", () => {
  const binDir = makeTempDir();
  installVersionHangingCodex(binDir);
  const repo = makeTempDir();
  initGitRepo(repo);

  const started = Date.now();
  // Short probe timeout so the test is fast; the production default is 10s.
  const availability = getCodexAvailability(repo, {
    env: buildEnv(binDir),
    timeoutMs: 1500
  });
  const elapsed = Date.now() - started;

  assert.equal(availability.available, false, "a codex hung on --version must be 'unavailable'");
  assert.match(availability.detail, /did not respond/i);
  assert.ok(elapsed < 10000, `the probe must return promptly, took ${elapsed}ms`);
});

test("a hook no-ops promptly when codex hangs on --version (does not block)", () => {
  const binDir = makeTempDir();
  installVersionHangingCodex(binDir);
  const { repo } = (() => {
    const r = makeTempDir();
    initGitRepo(r);
    return { repo: r };
  })();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  fs.appendFileSync(path.join(repo, "README.md"), "change\n");

  const started = Date.now();
  // The code-review hook probes codex availability; with a hung `codex
  // --version` it must still return — bounded by the probe timeout — and
  // no-op cleanly rather than hang the session.
  const result = run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "the hook must not emit a blocking decision");
  assert.match(result.stderr, /not available/i);
  // 10s default probe timeout + node startup; comfortably under the hook's 30s.
  assert.ok(elapsed < 20000, `the hook must return well within its 30s budget, took ${elapsed}ms`);
});

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

test("review-worker records its OWN pid in the same CAS that claims 'running'", async () => {
  const binDir = makeTempDir();
  installHangingCodex(binDir); // keeps the worker alive in `running`
  const repo = makeTempDir();
  initGitRepo(repo);
  const reviewId = seedQueuedReview(repo, { timeoutMs: 120_000 });

  const { spawn } = await import("node:child_process");
  const worker = spawn("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir),
    stdio: "ignore"
  });

  // As soon as the worker has claimed `running`, the review MUST already carry
  // a pid — written by the worker itself in the same compare-and-set, not left
  // to the dispatcher's later patch. This closes the window where SessionEnd
  // would see a running review with no pid and be unable to kill it.
  await waitFor(
    () => loadState(repo).reviews.find((r) => r.id === reviewId)?.status === "running",
    { timeoutMs: 8000, intervalMs: 50 }
  );
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "running");
  assert.equal(
    review.pid,
    worker.pid,
    "the running review must carry the worker's own pid immediately"
  );

  worker.kill("SIGKILL");
  await waitFor(() => worker.exitCode !== null || worker.signalCode !== null, {
    timeoutMs: 8000,
    intervalMs: 100
  });
});

test("review-worker never resurrects a review already finalized by cleanup", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir); // would normally produce a CLEAN verdict
  const repo = makeTempDir();
  initGitRepo(repo);
  const reviewId = seedQueuedReview(repo, {});

  // Simulate the SessionEnd cleanup having already reconciled this review to
  // `failed` (worker outlived its session). The worker then starts.
  upsertReview(repo, {
    id: reviewId,
    status: "failed",
    errorMessage: "Claude session ended before this background review finished."
  });

  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir)
  });
  // The worker must exit cleanly WITHOUT overwriting the terminal record.
  assert.equal(result.status, 0, result.stderr);
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "failed", "worker must not resurrect a finalized review");
  assert.match(review.errorMessage, /session ended/i, "the cleanup's verdict must stand");
  assert.ok(!review.verdict, "worker must not attach a verdict to a finalized review");
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
  // The worker now routes through the reviewer backend abstraction (F1): the
  // default `exec-generic` backend's probe reports codex as unavailable.
  assert.match(review.errorMessage, /backend "exec-generic" is not available/i);
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

test("review-worker, killed by SIGTERM, flushes 'failed' AND reaps the codex tree", async () => {
  const binDir = makeTempDir();
  // A codex that hangs long enough for us to SIGTERM the worker mid-run. The
  // fake records its grandchild pid so we can assert the whole codex tree was
  // reaped — not orphaned — when the worker is killed.
  const { pidFile } = installHangingCodex(binDir);
  const repo = makeTempDir();
  initGitRepo(repo);
  // Long timeout so the worker is still in `running` when we kill it.
  const reviewId = seedQueuedReview(repo, { timeoutMs: 120_000 });

  const { spawn } = await import("node:child_process");
  const worker = spawn("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir),
    stdio: "ignore"
  });

  // Wait until the worker has flipped the review to `running` AND the fake
  // codex has spawned its grandchild, then SIGTERM the worker.
  await waitFor(
    () =>
      loadState(repo).reviews.find((r) => r.id === reviewId)?.status === "running" &&
      fs.existsSync(pidFile),
    { timeoutMs: 8000, intervalMs: 100 }
  );
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
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

  // The codex grandchild must have been killed with the tree — a SIGTERM'd
  // worker must never orphan an in-flight codex run.
  const codexReaped = await waitFor(
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
  assert.ok(codexReaped, `codex grandchild ${grandchildPid} must be reaped, not orphaned`);
});

test("healStuckReviews self-heals a SIGKILL-orphaned 'running' review to failed", () => {
  const { repo } = setupRepo();
  // A fresh running review (worker presumably alive) must be left alone.
  upsertReview(repo, { id: "fresh-run", kind: "code", status: "running" });
  // A running review last touched > STALE_RUNNING_MS ago — its worker is dead
  // (a live worker self-terminates at its 240s hard timeout, far under 10min).
  upsertReview(repo, { id: "stuck-run", kind: "code", status: "running" });
  const st = loadState(repo);
  st.reviews.find((r) => r.id === "stuck-run").updatedAt = new Date(
    Date.now() - STALE_RUNNING_MS - 120_000
  ).toISOString();
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "state.json"),
    `${JSON.stringify(st, null, 2)}\n`,
    "utf8"
  );

  const result = healStuckReviews(repo);
  assert.equal(result.healed, 1, "exactly the stale review is healed");

  const reviews = loadState(repo).reviews;
  const stuck = reviews.find((r) => r.id === "stuck-run");
  const fresh = reviews.find((r) => r.id === "fresh-run");
  assert.equal(stuck.status, "failed", "the stale review is reconciled to failed");
  assert.match(stuck.errorMessage, /stale running review/i);
  assert.equal(fresh.status, "running", "a fresh running review is NOT touched");

  // Idempotent: a second sweep heals nothing.
  assert.equal(healStuckReviews(repo).healed, 0);
});

test("isReviewLikelyStuck uses a PER-REVIEW bound from the configured timeout", () => {
  // A review with a long configured timeout (20 min) that has been running
  // 11 min — PAST the old fixed 10-min bound — must NOT be flagged stuck: its
  // worker is still legitimately within its own hard timeout.
  const longConfigured = {
    status: "running",
    updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    request: { timeoutMs: 20 * 60_000 }
  };
  assert.equal(
    isReviewLikelyStuck(longConfigured),
    false,
    "a legitimately long review within its configured timeout is NOT stuck"
  );

  // The SAME review, once it has been running past timeoutMs + grace + slack,
  // IS stuck (its worker would have self-terminated at its own timeout).
  const longExpired = {
    status: "running",
    updatedAt: new Date(Date.now() - (20 * 60_000 + 5 * 60_000)).toISOString(),
    request: { timeoutMs: 20 * 60_000 }
  };
  assert.equal(
    isReviewLikelyStuck(longExpired),
    true,
    "a long review past its own timeout + grace IS stuck"
  );

  // A review with NO recorded timeout falls back to the STALE_RUNNING_MS floor.
  const noTimeoutFresh = {
    status: "running",
    updatedAt: new Date(Date.now() - (STALE_RUNNING_MS - 60_000)).toISOString()
  };
  assert.equal(isReviewLikelyStuck(noTimeoutFresh), false);
  const noTimeoutStale = {
    status: "running",
    updatedAt: new Date(Date.now() - (STALE_RUNNING_MS + 60_000)).toISOString()
  };
  assert.equal(isReviewLikelyStuck(noTimeoutStale), true);
});

test("healStuckReviews does NOT heal a legitimately long-running review", () => {
  const { repo } = setupRepo();
  // A review with a 25-min configured timeout, running for 12 min. The old
  // fixed 10-min bound would have wrongly healed it; the per-review bound must
  // leave it alone — its worker is still within its own hard timeout.
  upsertReview(repo, {
    id: "long-legit",
    kind: "code",
    status: "running",
    request: { cwd: repo, prompt: "x", timeoutMs: 25 * 60_000 }
  });
  const st = loadState(repo);
  st.reviews.find((r) => r.id === "long-legit").updatedAt = new Date(
    Date.now() - 12 * 60_000
  ).toISOString();
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "state.json"),
    `${JSON.stringify(st, null, 2)}\n`,
    "utf8"
  );

  assert.equal(healStuckReviews(repo).healed, 0, "a long-configured review is NOT falsely healed");
  assert.equal(loadState(repo).reviews.find((r) => r.id === "long-legit").status, "running");
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

test("claimUnsurfacedCompletedReviews claims each review exactly once under concurrency", async () => {
  const { repo } = setupRepo();
  // 12 completed, unsurfaced verdicts.
  for (let index = 0; index < 12; index += 1) {
    upsertReview(repo, {
      id: `claim-${index}`,
      kind: "code",
      status: "completed",
      verdict: `ISSUES: bug ${index}`,
      output: `ISSUES: bug ${index}`
    });
  }
  // Fire many concurrent claimers (mirrors concurrent UserPromptSubmit hooks).
  const claimers = Array.from({ length: 8 }, () =>
    Promise.resolve().then(() =>
      claimUnsurfacedCompletedReviews(repo, { sessionId: "s1", limit: 3 })
    )
  );
  const results = await Promise.all(claimers);

  // Every claimed id across all claimers must be unique — no double-surface.
  const allClaimed = results.flat().map((r) => r.id);
  assert.equal(
    new Set(allClaimed).size,
    allClaimed.length,
    "the same review must never be claimed by two concurrent callers"
  );
  // All 12 are now surfaced; a fresh claim returns nothing.
  assert.equal(allClaimed.length, 12, "all 12 reviews should have been claimed exactly once");
  assert.equal(claimUnsurfacedCompletedReviews(repo, { sessionId: "s1" }).length, 0);
  for (const review of loadState(repo).reviews) {
    assert.ok(review.surfacedAt, `${review.id} should be stamped surfacedAt`);
  }
});

test("surface-verdict hook is session-scoped — never steals another session's verdict", () => {
  const { repo, binDir } = setupRepo();
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  // A completed verdict that belongs to session A.
  upsertReview(repo, {
    id: "owned-by-A",
    kind: "code",
    status: "completed",
    verdict: "ISSUES: A's bug",
    output: "ISSUES: A's bug\n\ndetails",
    request: { cwd: repo, prompt: "x", sessionId: "session-A" }
  });

  // Session B must NOT see or consume session A's verdict.
  const fromB = run("node", [SURFACE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "session-B" }),
    env: buildEnv(binDir)
  });
  assert.equal(fromB.status, 0, fromB.stderr);
  assert.equal(fromB.stdout, "", "session B must not receive session A's verdict");
  assert.ok(
    !loadState(repo).reviews.find((r) => r.id === "owned-by-A").surfacedAt,
    "session B must not mark session A's verdict surfaced"
  );

  // Session A still gets it.
  const fromA = run("node", [SURFACE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "session-A" }),
    env: buildEnv(binDir)
  });
  assert.equal(fromA.status, 0, fromA.stderr);
  assert.match(JSON.parse(fromA.stdout).hookSpecificOutput.additionalContext, /A's bug/);
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

test("session-end hook prunes old TERMINAL review files but keeps recent state", () => {
  const { repo, binDir } = setupRepo();
  const reviewsDir = path.join(resolveStateDir(repo), "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });

  // Seed > keepRecent (5) terminal reviews, all old, so the oldest get pruned.
  // Each review with a log file. The newest few must survive (so /last works).
  for (let index = 0; index < 9; index += 1) {
    const id = `old-term-${index}`;
    upsertReview(repo, {
      id,
      kind: "code",
      status: "completed",
      verdict: "CLEAN: ok",
      output: "CLEAN: ok"
    });
    fs.writeFileSync(path.join(reviewsDir, `${id}.log`), "log\n", "utf8");
  }
  // Backdate them all well past the 24h age bound.
  const aged = loadState(repo);
  for (const review of aged.reviews) {
    review.updatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  }
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "state.json"),
    `${JSON.stringify(aged, null, 2)}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  const survivors = loadState(repo).reviews;
  // keepRecent = 5 → exactly 5 survive, 4 pruned.
  assert.equal(survivors.length, 5, "the most recent 5 terminal reviews are kept");
  // Pruned reviews' files are gone; kept reviews' files remain.
  const survivingIds = new Set(survivors.map((r) => r.id));
  let prunedFilesGone = 0;
  let keptFilesPresent = 0;
  for (let index = 0; index < 9; index += 1) {
    const file = path.join(reviewsDir, `old-term-${index}.log`);
    if (survivingIds.has(`old-term-${index}`)) {
      if (fs.existsSync(file)) keptFilesPresent += 1;
    } else if (!fs.existsSync(file)) {
      prunedFilesGone += 1;
    }
  }
  assert.equal(prunedFilesGone, 4, "pruned reviews' files are removed");
  assert.equal(keptFilesPresent, 5, "kept reviews' files are preserved");
});

test("session-end hook NEVER prunes another active session's running review or files", () => {
  const { repo, binDir } = setupRepo();
  const reviewsDir = path.join(resolveStateDir(repo), "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });

  // Another session (session-B) has a FRESH running review still in flight,
  // with its log + output files — its worker is genuinely alive. A session-A
  // cleanup must NOT prune it, NOT reconcile it, and NOT touch its files.
  upsertReview(repo, {
    id: "B-inflight",
    kind: "plan",
    status: "running",
    request: { cwd: repo, prompt: "x", sessionId: "session-B" }
  });
  // Pad with many OLD terminal reviews so the keep-budget pressure is real.
  for (let index = 0; index < 8; index += 1) {
    upsertReview(repo, { id: `pad-${index}`, kind: "code", status: "completed", verdict: "CLEAN: ok" });
  }
  const aged = loadState(repo);
  for (const review of aged.reviews) {
    // Backdate only the terminal pad reviews; keep B-inflight fresh so it is
    // not (correctly) self-healed as stale — this test is about pruning safety.
    if (review.id !== "B-inflight") {
      review.updatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    }
  }
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "state.json"),
    `${JSON.stringify(aged, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(reviewsDir, "B-inflight.log"), "B's log\n", "utf8");
  fs.writeFileSync(path.join(reviewsDir, "B-inflight.output.txt"), "B's output\n", "utf8");

  // Session A ends.
  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "session-A" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  // Session B's running review must still be in state, still running, untouched.
  const bReview = loadState(repo).reviews.find((r) => r.id === "B-inflight");
  assert.ok(bReview, "another session's running review must NOT be pruned from state");
  assert.equal(bReview.status, "running", "another session's review must NOT be reconciled");
  assert.equal(bReview.kind, "plan", "its kind/attribution must be intact");
  // And its files must survive — its worker may still write the verdict.
  assert.ok(
    fs.existsSync(path.join(reviewsDir, "B-inflight.log")),
    "another session's review log must NOT be deleted"
  );
  assert.ok(
    fs.existsSync(path.join(reviewsDir, "B-inflight.output.txt")),
    "another session's review output must NOT be deleted"
  );
});

test("session-end pruning keeps terminal history even behind many fresh in-flight reviews", () => {
  const { repo, binDir } = setupRepo();
  const reviewsDir = path.join(resolveStateDir(repo), "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });

  // A handful of OLD terminal reviews carrying real verdicts — these are the
  // verdict history `/codex-autoreview:last` depends on.
  for (let index = 0; index < 4; index += 1) {
    upsertReview(repo, {
      id: `verdict-${index}`,
      kind: "code",
      status: "completed",
      verdict: `CLEAN: ok ${index}`,
      output: `CLEAN: ok ${index}`
    });
    fs.writeFileSync(path.join(reviewsDir, `verdict-${index}.log`), "v\n", "utf8");
  }
  // Many FRESH in-flight reviews from another active session — they sort
  // newest-first, ahead of the terminal ones. The OLD bug counted keepRecent
  // over the mixed list, so these would push every terminal review past the
  // budget and prune all verdict history.
  for (let index = 0; index < 8; index += 1) {
    upsertReview(repo, {
      id: `busy-${index}`,
      kind: "code",
      status: "running",
      request: { cwd: repo, prompt: "x", sessionId: "other-session" }
    });
  }
  // Backdate only the terminal verdicts so they are "old"; leave the in-flight
  // reviews fresh.
  const st = loadState(repo);
  for (const review of st.reviews) {
    if (review.id.startsWith("verdict-")) {
      review.updatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    }
  }
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "state.json"),
    `${JSON.stringify(st, null, 2)}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "ending-session" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  const survivors = loadState(repo).reviews;
  // keepRecent (5) is counted over TERMINAL reviews only — all 4 terminal
  // verdicts (< 5) must survive, and their files with them.
  for (let index = 0; index < 4; index += 1) {
    const kept = survivors.find((r) => r.id === `verdict-${index}`);
    assert.ok(kept, `terminal verdict verdict-${index} must NOT be pruned`);
    assert.ok(
      fs.existsSync(path.join(reviewsDir, `verdict-${index}.log`)),
      `terminal verdict-${index} file must NOT be deleted`
    );
  }
  // All 8 in-flight reviews are also kept (non-terminal, never pruned).
  for (let index = 0; index < 8; index += 1) {
    assert.ok(
      survivors.find((r) => r.id === `busy-${index}`),
      `non-terminal busy-${index} must be kept`
    );
  }
});

test("session-end hook self-heals a stuck review from ANOTHER session", () => {
  const { repo, binDir } = setupRepo();
  // A stuck running review owned by session-X (its worker was SIGKILL'd).
  upsertReview(repo, {
    id: "X-stuck",
    kind: "code",
    status: "running",
    request: { cwd: repo, prompt: "x", sessionId: "session-X" }
  });
  // A genuinely fresh running review owned by session-Y — must NOT be healed.
  upsertReview(repo, {
    id: "Y-fresh",
    kind: "plan",
    status: "running",
    request: { cwd: repo, prompt: "y", sessionId: "session-Y" }
  });
  const st = loadState(repo);
  st.reviews.find((r) => r.id === "X-stuck").updatedAt = new Date(
    Date.now() - STALE_RUNNING_MS - 300_000
  ).toISOString();
  fs.writeFileSync(
    path.join(resolveStateDir(repo), "state.json"),
    `${JSON.stringify(st, null, 2)}\n`,
    "utf8"
  );

  // A SessionEnd for an unrelated third session must still heal X-stuck.
  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "session-Z" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /healed 1 stuck review/i);

  const reviews = loadState(repo).reviews;
  assert.equal(
    reviews.find((r) => r.id === "X-stuck").status,
    "failed",
    "a stuck review from any session is self-healed"
  );
  assert.equal(
    reviews.find((r) => r.id === "Y-fresh").status,
    "running",
    "a genuinely fresh review is left running"
  );
});

test("session-end hook's second pass kills a worker that raced past reconcile", async () => {
  // A worker can record its pid + claim `running` AFTER the cleanup hook's
  // first snapshot but BEFORE reconcile marks it failed. The post-reconcile
  // second kill pass must still reap that worker's process tree.
  const binDir = makeTempDir();
  const { pidFile } = installHangingCodex(binDir);
  const { repo } = setupRepo();
  const { spawn } = await import("node:child_process");

  const reviewId = seedQueuedReview(repo, {
    timeoutMs: 120_000,
    sessionId: "raced-sess"
  });
  const worker = spawn("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir),
    stdio: "ignore"
  });
  // Let the worker fully claim `running` and spawn its codex child.
  await waitFor(
    () =>
      loadState(repo).reviews.find((r) => r.id === reviewId)?.status === "running" &&
      fs.existsSync(pidFile),
    { timeoutMs: 8000, intervalMs: 50 }
  );
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());

  // SessionEnd for this worker's session. By the time it runs, the review is
  // already `running` with a pid — reconcile will mark it `failed`, and the
  // second pass must still kill the (now `failed`) worker + its codex child.
  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "raced-sess" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /killed 1 worker/i);

  // The worker process and its codex grandchild must both be reaped.
  const workerGone = await waitFor(
    () => worker.exitCode !== null || worker.signalCode !== null,
    { timeoutMs: 8000, intervalMs: 100 }
  );
  assert.ok(workerGone, "the raced worker must be killed by the second pass");
  const codexGone = await waitFor(
    () => {
      try {
        process.kill(grandchildPid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { timeoutMs: 8000, intervalMs: 100 }
  );
  assert.ok(codexGone, "the raced worker's codex child must be reaped too");
  // The review record is terminal.
  assert.equal(loadState(repo).reviews.find((r) => r.id === reviewId).status, "failed");
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

test("session-end hook kills only a VERIFIED review worker, never a reused pid", async () => {
  const { repo } = setupRepo();
  const { spawn } = await import("node:child_process");

  // (a) An UNRELATED long-lived process whose pid we deliberately mis-record on
  //     an in-flight review — simulating pid reuse / stale state. It must NOT
  //     be killed: its command line is not a review-worker.
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore"
  });
  // (b) A genuine review-worker for a real seeded review — it should be killed.
  //     Use a hanging codex so the worker stays alive in `running`.
  const binDir = makeTempDir();
  installHangingCodex(binDir);
  const realReviewId = seedQueuedReview(repo, {
    timeoutMs: 120_000,
    sessionId: "cleanup-sess"
  });
  const realWorker = spawn(
    "node",
    [WORKER, "--cwd", repo, "--review-id", realReviewId],
    { env: buildEnv(binDir), stdio: "ignore" }
  );
  await waitFor(
    () => loadState(repo).reviews.find((r) => r.id === realReviewId)?.status === "running",
    { timeoutMs: 8000, intervalMs: 100 }
  );

  // Record the real worker's pid on the real review, and the bystander's pid on
  // a separate fake in-flight review for the same session.
  upsertReview(repo, { id: realReviewId, pid: realWorker.pid });
  upsertReview(repo, {
    id: "fake-inflight",
    kind: "code",
    status: "running",
    pid: bystander.pid,
    request: { cwd: repo, prompt: "x", sessionId: "cleanup-sess" }
  });

  const result = run("node", [SESSION_END_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "cleanup-sess" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  // The genuine review-worker must have been reaped.
  const realWorkerGone = await waitFor(
    () => realWorker.exitCode !== null || realWorker.signalCode !== null,
    { timeoutMs: 8000, intervalMs: 100 }
  );
  assert.ok(realWorkerGone, "the verified review-worker should have been killed");

  // The unrelated bystander must still be alive — it was never a review-worker.
  let bystanderAlive = true;
  try {
    process.kill(bystander.pid, 0);
  } catch {
    bystanderAlive = false;
  }
  assert.ok(bystanderAlive, "an unrelated reused pid must NOT be signalled");
  bystander.kill("SIGKILL");

  // Both in-flight reviews are still reconciled to a terminal state regardless.
  const reviews = loadState(repo).reviews;
  assert.equal(reviews.find((r) => r.id === realReviewId).status, "failed");
  assert.equal(reviews.find((r) => r.id === "fake-inflight").status, "failed");
});
