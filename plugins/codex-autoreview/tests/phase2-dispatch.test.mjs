/**
 * Phase 2 / Wave A1 tests — dispatch hooks & worker.
 *
 * Covers the Wave A1 deliverables:
 *   - malformed / empty stdin in the review hooks → a clean no-op (exit 0,
 *     nothing dispatched);
 *   - the onboarding gate — review hooks no-op until `isOnboarded()`;
 *   - dispatch-time fingerprint capture + dedupe of identical pending/recent
 *     reviews;
 *   - prompt redaction — no fully rendered prompt is persisted, and the worker
 *     strips the redactable runtime payload once it has it;
 *   - pre-run stale detection — a worktree that moved before the worker starts
 *     settles a cheap terminal STALE without a codex call;
 *   - the SessionStart onboarding hook (per-`source` behavior, onboarded → no-op);
 *   - the pre-push hook's shell-aware `git push` detector;
 *   - `hooks.json` migrated to exec form, with the two new hook entries;
 *   - the bounded-auto-feedback SCAFFOLD (`reviewMode` resolves, defaults OFF).
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
  DEDUPE_WINDOW_MS,
  findDuplicateReview
} from "../scripts/lib/auto-review.mjs";
import {
  DEFAULT_REVIEW_MODE,
  REVIEW_MODES,
  resolveMaxFeedbackLoops,
  resolveReviewMode
} from "../scripts/review-worker.mjs";
import {
  ONBOARDING_SOURCES,
  onboardingContextForSource
} from "../scripts/onboarding-hook.mjs";
import { commandContainsGitPush } from "../scripts/pre-push-review-hook.mjs";

import {
  loadState,
  markOnboarded,
  upsertReview
} from "../scripts/lib/state.mjs";
import { computeDiffFingerprint } from "../scripts/lib/git.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");
const CLI = path.join(SCRIPTS, "codex-autoreview.mjs");
const PLAN_HOOK = path.join(SCRIPTS, "auto-plan-review-hook.mjs");
const CODE_HOOK = path.join(SCRIPTS, "auto-code-review-hook.mjs");
const PREPUSH_HOOK = path.join(SCRIPTS, "pre-push-review-hook.mjs");
const ONBOARDING_HOOK = path.join(SCRIPTS, "onboarding-hook.mjs");
const WORKER = path.join(SCRIPTS, "review-worker.mjs");

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
 * A git repo with the fake codex on PATH, the plugin ENABLED, and onboarding
 * COMPLETE — the steady-state a review hook expects.
 *
 * @returns {{ repo: string, binDir: string }}
 */
function setupOnboardedRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  markOnboarded(repo);
  return { repo, binDir };
}

// --------------------------------------------------------------------------
// Malformed / empty stdin → a clean no-op (exit 0, nothing dispatched).
// --------------------------------------------------------------------------

test("review hooks no-op cleanly on malformed JSON stdin (exit 0, no dispatch)", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "a change worth reviewing\n");

  for (const hook of [PLAN_HOOK, CODE_HOOK, PREPUSH_HOOK]) {
    const result = run("node", [hook], {
      input: "{ this is not valid json",
      env: buildEnv(binDir, { CLAUDE_PROJECT_DIR: repo })
    });
    assert.equal(result.status, 0, `${path.basename(hook)} must exit 0 on malformed stdin: ${result.stderr}`);
    assert.equal(result.stdout, "", `${path.basename(hook)} must emit no decision on malformed stdin`);
  }
  // Nothing was dispatched.
  assert.equal(loadState(repo).reviews.length, 0, "malformed stdin must dispatch no review");
});

