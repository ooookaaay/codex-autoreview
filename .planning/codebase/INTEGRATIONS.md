# External Integrations

**Analysis Date:** 2026-05-14

## APIs & External Services

**Codex CLI (the primary integration):**
- The `codex` CLI binary — invoked as a child process, never as a library/SDK. This is the core of the plugin: it shells out to `codex exec` to run verifier-style reviews of plans and code.
  - Integration module: `plugins/codex-autoreview/scripts/lib/codex.mjs` — ALL Codex coupling is isolated here.
  - Invocation: `spawn("codex", args, { detached: true, ... })` in `runCodexReview`. Args built by `buildCodexExecArgs` — `codex exec [--model M] [-c model_reasoning_effort=E] --cd <cwd> --sandbox read-only --skip-git-repo-check --color never --ephemeral --ignore-user-config --ignore-rules -c approval_policy="never" -c shell_environment_policy.inherit="none" -c history.persistence="none" [--json] [--output-schema F] --output-last-message <file>`.
  - The review prompt is fed on stdin; the authoritative verdict is the `--output-last-message` file. `codex exec --json` emits a JSONL event stream parsed by `parseCodexJsonStream` for token usage (`turn.completed.usage`) and the final agent message.
  - Availability probe: `getCodexAvailability` → time-boxed `codex --version` (`scripts/lib/process.mjs`, `binaryAvailable`).
  - Validated against `codex-cli 0.130.0` per in-code comments.
  - Auth: handled entirely by the user's own `codex` login (ChatGPT-auth or API key) under `~/.codex` / `$CODEX_HOME`. The plugin holds NO Codex credentials and passes NO API key — it only ensures `CODEX_HOME` reaches the child so `codex` can find its own auth.

**Pluggable reviewer backends:**
- A 4-function registry abstraction (`probe`/`run`/`parse` + capabilities) in `plugins/codex-autoreview/scripts/lib/reviewers/index.mjs`. The detached worker looks up `request.backend` and never calls codex directly. Registered backends:
  - `exec-generic` (`reviewers/exec-generic.mjs`) — DEFAULT. Generic `codex exec` + optional `--output-schema`/`--json`. Full claim-based structured output and real token usage. A queued record with no `backend` field resolves here (non-breaking migration default).
  - `exec-review` (`reviewers/exec-review.mjs`) — uses the `codex exec review` subcommand (`--uncommitted` / `--base <ref>`). Prose-only output (regex-parsed `[P1]/[P2]/[P3]` findings), zero usage → DEGRADED structured result. Different flag set from `codex exec` (`buildCodexExecReviewArgs`).
  - `external` (`reviewers/external.mjs`) — runs an ARBITRARY user-configured CLI as a second reviewer (e.g. `claude -p`, `gemini`). Driven by an `externalCommand` config object: `{command, args[], promptDelivery: stdin|file|arg, outputCapture: stdout|file, outputFormat: json|text, resultPath, timeoutMs, env[]}`. Placeholders `{prompt}`/`{promptFile}`/`{outputFile}`/`{cwd}`/`{kind}`/`{base}` substituted into argv and exported as `CODEX_AUTOREVIEW_*` env vars. Three-tier output handling (native JSON envelope → raw text → prompt-enforced verdict line).
  - `app-server` (`reviewers/app-server.mjs`) — DOCUMENTED STUB (Phase 4). Will talk to `codex app-server` over JSON-RPC 2.0 / stdio (`initialize` → `thread/start` → `review/start {delivery:"detached"}`, consuming `exitedReviewMode` events). Request builders are the real wire shapes; `probe`/`run` currently report "not yet wired".

## Data Storage

**Databases:**
- None. No database, no ORM, no external datastore.

**File Storage:**
- Local filesystem only. Per-workspace JSON state file (`state.json`, schema v2) plus a `reviews/` dir of per-review log/output artifacts, under `<CLAUDE_PLUGIN_DATA>/state/<slug>-<hash>/` or, when that env var is unset, `<os.tmpdir()>/codex-autoreview/<slug>-<hash>/`. Path resolution: `scripts/lib/state.mjs` (`resolveStateDir`, `resolveReviewsDir`).
- Writes are atomic (temp file + `rename`) and serialized by an `O_EXCL` lock file (`state.json.lock`) with stale-lock breaking — `withStateLock` in `scripts/lib/state.mjs`.
- The external reviewer backend uses a per-run `0700` temp dir (`fs.mkdtempSync`) for prompt/output files, cleaned up in a `finally` block.

