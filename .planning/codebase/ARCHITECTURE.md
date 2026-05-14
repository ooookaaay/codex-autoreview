<!-- refreshed: 2026-05-14 -->
# Architecture

**Analysis Date:** 2026-05-14

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code session                          │
│  fires hook events: SessionStart / PreToolUse / Stop /               │
│  UserPromptSubmit / SessionEnd  ──  also runs slash commands         │
└───────┬───────────────┬──────────────┬─────────────┬────────────────┘
        │               │              │             │
        ▼               ▼              ▼             ▼
┌────────────────────────────────────────────────────────────────────┐
│  HOOK ENTRY POINTS  `plugins/codex-autoreview/scripts/*-hook.mjs`   │
│  onboarding-hook · auto-plan-review-hook · auto-code-review-hook ·  │
│  pre-push-review-hook · surface-verdict-hook · session-end-cleanup  │
│  — thin, non-blocking, exit fast; never call codex directly        │
└───────┬────────────────────────────────────────────┬───────────────┘
        │ dispatchBackgroundReview()                  │ read/claim state
        ▼                                             ▼
┌──────────────────────────────┐         ┌───────────────────────────┐
│  DISPATCH  `lib/auto-review` │         │  PER-PROJECT STATE        │
│  records queued review,      │────────▶│  `lib/state.mjs`          │
│  spawns detached worker,     │  upsert │  JSON file + O_EXCL lock  │
│  dedupes, self-heals         │◀────────│  ring buffer of reviews   │
└───────┬──────────────────────┘  read   └─────────▲─────────────────┘
        │ spawnDetached (own process group)         │ settleTerminal /
        ▼                                           │ updateReviewIf
┌────────────────────────────────────────────────┐  │
│  DETACHED WORKER  `scripts/review-worker.mjs`  │──┘
│  claim→running · redact payload · stale-check  │
│  · assemble prompt · probe→run→parse backend   │
│  · settleTerminal (always)                     │
└───────┬────────────────────────────────────────┘
        │ getReviewerBackend(id)
        ▼
┌────────────────────────────────────────────────────────────────────┐
│  REVIEWER BACKENDS  `lib/reviewers/*.mjs`  (probe / run / parse)    │
│  exec-generic (default) · exec-review · external · app-server      │
└───────┬────────────────────────────────────────────────────────────┘
        │ shell out (detached, hard timeout)
        ▼
┌────────────────────────────────────────────────────────────────────┐
│  EXTERNAL TOOL  —  `codex exec` (or a user-configured CLI)         │
└────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Hook entry points | Parse hook stdin JSON, gate on toggle/onboarding/codex-availability, dispatch a review or surface a verdict — never block the session | `plugins/codex-autoreview/scripts/auto-plan-review-hook.mjs`, `auto-code-review-hook.mjs`, `pre-push-review-hook.mjs`, `surface-verdict-hook.mjs`, `onboarding-hook.mjs`, `session-end-cleanup-hook.mjs` |
| Dispatcher | Record a `queued` review with metadata + redactable payload, dedupe, spawn the detached worker, attach worker pid | `plugins/codex-autoreview/scripts/lib/auto-review.mjs` |
| Background worker | Claim the review, redact payload, pre-run stale check, assemble prompt, drive the reviewer backend, write a terminal state exactly once | `plugins/codex-autoreview/scripts/review-worker.mjs` |
| State store | Per-project JSON state under an `O_EXCL` lock: config + review ring buffer + review-gap accumulator; atomic temp-file-rename writes; compare-and-set updates; self-heal of stuck reviews | `plugins/codex-autoreview/scripts/lib/state.mjs` |
| Reviewer backend registry | Map a `backend` id to a `{probe, run, parse}` object; resolve unknown ids to the non-breaking default | `plugins/codex-autoreview/scripts/lib/reviewers/index.mjs` |
| Reviewer backends | Concrete review engines: `exec-generic` (default codex path), `exec-review`, `external` (arbitrary CLI), `app-server` (stub) | `plugins/codex-autoreview/scripts/lib/reviewers/exec-generic.mjs`, `exec-review.mjs`, `external.mjs`, `app-server.mjs` |
| Codex integration | Build the hardened `codex exec` argv, run it detached under a hard timeout, parse the `--json` event stream, env-allowlist the child | `plugins/codex-autoreview/scripts/lib/codex.mjs` |
| Prompt assembly | Compose the reviewer prompt from the verifier contract + profile + project instructions + kind task block | `plugins/codex-autoreview/scripts/lib/prompts.mjs` |
| Review schema | Versioned claim-based result schema, tolerant parser/normalizer, compact-text + verdict-line renderers, finding fingerprints | `plugins/codex-autoreview/scripts/lib/review-schema.mjs` |
| Git anchoring | Working-tree inspection + the F4 anchoring primitives (`computeDiffFingerprint`, `computePlanHash`) for dedupe / stale detection | `plugins/codex-autoreview/scripts/lib/git.mjs` |
| CLI | Backs the slash commands: `config`, `last`, `run`, `onboard`, `doctor` | `plugins/codex-autoreview/scripts/codex-autoreview.mjs` |
| Diagnostics & statusline | Read-only health check; one-line statusline segment reflecting live review state | `plugins/codex-autoreview/scripts/doctor.mjs`, `statusline.mjs` |

