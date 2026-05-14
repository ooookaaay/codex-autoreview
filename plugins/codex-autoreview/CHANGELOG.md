# Changelog

## 0.3.1

Security & concurrency hardening — from a full Codex code review of the
codebase plus a defense-in-depth pass on the process-kill paths.

- **Command injection (HIGH)** — the `config` / `last` / `doctor` / `onboard`
  slash-command files interpolated raw `$ARGUMENTS` into a `!`-prefixed shell
  snippet. Restructured to the safe pattern: Claude reads the arguments and
  invokes the CLI via the Bash tool with explicit, validated arguments — no
  raw shell interpolation.
- **Arbitrary file read (HIGH)** — the plan-review hook trusted
  `tool_input.planFilePath` and read it directly. It is now validated — the
  resolved real path must stay inside the workspace, size-capped, symlink-safe
  — and the hook no-ops cleanly on a bad path.
- **External-backend gating** — the automatic hooks required the Codex CLI
  even when the project is configured with an `external` reviewer backend.
  They now only treat Codex as required for the backends that actually use it.
- **Dedup race** — review deduplication was a read-then-insert outside the
  state lock, so two hooks for the same input could both insert + spawn a
  worker. The duplicate check and the insert now run in one locked
  compare-and-set.
- **Stale-lock safety** — a stale state-lock is now broken only when its owner
  pid is verifiably dead (`process.kill(pid, 0)`), not on age alone — a slow
  live writer can no longer have its lock stolen.
- **Diff fingerprint** — the review anchor now folds in untracked file
  *contents* (bounded: 256 KiB/file, 200-file cap, binary-aware), not just
  their paths, so editing an untracked file is no longer missed by dedup and
  stale detection.
- **Kill-path safety** — every `process.kill(-pid)` site now rejects
  `pid <= 1`, making an accidental `kill(-1)` process-group broadcast
  structurally impossible.

Test suite: 233 → 235.

## 0.3.0

Verifier discipline, structured reviews, and a much richer surface — the
plugin is now ready for public distribution.

### Reviewer foundation

- **Pluggable reviewer backends.** Reviews now run through a single backend
  interface with three implementations: `exec-generic` (the default — today's
  `codex exec` behavior), `exec-review`, and `externalCommand` for plugging in
  a second, independent reviewer. A future GitHub-PR or app-server backend is
  drop-in.
- **Claim-based structured output.** Reviews emit a strict JSON schema —
  `verdict`, a `confidence` ladder (`PERFECT`→`FAILED`), decomposed `claims[]`,
  `findings[]`, `unverified[]` gaps, `reviewedInputHash`, and token/cost
  `usage`. The human-readable verdict is rendered from this JSON; everything
  downstream (surfacing, severity gating, the statusline, profiles) reads it.
- **Verifier prompt contract.** The reviewer is now a *verifier, not a
  builder*: a versioned, on-disk prompt contract (`prompts/_verifier-contract.md`)
  enforces atomic-claim decomposition, deterministic-evidence-only review, "the
  builder's final message is a claim, never evidence", required `unverified`
  gaps with a suggested oracle, and JSON-only output. No ad-hoc prompts in hook
  code — the reviewer's policy is reproducible and reviewable.
- **Token & cost capture.** `codex exec --json` usage events are parsed into
  `tokensIn`/`tokensOut`; a dated, override-able pricing table estimates the
  USD cost. An unknown model degrades to an honest "cost unknown", never a
  fake `$0`.
- **Codex-call hardening.** Every `codex exec` invocation runs read-only,
  ephemeral, with `approval_policy=never`, a minimal env allowlist, capped
  stdout/stderr, and a re-checked reasoning effort — privacy and anti-hang by
  construction.
- **Input anchoring.** Reviews are fingerprinted at dispatch (a plan hash, or a
  diff fingerprint over HEAD + changed files + diff). A review whose input no
  longer matches its anchor is marked `STALE` instead of reporting against a
  moved target.

### Review profiles & project config

- **Six review profiles.** `generic-code` (default for code), `plan-devils-advocate`
  (default for plans), `security-review`, `migration-review`, `ai-eval-review`,
  and `gsd-plan-review`. Each is a versioned file under `prompts/profiles/`
  that shares the verifier contract and customizes emphasis, evidence bar,
  finding bar, and output caps. Security gets the highest finding cap and
  "favor false positives over false negatives".
- **Project-local `.codex-autoreview.md`.** Drop a `.codex-autoreview.md` at a
  repository root to add project-specific reviewer instructions and a default
  profile. It is folded into the reviewer prompt; it refines the profile but
  never relaxes the verifier contract.

### Commands & triggers

- **`/codex-autoreview:doctor`** — self-diagnosis: is `codex` installed and
  logged in, is the config sane, are there stuck reviews, orphaned workers, or
  bloated logs, and is the pricing table stale.
- **`/codex-autoreview:run`** — on-demand review that spawns a real Claude
  Agent-tool subagent, so it shows up in Claude's native status with a timer.
- **`/codex-autoreview:onboard`** and a first-run `SessionStart` flow** — the
  plugin walks you through setup (codex installed/logged in → enable → model /
  effort → statusline → optional `.codex-autoreview.md`). Review hooks no-op
  until onboarding completes.
- **Pre-push gate.** A `PreToolUse`/`Bash` hook intercepts `git push` and can
  warn or block when a review found blockers.
- **`externalCommand` second reviewer.** Run a second, independent reviewer and
  compare verdicts.

### Surfacing & UX