**Caching:**
- None at the plugin level. (Codex's own `cached_input_tokens` are read from its usage event for cost estimation, but the plugin caches nothing itself.)

## Authentication & Identity

**Auth Provider:**
- Delegated entirely to the `codex` CLI's own login under `~/.codex` / `$CODEX_HOME`. The plugin never authenticates, never stores tokens, and never sees the user's Codex credentials.
- `/codex-autoreview:doctor` performs a best-effort, read-only check for `~/.codex/auth.json` to tell the user whether `codex` appears logged in (`scripts/doctor.mjs`).
- For the `external` backend, any auth is the user's responsibility; the backend forwards only an explicitly-configured env-var allowlist (`env[]` in `externalCommand`) to the child tool.

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry/Datadog/etc. Errors are surfaced inline: failed reviews become a `failed` review record with an `errorMessage`, and `/codex-autoreview:doctor` reports environment/config problems.

**Logs:**
- Per-review log files in the workspace `reviews/` dir (`resolveReviewLogFile` in `scripts/lib/state.mjs`). `codex exec` stdout/stderr captures are bounded to `MAX_CAPTURE_BYTES` (256 KB, tail kept) to prevent runaway-transcript memory growth. No remote log shipping.

## CI/CD & Deployment

**Hosting:**
- Not applicable — the plugin runs locally inside Claude Code. Distributed via a single-plugin Claude Code marketplace (`.claude-plugin/marketplace.json`).

**CI Pipeline:**
- None detected. No `.github/workflows/`, no CI config files in the repo. Tests are run locally via `npm test` (`node --test tests/*.test.mjs`). A `pre-push-review-hook.mjs` exists but it dispatches a Codex review of about-to-push changes — it is a plugin feature, not a CI pipeline.

## Environment Configuration

**Required env vars:**
- `CLAUDE_PLUGIN_ROOT` — injected by Claude Code; required for hooks to locate plugin scripts.

**Optional env vars:**
- `CLAUDE_PLUGIN_DATA` — relocates per-workspace state out of the tmpdir fallback.
- `CODEX_HOME` — overrides the `~/.codex` location for the `codex` child.
- `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (and lowercase variants) — passed through to the `codex` child via `CODEX_ENV_ALLOWLIST` for corporate networks.

**Secrets location:**
- The plugin stores NO secrets. `.env` / `.env.*` are gitignored AND never read by the plugin (its own stated threat model). The `codex` child receives only an allowlisted env subset (`buildCodexChildEnv`, `CODEX_ENV_ALLOWLIST` in `scripts/lib/codex.mjs`) — API keys, cloud creds, and the user's wider shell env are dropped entirely.

## Webhooks & Callbacks

**Incoming:**
- None.

**Outgoing:**
- None. No HTTP calls originate from the plugin itself. All "outbound" interaction is local child-process spawning of `codex` (or a user-configured external reviewer). Any network traffic is made by `codex` itself, not the plugin.

## Claude Code Hook Integration

The plugin integrates with the Claude Code session lifecycle via `plugins/codex-autoreview/hooks/hooks.json` (exec-form commands, `${CLAUDE_PLUGIN_ROOT}` passed as a literal arg):
- `SessionStart` → `scripts/onboarding-hook.mjs` — injects guided-onboarding context until the workspace is set up.
- `PreToolUse` matcher `ExitPlanMode` → `scripts/auto-plan-review-hook.mjs` — dispatches a detached devil's-advocate plan review.
- `PreToolUse` matcher `Bash` → `scripts/pre-push-review-hook.mjs` — on a detected `git push`, dispatches a code review of the about-to-push changes.
- `Stop` → `scripts/auto-code-review-hook.mjs` — dispatches a detached bug-finding code review.
- `UserPromptSubmit` → `scripts/surface-verdict-hook.mjs` — injects finished verdicts back into the session context.
- `SessionEnd` → `scripts/session-end-cleanup-hook.mjs` — reconciles in-flight reviews and cleans up the plugin's own workers/transient files.

All review work is dispatched as detached background worker processes (`scripts/review-worker.mjs`) so it never blocks the session.

---

*Integration audit: 2026-05-14*