test("review hooks no-op cleanly on empty stdin (exit 0, no dispatch)", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "a change worth reviewing\n");

  for (const hook of [PLAN_HOOK, CODE_HOOK, PREPUSH_HOOK]) {
    const result = run("node", [hook], {
      input: "",
      env: buildEnv(binDir, { CLAUDE_PROJECT_DIR: repo })
    });
    assert.equal(result.status, 0, `${path.basename(hook)} must exit 0 on empty stdin: ${result.stderr}`);
    assert.equal(result.stdout, "", `${path.basename(hook)} must emit no decision on empty stdin`);
  }
  assert.equal(loadState(repo).reviews.length, 0, "empty stdin must dispatch no review");
});

// --------------------------------------------------------------------------
// Onboarding gate — review hooks no-op until the workspace is onboarded.
// --------------------------------------------------------------------------

test("plan review hook no-ops when the workspace is NOT onboarded", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  // Enabled, but NOT onboarded.
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });

  const result = run("node", [PLAN_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1", tool_input: { plan: LARGE_PLAN } }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "the hook must never emit a blocking decision");
  assert.match(result.stderr, /onboarding/i, "the hook should explain it skipped for onboarding");
  assert.equal(loadState(repo).reviews.length, 0, "a non-onboarded workspace must dispatch no review");
});

test("code review hook no-ops when the workspace is NOT onboarded", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  fs.appendFileSync(path.join(repo, "README.md"), "uncommitted change\n");

  const result = run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /onboarding/i);
  assert.equal(loadState(repo).reviews.length, 0, "a non-onboarded workspace must dispatch no review");
});

test("review hooks DO dispatch once the workspace is onboarded", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "uncommitted change worth a review\n");

  const result = run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const reviews = loadState(repo).reviews;
  assert.equal(reviews.length, 1, "an onboarded + enabled hook must dispatch a review");
  assert.equal(reviews[0].kind, "code");
});

// --------------------------------------------------------------------------
// Dispatch-time fingerprint capture + dedupe.
// --------------------------------------------------------------------------

test("dispatch captures the F4 anchoring fingerprint into the review record", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "a tracked change\n");

  run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  const review = loadState(repo).reviews[0];
  assert.ok(review, "a review was dispatched");
  const expected = computeDiffFingerprint(repo);
  assert.ok(expected.available, "the test repo has a computable diff fingerprint");
  assert.equal(
    review.request.reviewedInputHash,
    expected.fingerprint,
    "the dispatched review must carry the diff fingerprint captured at dispatch"
  );
});

test("dispatch DEDUPES a second identical code review against a pending one", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "the one change under review\n");

  // First dispatch — a real review record lands.
  run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  const afterFirst = loadState(repo).reviews;
  assert.equal(afterFirst.length, 1, "the first dispatch creates one review");

  // Second dispatch of the EXACT same working tree — must be deduped.
  const second = run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /skipped/i, "the second dispatch should report it was deduped");
  assert.equal(
    loadState(repo).reviews.length,
    1,
    "an identical pending review must NOT spawn a duplicate"
  );
});

test("findDuplicateReview: queued/running always dedupe; completed only within the window", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const key = "code exec-generic sha256-" + "a".repeat(64);
  const mk = (over) => ({
    id: "x",
    kind: "code",
    backend: "exec-generic",
    reviewedInputHash: "sha256-" + "a".repeat(64),
    status: "queued",
    verdict: null,
    updatedAt: new Date(now).toISOString(),
    ...over
  });

  // A queued / running equivalent always suppresses.
  assert.ok(findDuplicateReview([mk({ status: "queued" })], key, { now }));
  assert.ok(findDuplicateReview([mk({ status: "running" })], key, { now }));

  // A completed equivalent suppresses only inside DEDUPE_WINDOW_MS.
  const justInside = mk({
    status: "completed",
    verdict: "CLEAN: ok",
    updatedAt: new Date(now - (DEDUPE_WINDOW_MS - 1000)).toISOString()
  });
  assert.ok(findDuplicateReview([justInside], key, { now }), "a recent completed review dedupes");
  const wellOutside = mk({
    status: "completed",
    verdict: "CLEAN: ok",
    updatedAt: new Date(now - (DEDUPE_WINDOW_MS + 60_000)).toISOString()
  });
  assert.equal(
    findDuplicateReview([wellOutside], key, { now }),
    null,
    "a stale completed review no longer dedupes"
  );

  // A `failed` review never suppresses a re-dispatch.
  const failed = mk({ status: "failed" });
  assert.equal(findDuplicateReview([failed], key, { now }), null, "a failed review never dedupes");

  // A completed-but-STALE review never suppresses a re-dispatch.
  const staleVerdict = mk({ status: "completed", verdict: "STALE: tree moved" });
  assert.equal(
    findDuplicateReview([staleVerdict], key, { now }),
    null,
    "a STALE-verdict review never dedupes"
  );

  // A different backend is a different key — never deduped.
  const otherBackend = mk({ status: "queued", backend: "exec-review" });
  assert.equal(
    findDuplicateReview([otherBackend], key, { now }),
    null,
    "a different backend is a different dedupe key"
  );
});