## Pattern Overview

**Overall:** Event-driven, fire-and-forget background-job pipeline. Claude Code hook events trigger thin non-blocking hook scripts that dispatch detached worker processes; results flow back asynchronously through a lock-guarded per-project JSON state file and are surfaced into the session on the next user prompt.

**Key Characteristics:**
- **Never block the session.** Every hook exits fast (exit 0, no permission decision). The actual review runs in a detached process group that outlives the hook.
- **State is the only channel.** Hooks, the worker, the CLI, and the statusline never call each other — they communicate solely through the per-project JSON state file, serialized by an `O_EXCL` lock and atomic temp-file-rename writes.
- **Terminal-state guarantee.** A review record is never abandoned in `queued`/`running`: the worker funnels every exit path through `settleTerminal`, signal handlers settle on SIGTERM/SIGINT, and `SessionEnd` plus opportunistic `healStuckReviews` reconcile any orphan.
- **Pluggable reviewer abstraction.** The worker depends on a `{probe, run, parse}` backend interface, not on `codex` — `codex exec` is just the default backend.
- **Hermetic, privacy-first external calls.** `codex exec` runs with `--ignore-user-config --ignore-rules --ephemeral`, a minimal env allowlist, and `--sandbox read-only`.
- **Compare-and-set everywhere.** Concurrent hooks and the worker race on the same state; every conditional write (`updateReviewIf`) re-checks its predicate inside the lock so a settled review can never be resurrected.

## Layers

**Hook entry points:**
- Purpose: Translate a Claude Code hook event into a dispatch or a surfacing action; enforce the toggle / onboarding / codex-availability gates.
- Location: `plugins/codex-autoreview/scripts/*-hook.mjs`
- Contains: stdin-JSON parsing, gating logic, one call into `lib/`.
- Depends on: `lib/auto-review.mjs`, `lib/state.mjs`, `lib/codex.mjs`, `lib/git.mjs`, `lib/workspace.mjs`.
- Used by: Claude Code's hook runner (configured in `hooks/hooks.json`).

**Dispatch & worker orchestration:**
- Purpose: Turn a dispatch request into a detached background job and guarantee it reaches a terminal state.
- Location: `plugins/codex-autoreview/scripts/lib/auto-review.mjs`, `plugins/codex-autoreview/scripts/review-worker.mjs`
- Contains: dedupe keying, detached spawn, the worker lifecycle state machine.
- Depends on: `lib/state.mjs`, `lib/reviewers/`, `lib/codex.mjs`, `lib/git.mjs`, `lib/prompts.mjs`.
- Used by: every review hook and the CLI `run` subcommand.

**State & persistence:**
- Purpose: The single shared communication channel and source of truth.
- Location: `plugins/codex-autoreview/scripts/lib/state.mjs`
- Contains: the lock, atomic writes, the review ring buffer, config accessors, self-heal/reconcile/prune logic.
- Depends on: `lib/workspace.mjs` (and only Node core).
- Used by: everything.

