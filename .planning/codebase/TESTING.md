# Testing Patterns

**Analysis Date:** 2026-05-14

## Test Framework

**Runner:**
- Node's built-in test runner — `node --test`. No Jest, Vitest, Mocha, or any test dependency.
- `import test from "node:test";` at the top of every test file.
- Config: none. There is no `jest.config.*` / `vitest.config.*`. The entire configuration is the npm script.

**Assertion Library:**
- Node's built-in strict assertions — `import assert from "node:assert/strict";`.
- Used: `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.match`, `assert.throws`. (`assert/strict` makes `equal`/`deepEqual` use `===` semantics.)

**Run Commands:**
```bash
npm test                                  # from repo root — delegates into the plugin
npm test --prefix plugins/codex-autoreview # explicit
node --test tests/*.test.mjs               # from plugins/codex-autoreview/ — the actual command
node --test tests/foundation.test.mjs      # run a single file
node --test --test-name-pattern "F5:" tests/*.test.mjs  # run by name prefix
```
- No watch-mode or coverage script is defined. `node --test --watch` and `node --test --experimental-test-coverage` work ad hoc but are not wired in.

## Test File Organization

**Location:**
- Separate `tests/` directory under the plugin: `plugins/codex-autoreview/tests/`. NOT co-located with source.
- 6 test files + 1 shared `helpers.mjs`, ~229 `test(...)` calls total.

**Naming:**
- `<area>.test.mjs`. Only `*.test.mjs` files are picked up by the `tests/*.test.mjs` glob — `helpers.mjs` is deliberately not matched.
- Files are organized by **delivery phase / wave**, not by source module:
  - `foundation.test.mjs` — Phase 1 foundation (F1–F6: reviewer backends, schema, state, git anchoring, codex hardening, pricing).
  - `codex-autoreview.test.mjs` — end-to-end: CLI, both hooks, statusline, worker, unit resolvers.
  - `phase2-cli.test.mjs` — CLI subcommands, slash-command `.md` contract, backends, consensus.
  - `phase2-dispatch.test.mjs` — dispatch hooks, worker prompt-assembly.
  - `phase2-docs.test.mjs` — docs/config-doc contract checks.
  - `phase2-surfacing.test.mjs` — severity-gated verdict surfacing, session digest.

**Structure:**
```text
plugins/codex-autoreview/
└── tests/
    ├── helpers.mjs              # shared fixtures — NOT a test file
    ├── foundation.test.mjs
    ├── codex-autoreview.test.mjs
    ├── phase2-cli.test.mjs
    ├── phase2-dispatch.test.mjs
    ├── phase2-docs.test.mjs
    └── phase2-surfacing.test.mjs
```

## Test Structure

**Suite Organization:**
- **Flat** — every test is a top-level `test("name", fn)` call. No `describe()` blocks, no nested `t.test()` subtests anywhere in the suite.
- Grouping is by **name-prefix convention**, not by structure. Test names start with a stable tag: `"F1: ..."`, `"F5: ..."`, `"2C: ..."`. This makes `--test-name-pattern "F5:"` a working "run this group" filter.
- Within a file, related tests are clustered under a full-width comment divider:
  ```javascript
  // =========================================================================
  // F1 — pluggable reviewer abstraction
  // =========================================================================
  ```
- Every test file opens with a `/** ... @file */` block stating what the file covers and whether it is unit or integration.

**Patterns:**
- Test names are full sentences describing the asserted behavior AND the rationale — `"resolveReviewModel returns null when unset (model stays inherited for auth-compat)"`.
- Setup is **per-test, inline** — no shared `beforeEach`/`afterEach`. Tests that need a repo call a local `setupRepo()` helper at the top of the test body.
- Many tests carry inline comments restating the design invariant being protected, so a failure points straight at the violated contract.

```javascript
test("F1: getReviewerBackend falls back to the default for unknown/missing ids", () => {
  // An old queued record from before F1 has no `backend` field → must resolve
  // to the default so the migration is non-breaking.
  assert.equal(getReviewerBackend(undefined).id, DEFAULT_BACKEND_ID);
  assert.equal(getReviewerBackend("bogus").id, DEFAULT_BACKEND_ID);
});
```

## Mocking

**Framework:** None. `node:test`'s `mock` API is **not used**. There are no stubs, spies, or module mocks.

**Approach — real processes against fake binaries on PATH:**
- Instead of mocking, the suite installs a **fake `codex` executable** into a temp bin dir and prepends that dir to `PATH`. The code under test then shells out for real, but hits the fake. This is the central testing technique. Helpers in `tests/helpers.mjs`:
  - `installFakeCodex(binDir, { verdict?, mode })` — writes an executable Node script that mimics the real `codex exec` contract: verdict goes to the `--output-last-message` file (not stdout), a transcript goes to stderr, `--version` prints a banner. `mode: "fail"` simulates a rejected request (`ERROR: {...}` on stderr, exit 1).
  - `installHangingCodex(binDir, { pidFile })` — a fake that spawns a long-lived grandchild and blocks forever, never writing the output file. Exercises the worker's hard timeout and process-tree kill. The grandchild self-reaps when orphaned so no test leaks a process.
  - `installVersionHangingCodex(binDir)` — `--version` itself hangs; verifies the availability probe is time-boxed.
  - `buildEnv(binDir, extra)` — env with `binDir` prepended to `PATH` (fake codex wins).
  - `buildEnvWithoutCodex(extra)` — a clean bin dir with only `node` + `git` symlinks, so `codex` is genuinely absent — tests the "CLI not installed" path.