// --------------------------------------------------------------------------
// Prompt redaction — no rendered prompt persisted; runtime payload stripped.
// --------------------------------------------------------------------------

test("dispatch never persists a fully rendered prompt — only metadata + runtime payload", () => {
  const { repo, binDir } = setupOnboardedRepo();

  run("node", [PLAN_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1", tool_input: { plan: LARGE_PLAN } }),
    env: buildEnv(binDir)
  });
  const review = loadState(repo).reviews[0];
  assert.ok(review, "a plan review was dispatched");
  // The dispatcher records the redactable plan text, NOT a wrapped prompt.
  assert.equal(typeof review.request.prompt, "undefined", "no rendered prompt is persisted at dispatch");
  assert.equal(review.request.planText, LARGE_PLAN, "the redactable plan text is the runtime payload");
});

test("the worker REDACTS the runtime payload from state as soon as it claims the review", () => {
  const { repo, binDir } = setupOnboardedRepo();

  // Dispatch a plan review; its runtime payload is the plan text.
  run("node", [PLAN_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1", tool_input: { plan: LARGE_PLAN } }),
    env: buildEnv(binDir)
  });
  const reviewId = loadState(repo).reviews[0].id;

  // Run the detached worker to completion against the fake codex.
  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "completed", "the worker completed the review");
  // The prompt-bearing runtime payload must be gone, with a redaction marker.
  assert.equal(review.request.planText, undefined, "planText must be redacted post-claim");
  assert.equal(review.request.claudeResponseBlock, undefined, "claudeResponseBlock must be redacted");
  assert.equal(review.request.prompt, undefined, "no rendered prompt may remain");
  assert.equal(review.request.promptRedacted, true, "a redaction marker must be stamped");
  assert.equal(
    typeof review.request.promptRedactedAt,
    "string",
    "the redaction marker carries a timestamp"
  );
});

test("the worker redacts a LEGACY request.prompt too (backward tolerance)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  markOnboarded(repo);

  // Seed an OLD-style queued record that still carries a fully rendered prompt.
  const reviewId = `legacy-${Date.now().toString(36)}`;
  upsertReview(repo, {
    id: reviewId,
    kind: "code",
    status: "queued",
    request: {
      cwd: repo,
      prompt: "LEGACY rendered prompt body that must not linger",
      model: null,
      effort: "medium"
    }
  });

  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "completed", "the worker still completes a legacy record");
  assert.equal(review.request.prompt, undefined, "a legacy rendered prompt must be redacted");
  assert.equal(review.request.promptRedacted, true, "a redaction marker must be stamped");
});

// --------------------------------------------------------------------------
// Pre-run stale detection — a moved worktree settles a cheap terminal STALE.
// --------------------------------------------------------------------------