**Reviewer backends:**
- Purpose: Concrete review engines behind a uniform `{probe, run, parse}` interface.
- Location: `plugins/codex-autoreview/scripts/lib/reviewers/`
- Contains: `index.mjs` (registry + typedefs), one file per backend, `exec-shared.mjs` (shared codex-exec helpers).
- Depends on: `lib/codex.mjs`, `lib/review-schema.mjs`, `lib/pricing.mjs`.
- Used by: the worker only.

**Support libraries:**
- Purpose: Cross-cutting primitives.
- Location: `plugins/codex-autoreview/scripts/lib/` (`codex.mjs`, `git.mjs`, `prompts.mjs`, `review-schema.mjs`, `pricing.mjs`, `process.mjs`, `workspace.mjs`, `comparison.mjs`).
- Used by: hooks, worker, backends, CLI.

**CLI & presentation:**
- Purpose: User-facing entry points — slash commands and the statusline.
- Location: `plugins/codex-autoreview/scripts/codex-autoreview.mjs`, `doctor.mjs`, `statusline.mjs`.
- Depends on: `lib/` (read-mostly).
- Used by: the markdown command definitions in `commands/`.

## Data Flow

### Primary Request Path — automatic code review (Stop hook)

1. Claude Code finishes a turn and fires the `Stop` event; the hook runner invokes the hook (`hooks/hooks.json:40-51`).
2. `auto-code-review-hook.mjs` reads stdin JSON, resolves the workspace root, and gates on `config.enabled`, `isOnboarded`, `getCodexAvailability`, and a dirty working tree (`auto-code-review-hook.mjs:87-132`).
3. It calls `dispatchBackgroundReview({ kind: "code", claudeResponseBlock, ... })` (`auto-code-review-hook.mjs:138-148`).
4. The dispatcher self-heals stuck reviews, resolves backend/model/effort/timeout, computes the F4 diff fingerprint, dedupes against the ring buffer, then `upsertReview` records a `queued` record carrying only metadata + the redactable runtime payload (`lib/auto-review.mjs:184-304`).
5. `spawnDetached` launches `review-worker.mjs --cwd <cwd> --review-id <id>` in its own process group; the dispatcher patches the worker `pid` via `updateReviewIf` and returns immediately (`lib/auto-review.mjs:311-332`).
6. The hook prints a one-line stderr note and exits 0 — the Claude turn was never blocked.
7. The detached worker claims the review `running` via compare-and-set, reads then strips the redactable payload, runs a pre-run stale check, assembles the prompt, and calls `backend.probe()` → `backend.run()` → `backend.parse()` (`review-worker.mjs:312-628`).
8. `backend.run()` (default `exec-generic`) shells out to `codex exec` detached under a hard wall-clock timeout (`lib/reviewers/exec-generic.mjs:66-92`, `lib/codex.mjs:553-696`).
9. The worker writes the terminal `completed`/`failed` state exactly once through `settleTerminal` (`review-worker.mjs:226-246`, `:659-669`).
10. On the user's next prompt the `UserPromptSubmit` hook (`surface-verdict-hook.mjs`) atomically claims unsurfaced completed/failed reviews, severity-gates them, and injects `hookSpecificOutput.additionalContext` back into the session (`surface-verdict-hook.mjs:431-505`).

### Plan review path (ExitPlanMode)

1. `PreToolUse`/`ExitPlanMode` fires `auto-plan-review-hook.mjs`; it extracts the plan text, skips trivially small plans, and dispatches `kind: "plan"` with the redactable `planText` (`auto-plan-review-hook.mjs:115-201`).
2. Same dispatch → worker → backend pipeline; the anchor is `computePlanHash(planText)` instead of a diff fingerprint.

### Pre-push review path

1. `PreToolUse`/`Bash` fires `pre-push-review-hook.mjs`; a shell-aware tokenizer (`commandContainsGitPush`) fast-paths every non-`git push` Bash call (`pre-push-review-hook.mjs:212-275`).
2. On a detected push it dispatches the same `kind: "code"` review through `dispatchBackgroundReview`, reusing the dedupe so a push right after a Stop review does not double-spend a codex call.

### Session-end cleanup path

1. `SessionEnd` fires `session-end-cleanup-hook.mjs`: it kills this session's detached workers (verifying each pid is genuinely a `review-worker.mjs` for that review id), `reconcileAndPruneReviews` settles in-flight reviews to `failed` and prunes terminal records, stale log/output files are removed, and a one-shot session digest is logged to stderr (`session-end-cleanup-hook.mjs:374-439`).