- **Live statusline indicator.** While a review runs the statusline shows
  `codex-autoreview: ⏳ code review · 1m23s` (with `· pending:N` when reviews
  are backlogged); when idle it shows the latest verdict and confidence
  (`ISSUES · FEEDBACK`, `CLEAN · VERIFIED`), `pending:N` for queued-only work,
  or `FAILED · stale` for a stuck review. It still prints nothing when the
  per-project toggle is off.
- **Severity-gated surfacing.** Only the verdict, high/medium findings, and
  critical unverified gaps are injected into the session; the full report
  stays in `/codex-autoreview:last`. Failed and stuck reviews are surfaced too,
  not only completed ones.
- **Accept/reject memory.** A finding you dismissed is not re-surfaced by later
  reviews.
- **Review-gap feedback loop.** Unverified gaps accumulate so the plugin can
  suggest the test/oracle/harness improvement that would let the next review
  verify them.
- **Session digest** in `SessionEnd` (reviews run, findings, tokens, cost).
- **Privacy hardening.** The full prompt is no longer kept in state after
  dispatch; secret files (`.env`, keys) are denied to the reviewer; malformed
  hook input is a clean no-op.

### Foundations laid (off by default)

- **Bounded auto-feedback scaffold** — `reviewMode = advisory | soft-gate |
  bounded-feedback` and `maxFeedbackLoops`. The code path exists; the default
  is `advisory` and the gating modes are owner-enabled.

### Docs & metadata

- README rewritten as a complete setup manual: the separate `codex` CLI
  prerequisite, plugin install via `claude plugin marketplace add` + `install`,
  per-project enable/onboard, the optional statusline, update/uninstall, a
  troubleshooting table, and the privacy model (what is stored in state, that
  Codex reads repo files, exclude secrets).
- `.claude-plugin/marketplace.json` makes the repo a self-contained
  single-plugin marketplace (`source: "."`) — installable with one command.
- `plugin.json` gains public-distribution metadata (`repository`, `homepage`,
  `keywords`, `$schema`, `version` bumped to `0.3.0`). The statusline is
  registered through `settings.json`, not the manifest — Claude Code does not
  honor a `statusLine` key from a plugin manifest.

### Audit & hardening

- **Pre-publication code audit** — a full pass over `scripts/` resolved one
  HIGH and several minor findings: `/codex-autoreview:run --note` now actually
  threads its context into the review (it was silently dropped); dead code
  (`buildManualReviewPrompt`, the vestigial `maxAgeMs` prune path) removed; the
  `ReviewRecord` typedef and a misleading exit-status fallback corrected.
- **Leak-proof test fixtures** — the fake hanging-codex test fixtures now
  self-terminate the moment they are orphaned, so a `SIGKILL`-based test can
  never leave a stray process behind. Full suite: 233 tests, deterministic.

## 0.2.0

Resilience, speed, and session integration.

- **Fast by default.** The plugin now pins its OWN default reasoning effort
  (`medium`) instead of inheriting the user's global `~/.codex/config.toml`.
  A user who keeps their global default at `xhigh` no longer pays that cost on
  every automatic review. The model default is still left unset/inherited on
  purpose (a hardcoded model can be rejected by ChatGPT-auth accounts). Both
  remain overridable via `/codex-autoreview:config`.
- **Hang protection.** `codex exec` now runs under a hard, configurable
  wall-clock timeout (default 240s, set with `--timeout <ms>`). On timeout the
  whole codex process tree is killed and the review is marked `failed` — a hung
  Codex can never leave a review stuck in `running`.
- **Terminal-state guarantee.** Every failure path in the background worker
  (codex missing, crash, non-zero exit, kill, timeout, malformed output, state
  write error) — and the worker being SIGTERM/SIGINT-killed itself — now flushes
  a terminal state. Reviews are never abandoned in a non-terminal state.
- **Stale-job visibility.** `/codex-autoreview:last` flags a review stuck in
  `queued`/`running` far past a reasonable bound as `LIKELY STUCK` instead of
  implying it is healthily in progress.
- **Stuck-job self-healing.** A review left `running` by a `SIGKILL`'d / OOM-
  killed / crashed worker (the one path that bypasses the terminal-state
  guarantee) is now auto-reconciled to `failed` — both by the `SessionEnd` hook
  (for reviews from any session) and opportunistically on the next review
  dispatch — so a stuck review never lingers forever.
- **Auto-surfaced verdicts.** A new `UserPromptSubmit` hook injects any finished
  Codex verdict into the session context (once each), so Claude sees the
  findings inline and decides whether to act on them — no manual command needed.
- **Session cleanup.** A new `SessionEnd` hook kills this session's orphaned
  detached workers, reconciles its in-flight reviews to a terminal state, and
  prunes old review records/files. It never touches `~/.codex`.

## 0.1.0

Initial release.

- `PreToolUse` / `ExitPlanMode` hook: sends Claude's plan to Codex for a
  devil's-advocate review as a detached background job. Never blocks or denies
  plan-mode exit.
- `Stop` hook: sends working-tree code changes to Codex for a bug-finding
  review as a detached background job. Never blocks the Stop event.
- Per-project enable/disable toggle, persisted to plugin state.
- Configurable Codex model and reasoning effort; when unset, the user's own
  `~/.codex/config.toml` default is used (no hardcoded model).
- `codex-autoreview: ON (<model>, <effort>)` statusline marker.
- `/codex-autoreview:config` and `/codex-autoreview:last` slash commands.
- Graceful no-op when disabled, when nothing is reviewable, or when the
  `codex` CLI is absent.
- Shells out to `codex exec` rather than vendoring the `codex app-server`
  JSON-RPC client stack.
