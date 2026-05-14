# Changelog

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