**State Management:**
- All durable state lives in one per-project JSON file resolved by `resolveStateDir` — under `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/` when Claude Code provides it, else `os.tmpdir()/codex-autoreview/<slug>-<hash>/` (`lib/state.mjs:255-273`).
- Every read-modify-write goes through `withStateLock` (an `O_EXCL` lock file with an ownership token, stale-lock breaking, and a 30s acquire timeout) and `saveState` (write-temp-then-rename atomicity) (`lib/state.mjs:329-408`, `:547-574`).
- The review buffer is a ring buffer capped at `MAX_REVIEWS = 20` terminal records; non-terminal reviews are never pruned (their worker still needs the record).
- No in-memory shared state — every process re-reads the file.

## Key Abstractions

**ReviewerBackend (`{id, capabilities, probe, run, parse}`):**
- Purpose: Decouple the worker from any specific review engine.
- Examples: `lib/reviewers/exec-generic.mjs`, `exec-review.mjs`, `external.mjs`, `app-server.mjs`; typedefs and the registry in `lib/reviewers/index.mjs`.
- Pattern: Plain frozen object literal registered in a frozen `REGISTRY`; `getReviewerBackend` resolves an unknown id to `DEFAULT_BACKEND_ID` (`exec-generic`) so old state records stay valid.

**ReviewRecord + ring buffer:**
- Purpose: One review's full lifecycle, persisted.
- Examples: the `@typedef ReviewRecord` and ring-buffer helpers in `lib/state.mjs:175-205`, `upsertReview`/`updateReviewIf`/`pruneReviews`.
- Pattern: Append-to-front ring buffer; status is one of `queued|running|completed|failed`; `completed`/`failed` are terminal and immutable.

**ParsedReview / ReviewResult:**
- Purpose: The uniform structured output every backend produces and the worker persists.
- Examples: `lib/review-schema.mjs` (versioned schema, `normalizeReviewResult`, `fromVerdictLine`, `renderCompactText`, `renderVerdictLine`, `computeFindingFingerprint`).
- Pattern: The model emits claim-based JSON; the worker merges real token usage; `verdict`/`output` are always *rendered from* `result`, never hand-rolled.

**Anchoring fingerprint (F4):**
- Purpose: A stable hash of "what is being reviewed right now" for dedupe and stale detection.
- Examples: `computeDiffFingerprint` / `computePlanHash` in `lib/git.mjs`; canonical `sha256-<hex>` form.
- Pattern: Captured at dispatch (`request.reviewedInputHash`), recomputed pre-run and post-run by the worker; a mismatch settles the review `STALE`.

**Assembled reviewer prompt:**
- Purpose: A reproducible, versioned reviewer policy.
- Examples: `assembleReviewPrompt` in `lib/prompts.mjs` composes `prompts/_verifier-contract.md` + `prompts/profiles/<profile>.md` + optional repo `.codex-autoreview.md` + `prompts/auto-<kind>-review.md`.
- Pattern: Assembly leaves `{{PLAN_BLOCK}}` / `{{CLAUDE_RESPONSE_BLOCK}}` / `{{REVIEWED_INPUT_HASH}}` placeholders intact; the worker interpolates the runtime payload after assembly.

## Entry Points

**Claude Code hooks (`hooks/hooks.json`):**
- Location: `plugins/codex-autoreview/hooks/hooks.json`, each entry running `node ${CLAUDE_PLUGIN_ROOT}/scripts/<hook>.mjs`.
- Triggers: `SessionStart` → `onboarding-hook.mjs`; `PreToolUse`/`ExitPlanMode` → `auto-plan-review-hook.mjs`; `PreToolUse`/`Bash` → `pre-push-review-hook.mjs`; `Stop` → `auto-code-review-hook.mjs`; `UserPromptSubmit` → `surface-verdict-hook.mjs`; `SessionEnd` → `session-end-cleanup-hook.mjs`.
- Responsibilities: Gate, dispatch or surface, exit fast.