```javascript
const repo = makeTempDir();
const binDir = makeTempDir();
installFakeCodex(binDir, { verdict: "ISSUES: found a bug." });
initGitRepo(repo);
const result = run(process.execPath, [CLI, "run"], {
  cwd: repo,
  env: buildEnv(binDir)
});
assert.match(result.stdout, /ISSUES:/);
```

**What to Mock:** Nothing via a mocking library. External dependencies are substituted at the **process boundary** (a fake binary on `PATH`) or the **filesystem boundary** (a fresh temp dir).

**What NOT to Mock:** Internal modules — they are imported and called directly. `git`, `fs`, and the spawn machinery run for real against temp dirs.

## Fixtures and Factories

**Test Data:**
- Shared fixture helpers live in `tests/helpers.mjs` (the one non-`.test` file in `tests/`):
  - `makeTempDir()` — `fs.mkdtempSync` under the OS tmpdir with a `codex-autoreview-test-` prefix.
  - `initGitRepo(dir)` — `git init` + identity config + an initial committed `README.md`.
  - `run(command, args, options)` — thin `spawnSync` wrapper returning `{ status, stdout, stderr }` with a 16 MB `maxBuffer`.
  - `waitFor(predicate, { timeoutMs, intervalMs })` — async poll, used to await detached-worker completion.
- Per-file factories build on those — e.g. `setupRepo({ onboarded })` in `codex-autoreview.test.mjs` creates a temp repo + fake-codex bin dir and marks the repo onboarded by default (the onboarding gate blocks dispatch otherwise).
- Inline literal fixtures for prompt/plan text — e.g. the `LARGE_PLAN` constant assembled from an array of lines.

**Location:**
- All cross-file fixtures: `plugins/codex-autoreview/tests/helpers.mjs`.
- Path constants resolved once at the top of each test file from `import.meta.url` — `const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")`, then `CLI`, `CODE_HOOK`, `PLAN_HOOK`, `STATUSLINE` derived from it.

## Coverage

**Requirements:** None enforced. No coverage threshold, no coverage gate in CI or the npm script.

**View Coverage:**
```bash
node --test --experimental-test-coverage tests/*.test.mjs   # ad hoc; not wired in
```
- Coverage emphasis is on the foundation libraries (`scripts/lib/`) and the hook/CLI entry behavior. JSON-RPC scaffold backends (`app-server.mjs`) have lighter coverage by design — they are scaffolds.

## Test Types

**Unit Tests:**
- The majority. Pure functions imported and asserted directly — resolvers (`resolveReviewModel`, `resolveReviewEffort`), builders (`buildCodexExecArgs`), parsers (`parseCodexJsonStream`, `parseReviewProseFindings`), normalizers, schema rendering. No I/O, no temp dirs.

**Integration Tests:**
- Run the real entry-point scripts as child processes (`run(process.execPath, [CLI, ...])`) against a temp git repo with a fake `codex` on `PATH`. Exercise: the CLI subcommands, both review hooks fed JSON on stdin, the statusline, and the detached worker end-to-end (dispatch → `waitFor` → assert persisted state).
- Test files state in their `@file` block whether they are "pure-unit where possible" with "the few integration paths" using helpers — the two are intentionally mixed within a file.

**E2E Tests:**
- Not separated as a distinct tier. The "end-to-end" coverage in `codex-autoreview.test.mjs` is the integration tier described above — there is no browser/UI E2E layer (this is a CLI plugin).

## Common Patterns

**Async Testing:**
- `async () => {}` test bodies (~22 of them) for anything that spawns a detached worker or awaits a backend `run()`.
- The detached-worker pattern: dispatch, then `await waitFor(() => loadState(repo).reviews[0]?.status === "completed")`, then assert on the persisted state. `waitFor` polls (default 10 s timeout, 50 ms interval) rather than using fixed sleeps.

```javascript
const dispatch = dispatchBackgroundReview({ cwd: repo, kind: "code", ... });
await waitFor(() => {
  const review = loadState(repo).reviews.find((r) => r.id === dispatch.reviewId);
  return review && (review.status === "completed" || review.status === "failed");
});
const review = loadState(repo).reviews.find((r) => r.id === dispatch.reviewId);
assert.equal(review.status, "completed");
```

**Error Testing:**
- `assert.throws(() => fn(badInput), /regex/)` for the `normalize*` validators that reject bad config — `assert.throws(() => normalizeReasoningEffort("minimal"), /Unsupported reasoning effort/)`.
- For the never-throw paths, the assertion is on the **returned result object** instead: `assert.equal(parsed.ok, false)` and `assert.ok(parsed.errorMessage)`, or `assert.match(review.errorMessage, /timed out after \d+s/)`.
- `assert.rejects` is available but rarely needed — most async code resolves a result object rather than rejecting.

**Cleanup:**
- There is **no explicit teardown** — no `after()` hook, no `rmSync` of temp dirs in test bodies. Temp directories under the OS tmpdir are left for the OS to reclaim.
- The exception is process cleanup: the hanging-codex fakes are written to **self-reap when orphaned** (they poll `process.ppid` and exit when it changes), so even a `SIGKILL`'d worker cannot leak a process tree. This keeps the suite safe without per-test cleanup hooks.

---

*Testing analysis: 2026-05-14*
