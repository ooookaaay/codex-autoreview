# Changelog

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