**Detached worker (`review-worker.mjs`):**
- Location: `plugins/codex-autoreview/scripts/review-worker.mjs`, spawned by `lib/auto-review.mjs` with `--cwd` / `--review-id`.
- Triggers: `spawnDetached` from the dispatcher.
- Responsibilities: Own the review lifecycle and the terminal-state guarantee.

**CLI (`codex-autoreview.mjs`):**
- Location: `plugins/codex-autoreview/scripts/codex-autoreview.mjs`, invoked by the markdown commands in `commands/` (`config.md`, `last.md`, `run.md`, `onboard.md`, `doctor.md`).
- Triggers: User slash commands.
- Responsibilities: `config` / `last` / `run` / `onboard` / `doctor` subcommands; `run` dispatches then polls to completion.

**Statusline (`statusline.mjs`):**
- Location: `plugins/codex-autoreview/scripts/statusline.mjs`, added by the user to `settings.json` `statusLine`.
- Triggers: Claude Code statusline refresh.
- Responsibilities: Print one short live-state line, nothing when the toggle is off.

**Marketplace / plugin manifests:**
- Location: `.claude-plugin/marketplace.json` (repo root) points at `./plugins/codex-autoreview`; `plugins/codex-autoreview/.claude-plugin/plugin.json` is the plugin manifest.

## Architectural Constraints

- **Threading:** Single-threaded Node per process. Concurrency is *across processes* (multiple hook invocations + the detached worker), not within one — there are no worker threads. Cross-process safety is the `O_EXCL` state lock plus compare-and-set writes.
- **Process groups:** The worker and every reviewer child are spawned `detached` so each leads its own process group; cleanup signals `-pid` to reap the whole tree (`lib/codex.mjs:499-513`, `session-end-cleanup-hook.mjs:177-184`).
- **Global state:** No module-level mutable singletons except `review-worker.mjs`'s `terminalState` object, which is intentional per-process bookkeeping for the "settle exactly once" guarantee. All durable state is the on-disk JSON file.
- **No `~/.codex` writes:** The plugin only ever touches its own per-project state directory; the user's Codex config/auth/history is explicitly out of scope, and `codex exec` runs `--ephemeral` so it persists nothing.
- **Circular imports:** None observed. `lib/workspace.mjs` imports `lib/git.mjs`; the rest of `lib/` fans out from `state.mjs` / `codex.mjs` without cycles.
- **`additionalContext` cap:** The platform caps injected context at 10,000 chars; `surface-verdict-hook.mjs` self-limits to 8,000 with truncation + a pointer to `/codex-autoreview:last`.
- **No hardcoded model:** A model is never pinned (a ChatGPT-auth account may reject it); the plugin re-supplies only the user's own top-level `~/.codex/config.toml` `model` when no override is set (`lib/codex.mjs:120-174`).

## Anti-Patterns

### Calling `codex` (or any reviewer) from a hook

**What happens:** A hook shells out to `codex exec` directly and waits for the verdict.
**Why it's wrong:** A review takes minutes; doing it inline blocks the Claude session, defeating the plugin's core "never block" contract, and bypasses dedupe, the terminal-state guarantee, and backend pluggability.
**Do this instead:** Hooks only ever call `dispatchBackgroundReview` (`lib/auto-review.mjs`); the detached worker is the only place a reviewer backend runs.

### Persisting a fully rendered prompt in state

**What happens:** The dispatcher renders the whole reviewer prompt and stores it on the `queued` record.
**Why it's wrong:** Sensitive plan/code text then lingers in the on-disk state file indefinitely.
**Do this instead:** The dispatcher persists only metadata + the minimal redactable runtime payload (`planText` / `claudeResponseBlock`); the worker assembles the prompt itself and strips the payload from state as soon as it has read it (`review-worker.mjs:410-447`).

### Unconditional `upsertReview` to advance status

**What happens:** Code overwrites a review's status without checking the current value.
**Why it's wrong:** A hook and the worker race; an unconditional write can resurrect a `completed`/`failed` review or roll back a status the worker already advanced.
**Do this instead:** Use `updateReviewIf` with a predicate (e.g. `!isTerminalStatus`) — the predicate test and the write run inside one locked critical section (`lib/state.mjs:683-702`).

### Dropping a non-terminal review when pruning