test("the worker settles STALE without a codex call when the worktree moved pre-run", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "the originally-reviewed change\n");

  // Dispatch a code review — captures the fingerprint of the current tree.
  run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  const reviewId = loadState(repo).reviews[0].id;

  // Move the working tree BEFORE the worker runs — the anchored input is gone.
  fs.appendFileSync(path.join(repo, "README.md"), "a later change that moved the tree\n");

  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "completed", "a pre-run-stale review settles terminally, not stuck");
  assert.match(review.verdict, /^STALE/, "the verdict must be STALE");
  // The recomputed hash is recorded and differs from the dispatch-time hash.
  const current = computeDiffFingerprint(repo);
  assert.equal(review.reviewedInputHash, current.fingerprint, "the recomputed anchor is recorded");
});

test("the worker runs normally when the worktree is UNCHANGED pre-run (not stale)", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "the change under review\n");

  run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  const reviewId = loadState(repo).reviews[0].id;

  // Worker runs against the SAME tree — must produce the fake codex verdict.
  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "completed");
  assert.match(review.verdict, /^CLEAN/, "an unchanged tree gets the real review verdict, not STALE");
});

// --------------------------------------------------------------------------
// SessionStart onboarding hook.
// --------------------------------------------------------------------------

test("onboardingContextForSource: full walkthrough on startup, lighter on resume/clear", () => {
  const startup = onboardingContextForSource("startup");
  const clear = onboardingContextForSource("clear");
  const resume = onboardingContextForSource("resume");
  const compact = onboardingContextForSource("compact");
  const unknown = onboardingContextForSource("something-new");

  assert.ok(startup.length > clear.length, "startup is the fullest walkthrough");
  assert.ok(clear.length > resume.length, "clear is a terse checklist, shorter than the full walkthrough");
  assert.equal(resume, compact, "resume and compact share the one-line reminder");
  assert.equal(unknown, resume, "an unknown source is treated like resume");
  for (const ctx of [startup, clear, resume]) {
    assert.match(ctx, /onboard/i, "every onboarding context references onboarding");
  }
  assert.ok(Array.isArray(ONBOARDING_SOURCES) && ONBOARDING_SOURCES.length > 0);
});

