# Codebase Concerns

**Analysis Date:** 2026-05-14

This document records technical debt, known bugs, security considerations, and
fragile areas for the `codex-autoreview` Claude Code plugin (Node.js ESM,
plugin code under `plugins/codex-autoreview/`).

The five open findings from the 2026-05-14 Codex code review (F-02 … F-06) are
recorded first, in severity order, followed by other concerns surfaced during
this mapping pass. Finding F-01 (command injection via unquoted `$ARGUMENTS`
in command `.md` files) was already fixed in commit `8a69f70` and is NOT
listed as open.

---

## Security Considerations

### F-02 (HIGH) — Arbitrary file read via unchecked `planFilePath`

- **Risk:** The plan-review hook reads whatever absolute path the
  `ExitPlanMode` tool input names, with no workspace-containment check, no
  `realpath`/symlink resolution, and no size cap. A crafted or mistaken
  `tool_input.planFilePath` (e.g. `/etc/passwd`, `~/.ssh/id_rsa`, a symlink
  pointing outside the repo) is read in full, its contents become the "plan
  text", and that text is then sent to the Codex backend as the review
  payload — an exfiltration path for any file the plugin process can read.
- **Files:** `scripts/auto-plan-review-hook.mjs:86` (`extractPlanText` — reads
  `toolInput.planFilePath` directly into `fs.readFileSync`).
- **Current mitigation:** None. The `try/catch` only suppresses read errors;
  it does not constrain the path. The MIN_REVIEWABLE_PLAN_CHARS gate does not
  bound an upper size.
- **Recommendations:**
  1. Resolve the path with `fs.realpathSync` and reject anything not contained
     under `resolveWorkspaceRoot(cwd)` (prefix check on the *canonical* paths,
     not the raw strings — so a symlink that escapes the tree is caught).
  2. Reject non-regular files (`fs.statSync().isFile()`).
  3. Impose an upper byte cap on the read (read with a bounded buffer or
     `stat` first) so a huge file cannot balloon hook/worker memory.
  4. Apply the same containment rule to `projectInstructionsPath` resolution
     in all three review hooks for consistency, even though those paths are
     plugin-derived today.

### Untrusted external reviewer backend executes an arbitrary user CLI