**What happens:** Ring-buffer pruning treats all reviews uniformly and trims a `queued`/`running` record.
**Why it's wrong:** Its detached worker still expects to find that record; if it vanishes the worker exits without writing a terminal state and the verdict is lost.
**Do this instead:** `pruneReviews` / `reconcileAndPruneReviews` only ever cap *terminal* reviews; non-terminal records are always kept (`lib/state.mjs:506-530`, `:911-946`).

### Killing a pid from state without verifying it

**What happens:** Cleanup signals a recorded `review.pid` directly.
**Why it's wrong:** The pid may have been reused by an unrelated process since the record was written.
**Do this instead:** `looksLikeReviewWorker` confirms the live command line contains both `review-worker.mjs` and the review id before signalling; an unverifiable pid is skipped, not guessed (`session-end-cleanup-hook.mjs:113-191`).

### Treating a non-zero exit as "no verdict" (or all-zero usage as `$0`)

**What happens:** A backend decides success/failure from the child exit code, or reports a zero-token run as costing `$0`.
**Why it's wrong:** `codex exec`'s authoritative output is the `--output-last-message` file, not the exit code; and all-zeros usage (the `exec-review` subcommand) means "unavailable", not "free".
**Do this instead:** Use the trimmed output-file content as the verdict signal; normalize all-zeros usage to `null` so cost is honestly "unknown" (`lib/reviewers/exec-shared.mjs:31-116`, `lib/codex.mjs:799-816`).

## Error Handling

**Strategy:** Defensive and non-throwing at every boundary. Hooks, the worker's exit paths, backend `probe`/`run`/`parse`, and the state writers all degrade gracefully rather than crash — a failure becomes a logged note or a `failed` review record, never a thrown exception that disrupts the Claude session.

**Patterns:**
- Every hook wraps `main()` in `try/catch`, writes the error to stderr, and exits 0 (or sets a non-zero `exitCode` only where it cannot affect the session).
- Malformed/empty/missing hook stdin → a clean no-op (`readHookInput` returns `null`/`{}`).
- The worker's `settleTerminal` is a compare-and-set called from normal completion, every error branch, the SIGTERM/SIGINT handlers, and a top-level `finally` backstop — a review can never be left in `running`.
- Backend `run` never throws: a spawn failure resolves `{error}`, a timeout resolves `{timedOut: true}`; the worker still wraps the call in `try/catch` as belt-and-braces.
- State writes are atomic (temp-file + rename); a write failure cleans up the temp file and rethrows to the (already guarded) caller.
- `codex exec` hangs are bounded by a hard wall-clock timeout with SIGTERM→SIGKILL escalation across the process group.
- An unknown model / stale pricing table / unknown backend id is a soft, labelled degradation — never a hard failure.

## Cross-Cutting Concerns

**Logging:** Per-review append-only log files in the reviews dir (`<reviewId>.log`), written best-effort by the worker's `appendLog`. Hooks and the CLI write human-readable notes to stderr. There is no logging framework — Node `fs.appendFileSync` and `process.stderr.write`.

**Validation:** Hook stdin is parsed defensively. The CLI `config` subcommand validates every flag (backend id against `BACKEND_IDS`, profile against `REVIEW_PROFILES`, `externalCommand` config via `validateExternalConfig`, pricing via `normalizeRateOverride`, effort/timeout via `lib/codex.mjs` normalizers). `review-schema.mjs` tolerantly normalizes model output. `/doctor` is a read-only validator.

**Authentication:** None of the plugin's own. It relies on the user's existing `codex` login (`~/.codex/auth.json` / `CODEX_HOME`); `/doctor` does a best-effort logged-in check. Secrets never reach a reviewer child — `buildCodexChildEnv` copies only a fixed `CODEX_ENV_ALLOWLIST`, and the `external` backend uses an explicit per-config env allowlist.

**Concurrency control:** The `O_EXCL` per-workspace state lock (`withStateLock`) plus compare-and-set writes (`updateReviewIf`, `claimUnsurfacedCompletedReviews`) are the single mechanism that makes concurrent hooks and the detached worker safe.

**Onboarding gate:** Until `config.onboardedAt` is set, the review hooks no-op and `onboarding-hook.mjs` injects setup context (full walkthrough on `startup`, terse checklist on `clear`, one-liner on `resume`/`compact`).

---

*Architecture analysis: 2026-05-14*