test("onboarding hook injects guided context when NOT onboarded", () => {
  const repo = makeTempDir();
  initGitRepo(repo);

  const result = run("node", [ONBOARDING_HOOK], {
    input: JSON.stringify({ cwd: repo, source: "startup", hook_event_name: "SessionStart" })
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(payload.hookSpecificOutput.additionalContext, /onboard/i);
});

test("onboarding hook injects NOTHING once the workspace is onboarded", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  markOnboarded(repo);

  for (const source of ["startup", "resume", "clear", "compact"]) {
    const result = run("node", [ONBOARDING_HOOK], {
      input: JSON.stringify({ cwd: repo, source, hook_event_name: "SessionStart" })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", `an onboarded workspace injects nothing on source=${source}`);
  }
});

test("onboarding hook exits 0 even on malformed stdin (SessionStart can never block)", () => {
  const result = run("node", [ONBOARDING_HOOK], { input: "{ not json" });
  assert.equal(result.status, 0, "the onboarding hook must always exit 0");
});

// --------------------------------------------------------------------------
// Pre-push hook — shell-aware `git push` detection.
// --------------------------------------------------------------------------

test("commandContainsGitPush matches real git push invocations", () => {
  const positives = [
    "git push",
    "git push origin main",
    "git -C /some/dir push",
    "git -c user.name=x push",
    "FOO=bar git push",
    "env FOO=bar git push origin main",
    "npm test && git push",
    "git add -A && git commit -m wip && git push",
    "git push --force-with-lease origin feature"
  ];
  for (const command of positives) {
    assert.equal(commandContainsGitPush(command), true, `should DETECT a push in: ${command}`);
  }
});

test("commandContainsGitPush rejects non-push and quoted/dry-run lookalikes", () => {
  const negatives = [
    "git status",
    "git commit -m 'ready to git push later'",
    "echo git push",
    "echo 'git push'",
    'echo "git push"',
    "git push --dry-run origin main",
    "git push -n origin main",
    "mygit push",
    "gitpush",
    "git pushup",
    "cat git-push.sh",
    ""
  ];
  for (const command of negatives) {
    assert.equal(commandContainsGitPush(command), false, `should NOT detect a push in: ${command}`);
  }
});

test("pre-push hook fast-paths a non-push Bash command to a clean no-op", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "uncommitted change\n");

  const result = run("node", [PREPUSH_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1", tool_input: { command: "ls -la" } }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "a non-push Bash call must produce no permission decision");
  assert.equal(loadState(repo).reviews.length, 0, "a non-push command dispatches no review");
});

test("pre-push hook dispatches a NON-BLOCKING review on a detected git push", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "about-to-push change\n");

  const result = run("node", [PREPUSH_HOOK], {
    input: JSON.stringify({
      cwd: repo,
      session_id: "s1",
      tool_input: { command: "git push origin main" }
    }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  // NON-BLOCKING: no permissionDecision is ever emitted — empty stdout, exit 0.
  assert.equal(result.stdout, "", "the pre-push hook must never emit a permission decision");
  const reviews = loadState(repo).reviews;
  assert.equal(reviews.length, 1, "a detected git push dispatches a code review");
  assert.equal(reviews[0].kind, "code");
  assert.equal(reviews[0].request.trigger, "pre-push", "the review records the pre-push trigger");
});

test("pre-push hook DEDUPES against a code review the Stop hook already dispatched", () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "the single change being shipped\n");

  // Stop hook dispatches a code review first.
  run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  assert.equal(loadState(repo).reviews.length, 1);

  // A git push of the SAME tree must NOT spawn a duplicate review.
  const prepush = run("node", [PREPUSH_HOOK], {
    input: JSON.stringify({
      cwd: repo,
      session_id: "s1",
      tool_input: { command: "git push" }
    }),
    env: buildEnv(binDir)
  });
  assert.equal(prepush.status, 0, prepush.stderr);
  assert.equal(
    loadState(repo).reviews.length,
    1,
    "the pre-push review must dedupe against the identical pending code review"
  );
});

test("pre-push hook no-ops when the workspace is not onboarded", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  run("node", [CLI, "config", "--enable", "--cwd", repo, "--json"], { env: buildEnv(binDir) });
  fs.appendFileSync(path.join(repo, "README.md"), "uncommitted change\n");

  const result = run("node", [PREPUSH_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1", tool_input: { command: "git push" } }),
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadState(repo).reviews.length, 0, "a non-onboarded pre-push dispatches no review");
});

// --------------------------------------------------------------------------
// hooks.json — exec form + the two new hook entries.
// --------------------------------------------------------------------------

test("hooks.json is migrated to exec form and registers the new hooks", () => {
  const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  /** @type {Array<{type:string,command:string,args?:string[]}>} */
  const allCommands = [];
  for (const event of Object.keys(hooksJson.hooks)) {
    for (const group of hooksJson.hooks[event]) {
      for (const hook of group.hooks) {
        allCommands.push(hook);
      }
    }
  }
  // EXEC FORM: every command is the bare executable + an args[] array; no
  // command string carries embedded whitespace/arguments.
  for (const hook of allCommands) {
    assert.equal(hook.type, "command");
    assert.ok(Array.isArray(hook.args), `exec form: ${hook.command} must have an args[] array`);
    assert.ok(
      !/\s/.test(hook.command),
      `exec form: the command must be the bare executable, got "${hook.command}"`
    );
    assert.ok(
      hook.args.some((arg) => arg.includes("${CLAUDE_PLUGIN_ROOT}")),
      "the script path is passed as a literal ${CLAUDE_PLUGIN_ROOT} arg"
    );
  }

  // The SessionStart onboarding hook is registered.
  const sessionStart = JSON.stringify(hooksJson.hooks.SessionStart ?? []);
  assert.match(sessionStart, /onboarding-hook\.mjs/, "SessionStart runs the onboarding hook");

  // The PreToolUse/Bash pre-push hook is registered alongside ExitPlanMode.
  const preToolUse = hooksJson.hooks.PreToolUse ?? [];
  const matchers = preToolUse.map((group) => group.matcher);
  assert.ok(matchers.includes("ExitPlanMode"), "ExitPlanMode is still wired");
  assert.ok(matchers.includes("Bash"), "a PreToolUse/Bash group is wired for pre-push");
  assert.match(
    JSON.stringify(preToolUse),
    /pre-push-review-hook\.mjs/,
    "the Bash matcher runs the pre-push review hook"
  );
});

// --------------------------------------------------------------------------
// Bounded-auto-feedback SCAFFOLD — present, defaults OFF.
// --------------------------------------------------------------------------

test("review-mode scaffold: resolveReviewMode defaults to advisory; the feature is OFF", () => {
  assert.equal(DEFAULT_REVIEW_MODE, "advisory", "the default review mode is advisory (feature OFF)");
  assert.deepEqual(
    [...REVIEW_MODES],
    ["advisory", "soft-gate", "bounded-feedback"],
    "the three review modes are scaffolded"
  );
  // Unset / unknown / garbage all resolve to the safe default.
  assert.equal(resolveReviewMode(undefined), "advisory");
  assert.equal(resolveReviewMode(null), "advisory");
  assert.equal(resolveReviewMode("not-a-mode"), "advisory");
  // The other modes are recognized when explicitly requested (scaffold only).
  assert.equal(resolveReviewMode("soft-gate"), "soft-gate");
  assert.equal(resolveReviewMode("bounded-feedback"), "bounded-feedback");
  assert.equal(resolveReviewMode(" Advisory "), "advisory", "normalized case-insensitively");
});

test("review-mode scaffold: resolveMaxFeedbackLoops normalizes the loop bound", () => {
  assert.equal(resolveMaxFeedbackLoops(undefined), 1, "an unset bound has a sane default");
  assert.equal(resolveMaxFeedbackLoops(0), 0, "zero is a valid bound");
  assert.equal(resolveMaxFeedbackLoops(3), 3);
  assert.equal(resolveMaxFeedbackLoops(2.7), 2, "non-integers are truncated");
  assert.equal(resolveMaxFeedbackLoops(-5), 1, "a negative bound falls back to the default");
  assert.equal(resolveMaxFeedbackLoops("nope"), 1, "a non-number falls back to the default");
});

test("a completed advisory review records its reviewMode (scaffold is wired, not active)", async () => {
  const { repo, binDir } = setupOnboardedRepo();
  fs.appendFileSync(path.join(repo, "README.md"), "a change to review under advisory mode\n");

  run("node", [CODE_HOOK], {
    input: JSON.stringify({ cwd: repo, session_id: "s1" }),
    env: buildEnv(binDir)
  });
  const reviewId = loadState(repo).reviews[0].id;
  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "completed");
  // The scaffold records the mode on the settled record; advisory = nothing
  // was gated or auto-corrected.
  assert.equal(review.reviewMode, "advisory", "the completed review records the advisory mode");
});

// --------------------------------------------------------------------------
// Worker still reaches a terminal state when codex is absent (regression).
// --------------------------------------------------------------------------

test("the worker still reaches a terminal state when the codex CLI is absent", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  markOnboarded(repo);
  const reviewId = `seed-${Date.now().toString(36)}`;
  upsertReview(repo, {
    id: reviewId,
    kind: "code",
    status: "queued",
    request: { cwd: repo, model: null, effort: "medium" }
  });
  const result = run("node", [WORKER, "--cwd", repo, "--review-id", reviewId], {
    env: buildEnvWithoutCodex()
  });
  assert.notEqual(result.status, 0, "the worker exits nonzero when codex is unavailable");
  const review = loadState(repo).reviews.find((r) => r.id === reviewId);
  assert.equal(review.status, "failed", "a backend-unavailable review must land terminal, not stuck");
});