- **Risk:** The `external` reviewer backend spawns an arbitrary command +
  argv from `config.backendConfig` with placeholder substitution
  (`{prompt}`, `{cwd}`, `{outputFile}`, …). This is by design (a second
  reviewer of the user's choosing), but it means project-level state
  (`backendConfig`) is a code-execution surface: anything that can write the
  per-project state file can make the worker run an arbitrary binary.
- **Files:** `scripts/lib/reviewers/external.mjs:154-191` (`buildPlaceholders`,
  `substituteArg`), `:209` (`buildExternalChildEnv`), `:255+` (detached spawn).
- **Current mitigation:** The child env is allowlisted
  (`buildExternalChildEnv` — `PATH`/`HOME` by default, plus a configurable
  allowlist); spawn is not shelled (exec form, no shell interpolation); a hard
  wall-clock timeout reaps the process tree. `validateExternalConfig` checks
  shape but not the *safety* of the command.
- **Recommendations:** Document the trust boundary explicitly (the per-project
  state file must be treated as trusted input); consider requiring the
  `external` backend to be opt-in per workspace via the onboarding flow rather
  than silently honored from state.

### Worker inherits the full parent environment

- **Risk:** `dispatchBackgroundReview` spawns the detached worker with
  `{ ...process.env }` (the worker, in turn, builds a *minimal* allowlisted env
  for the `codex` child — that part is good). The worker process itself still
  carries every secret-bearing var from the Claude session. If the worker
  logs or crashes verbosely, or a future backend forwards its own env, those
  secrets are in scope.
- **Files:** `scripts/lib/auto-review.mjs:306-309` (`childEnv = { ...process.env, … }`).
- **Current mitigation:** The worker only forwards an allowlisted subset to the
  `codex`/external child (`buildCodexChildEnv`, `buildExternalChildEnv`); the
  worker does not deliberately print env.
- **Recommendations:** Consider trimming the worker's own env to an allowlist
  at dispatch time (it needs little beyond `PATH`, `HOME`, `CODEX_HOME`,
  `CLAUDE_PLUGIN_DATA`, and the session-id var) so a secret never reaches the
  detached process at all — defense in depth behind the already-good child-env
  allowlisting.

---

## Known Bugs

### F-03 (MEDIUM) — `codex` availability is required even for the `external` backend

- **Symptoms:** When a workspace is configured with `config.backend ===
  "external"` (a non-Codex second reviewer), the three review hooks still hard
  no-op if the `codex` CLI is not installed — they call `getCodexAvailability`
  unconditionally and bail when it returns unavailable. A user who deliberately
  uses *only* an external reviewer gets every automatic review silently
  skipped, with a misleading "install codex" note.
- **Files:** `scripts/auto-code-review-hook.mjs:116`,
  `scripts/auto-plan-review-hook.mjs:144`,
  `scripts/pre-push-review-hook.mjs:329`.
- **Trigger:** `config.backend === "external"` AND `codex` not on PATH.
- **Workaround:** Keep `codex` installed even when not used as the backend.
- **Fix approach:** Gate the `getCodexAvailability` precondition on the
  resolved backend — skip it (or replace it with the backend's own `probe()`)
  when `config.backend !== "exec-generic"`/`exec-review`. The manual `run` CLI
  already does this correctly (`codex-autoreview.mjs:475` —
  `!availability.available && config.backend !== "external"`), so the hooks are
  inconsistent with the CLI.

### F-04 (MEDIUM) — Dedupe is a read-then-insert race (TOCTOU)

- **Symptoms:** `dispatchBackgroundReview` checks for an equivalent in-flight
  review (`findDuplicateReview` over `listReviews`) and then, in a *separate*
  `upsertReview` call, inserts the new queued record. The check and the insert
  are not inside one `updateState` lock, so two hooks firing concurrently
  (e.g. a `Stop` review and a `pre-push` review of the identical change, or
  two rapid `Stop` events) can both pass the dedupe check before either
  inserts — producing two reviews of the same input and double-spending a
  Codex call. The dedupe is documented as the thing that prevents exactly
  this.
- **Files:** `scripts/lib/auto-review.mjs:240-251` (dedupe check),
  `:279-304` (the later `upsertReview` insert). The lock primitive itself
  (`state.mjs:withStateLock`) is correct — the bug is that dedupe-check and
  insert are two lock acquisitions, not one.
- **Trigger:** Concurrent dispatches with the same `kind` + `reviewedInputHash`
  + `backend` (the dedupe key).
- **Workaround:** None at runtime; the dedupe window narrows but does not close
  the race.
- **Fix approach:** Perform the duplicate check and the queued-record insert
  inside a single `updateState` critical section — e.g. an
  `insertReviewIfNoDuplicate(workspaceRoot, dedupeKey, recordFactory)` helper
  that does `findDuplicateReview` + `unshift` under one lock, returning the
  existing review when one is found.

### F-05 (MEDIUM) — Stale-lock break has no owner-PID liveness check

- **Symptoms:** `withStateLock` breaks a lock older than `LOCK_STALE_MS`
  (15 s) purely on the lock file's mtime, after confirming the content is
  unchanged. It never checks whether the PID recorded in the lock file
  (`<pid>:<token>`) is still alive. A legitimately slow-but-alive writer
  (heavy disk, a paused process, clock skew, a debugger) whose critical
  section exceeds 15 s has its lock forcibly broken while it is still inside
  it — two writers then run concurrently and one update can be lost. The
  ownership-token release logic prevents a *cross-delete*, but not the
  concurrent-write itself.
- **Files:** `scripts/lib/state.mjs:369-377` (the stale-break branch:
  `age > LOCK_STALE_MS` → `fs.rmSync(lockFile)`).
- **Trigger:** A state writer holding the lock longer than 15 s while still
  alive.
- **Workaround:** None; in practice the millisecond-scale critical section
  rarely exceeds 15 s, which is why it has not bitten — but it is unsound.
- **Fix approach:** Before breaking a stale lock, parse the PID from the lock
  file content and probe liveness with `process.kill(pid, 0)`. Only break the
  lock when the owner PID is dead (or unparseable). Keep the existing
  content-unchanged re-read as a second guard.

### F-06 (MEDIUM) — Diff fingerprint includes untracked file *paths* but not their *contents*

- **Symptoms:** `computeDiffFingerprint` folds untracked files into the
  fingerprint by PATH only — `git diff` does not cover untracked files and
  reading every untracked file is unbounded, so their content is excluded by
  design. The consequence: editing the *content* of an already-untracked file
  (without adding/removing a path) does not move the fingerprint. The dedupe
  (F-04) and the pre-run/post-run stale detection then treat the changed tree
  as identical — a review can be deduped away, or settled `STALE`, even though
  the actual change set differs.
- **Files:** `scripts/lib/git.mjs:113-119` (doc comment acknowledging the
  trade-off), `:162-173` (the fingerprint composition — `uniqueChangedFiles`
  contributes paths; `diffBody` is staged+unstaged diff only, no untracked
  content).
- **Trigger:** An iterative edit loop on a new (untracked) file — common when
  Claude is scaffolding a new module before the first `git add`.
- **Workaround:** `git add` the file so its content flows into the staged
  diff and the fingerprint moves.
- **Fix approach:** Hash untracked file *contents* into the fingerprint, with
  a per-file and total byte cap (e.g. skip/flag files over N KB, cap total
  bytes read) so the read stays bounded. Alternatively fold each untracked
  file's `size`+`mtime` into the fingerprint as a cheap content proxy.

---

## Tech Debt

### Reviewer backends shipped as documented stubs / scaffolds

- **Issue:** Three of the four reviewer backends are non-functional scaffolds.
  `app-server` returns a "not yet implemented — lands in Phase 4" failure from
  `probe`/`run`/`parse`. `exec-review` is labelled SCAFFOLD/non-default. The
  bounded-auto-feedback machinery in the worker (`reviewMode` =
  `soft-gate`/`bounded-feedback`, `maxFeedbackLoops`) is laid in but OFF — only
  `advisory` is wired.
- **Files:** `scripts/lib/reviewers/app-server.mjs:199-236`,
  `scripts/lib/reviewers/exec-review.mjs:2`,
  `scripts/review-worker.mjs:72-121` (`REVIEW_MODES`, `resolveReviewMode`,
  `resolveMaxFeedbackLoops`), `:376-380`, `:650-668`.
- **Impact:** A user who sets `config.backend` to a scaffold backend gets every
  review `failed` with a stub message. Dead-but-load-bearing-looking code
  (`reviewMode` is resolved, recorded, threaded through `settleTerminal`) is a
  maintenance hazard — a reader assumes it does something.
- **Fix approach:** Either complete the backends/feedback loop in their planned
  phases, or guard `config.backend` so the CLI/onboarding refuse to select a
  scaffold backend until it is real. Keep the scaffold code clearly fenced.

### `assembleReviewPromptCompat` carries a permanent dynamic-import fallback

- **Issue:** The worker assembles prompts via a dynamic-import + property-check
  shim (`assembleReviewPromptCompat`) that was meant to bridge "Wave C's
  `assembleReviewPrompt` not yet merged". `lib/prompts.mjs` now *does* export
  `assembleReviewPrompt`, so the pre-Wave-C `loadPromptTemplate` fallback
  branch is effectively dead, and the dynamic `import()` is slower and harder
  to reason about than a static import.
- **Files:** `scripts/review-worker.mjs:123-155` (`assembleReviewPromptCompat`),
  `scripts/lib/prompts.mjs` (now exports the real `assembleReviewPrompt`).
- **Impact:** Confusing seam; a static named import would be clearer and
  cheaper. The fallback masks the case where `assembleReviewPrompt` is missing.
- **Fix approach:** Replace the shim with a static `import { assembleReviewPrompt }`
  now that the symbol exists; delete the `loadPromptTemplate` fallback path.

### Legacy `request.prompt` tolerance code paths

- **Issue:** The worker carries `legacyPrompt = request.prompt` fallback logic
  for "an OLD queued record (or a test) may still carry a fully rendered
  prompt". The current dispatcher never writes `request.prompt`, so on a fresh
  install this path only ever fires for tests. It is dead surface for real
  records.
- **Files:** `scripts/review-worker.mjs:420-422`, `:520-538`.
- **Impact:** Extra branches that look load-bearing; tied to the now-resolved
  internal-audit Finding 1.
- **Fix approach:** Once no in-the-wild state files can carry `request.prompt`
  (the ring buffer caps at 20 and turns over quickly), drop the `legacyPrompt`
  paths and have tests exercise the real `planText`/`claudeResponseBlock`
  params instead.

### Documentation / build artifacts under a published plugin

- **Issue:** `docs/` is `.gitignore`d at the repo root, yet
  `plugins/codex-autoreview/docs/` contains tracked planning/audit/research
  documents (`AUDIT-FINDINGS.md`, `IMPLEMENTATION-PLAN.md`,
  `codex-autoreview-improvement-report-2026-05-14.md`, `research/*`). A
  published plugin ships internal planning docs to every install.
- **Files:** `.gitignore` (root, `docs/` rule), `plugins/codex-autoreview/docs/`.
- **Impact:** Minor — bloats the published package; internal audit notes are
  visible to all users.
- **Fix approach:** Decide whether plugin `docs/` should ship; if not, exclude
  it from the published package (npm `files` allowlist) or move planning docs
  out of the plugin subtree.

---

## Fragile Areas

### Per-workspace state file under concurrent multi-actor access

- **Files:** `scripts/lib/state.mjs` (whole module — `withStateLock`,
  `updateState`, `updateReviewIf`, `upsertReview`, `claimUnsurfacedCompletedReviews`,
  `reconcileAndPruneReviews`).
- **Why fragile:** The state file is written by *many* short-lived actors —
  every hook process (plan, code, pre-push, surface-verdict, session-end,
  onboarding), the detached worker, and the CLI — all racing on one JSON file.
  The locking is mostly correct (see the internal audit's concurrency review),
  but it is the single most concurrency-sensitive component, and two of the
  five open findings (F-04 dedupe TOCTOU, F-05 stale-lock liveness) live in or
  adjacent to it. The "proceed unlocked after a 30 s acquire timeout" last
  resort is a deliberate but real correctness hole.
- **Safe modification:** Any new state mutation MUST go through `updateState`
  (one load-mutate-save per lock) or `updateReviewIf` (compare-and-set). Never
  do a `listReviews` read followed by a separate `upsertReview` write and
  assume atomicity — that is exactly the F-04 shape. Add tests that spawn
  concurrent writers.
- **Test coverage:** Concurrency is tested (CAS, stale-break, atomic write),
  but the F-04 dedupe race and the F-05 live-but-slow-owner case are not
  covered — add tests for both.

### Detached worker lifecycle and the terminal-state guarantee

- **Files:** `scripts/review-worker.mjs` (`settleTerminal`,
  `installSignalHandlers`, the `.finally()` backstop),
  `scripts/lib/state.mjs` (`healStuckReviews`, `reconcileAndPruneReviews`,
  `isReviewLikelyStuck`, `staleBoundForReview`).
- **Why fragile:** The "a review is never stuck in `running`" guarantee
  depends on a web of cooperating mechanisms: the worker's signal handlers,
  the `.finally()` backstop, the `SessionEnd` cleanup hook, and the
  opportunistic `healStuckReviews` sweep on every dispatch. An uncatchable
  `SIGKILL` on the worker bypasses its handlers entirely — recovery then
  relies wholly on the staleness sweep, whose bound is timeout-derived and
  generous (10 min floor). A change to any one mechanism can silently break
  the guarantee.
- **Safe modification:** Treat `settleTerminal`'s compare-and-set
  (`!isTerminalStatus` predicate) as load-bearing — never add an exit path
  that writes a terminal state outside it. Keep every new worker exit path
  funnelling through `settleTerminal`.
- **Test coverage:** Good for catchable signals and timeout; the SIGKILL path
  is exercised by a test that itself leaks (see below).

### `git push` detection in the pre-push hook

- **Files:** `scripts/pre-push-review-hook.mjs:76-275` (`tokenizeSimpleCommand`,
  `splitSimpleCommands`, `commandContainsGitPush`).
- **Why fragile:** A hand-rolled shell tokenizer/command-splitter is used to
  decide whether a `Bash` tool call contains a real `git push`. Shell quoting,
  escaping, env-assignment prefixes, `env` prefixes, git global options, and
  `--dry-run` detection are all reimplemented. Edge cases (process
  substitution, here-docs, `$(...)`, aliases, `xargs git push`) can produce
  false negatives (a push not reviewed) or false positives (a wasted review).
- **Safe modification:** Add a test case for any new shell construct before
  touching the tokenizer. The hook is advisory and non-blocking, so a miss
  degrades gracefully — but the detector is the kind of code that accretes
  edge cases.
- **Test coverage:** `commandContainsGitPush` is exported specifically for
  testing; keep expanding the corpus.

---

## Test Coverage Gaps

### F-04 / F-05 race conditions are untested

- **What's not tested:** The dedupe read-then-insert race (F-04) and the
  live-but-slow lock-owner stale-break (F-05). Both are MEDIUM open findings;
  neither has a regression test.
- **Files:** `scripts/lib/auto-review.mjs:240-304`,
  `scripts/lib/state.mjs:352-390`.
- **Risk:** A fix could be made and silently regressed; the races only
  manifest under concurrency, which the current suite does not exercise for
  these paths.
- **Priority:** High — pair the tests with the F-04/F-05 fixes.

### `external` backend has the largest untested surface relative to size

- **What's not tested:** There is no dedicated `tests/reviewers/` suite.
  `scripts/lib/reviewers/external.mjs` is 836 lines (the largest non-test
  file after `state.mjs`) and is only exercised indirectly through the
  `phase2-*` suites. Placeholder substitution, the env allowlist, the detached
  spawn + timeout/kill path, and config validation deserve focused coverage —
  especially since this backend executes an arbitrary user CLI.
- **Files:** `scripts/lib/reviewers/external.mjs`,
  `scripts/lib/reviewers/exec-review.mjs`, `scripts/lib/reviewers/app-server.mjs`.
- **Risk:** A regression in the arbitrary-command spawn or env-allowlist logic
  (a security-sensitive surface) could pass the existing suite.
- **Priority:** Medium.

### Known test-hygiene process leak (FIXED — recorded for history)

- **What it was:** A test that `SIGKILL`'d the real worker orphaned the
  detached fake-`codex` process tree (SIGKILL bypasses the worker's reaping
  signal handlers). Two immortal `node -e setInterval` fixture processes were
  left behind per race-winning run.
- **Status:** FIXED in commit `2ea551f` (alongside the `--note` dispatch bug).
- **Files:** `tests/codex-autoreview.test.mjs` (the SIGKILL worker test and
  its cleanup).
- **Lesson for future tests:** Any test that deliberately `SIGKILL`s the
  worker must reap the codex/fixture process group itself; the file should
  keep an `after()` cleanup net so a future SIGKILL test cannot re-leak.

---

## Resolved (recorded for context — not open)

- **F-01 (command injection via unquoted `$ARGUMENTS` in command `.md`
  files):** FIXED in commit `8a69f70`.
- **Internal audit Finding 1 — `run --note` text silently discarded for code
  reviews:** FIXED in commit `2ea551f`. `handleRun` now passes the note
  through `claudeResponseBlock` (`codex-autoreview.mjs:514-527`), the param
  the worker actually reads.
- **Internal audit Finding 2 — SIGKILL'd-worker process-tree test leak:**
  FIXED in commit `2ea551f`.
- The internal audit also recorded three LOW findings (dead `maxAgeMs`
  age-prune branch in `reconcileAndPruneReviews`, the undocumented
  `surfacedSessionId` typedef gap, the misleading `?? (signal ? 1 : 0)`
  fallback in `finish()`). Re-verify these against the current tree; if any
  remain, they are LOW-priority cleanup, not behavioral bugs.

---

*Concerns audit: 2026-05-14*
