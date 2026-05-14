---
description: View or change codex-autoreview settings for this project — enable/disable, model, reasoning effort, and the per-review timeout
argument-hint: '[--enable|--disable] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [--timeout <ms>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" config $ARGUMENTS`

Present the full command output to the user.

Notes:
- `--enable` turns on the automatic plan and code reviews for this project. Both run as detached background Codex jobs and never block the main session.
- `--disable` turns them back off. When disabled, the hooks no-op cleanly.
- `--model <model>` sets the Codex model the reviews use. Default: unset — the model is inherited from the user's `~/.codex/config.toml` (a hardcoded model can be rejected by ChatGPT-auth accounts). Pass `--model ""` to clear an override.
- `--effort <none|minimal|low|medium|high|xhigh>` sets the Codex reasoning effort. Default: **`medium`** — this is the plugin's OWN default and is deliberately NOT inherited from `~/.codex/config.toml`, so a slow global default (e.g. `xhigh`) does not make every automatic review slow. Pass `--effort ""` to clear an override back to `medium`.
- `--timeout <ms>` sets a hard per-review wall-clock timeout for `codex exec`. Default: **240000 ms (240s)**. On timeout the codex process tree is killed and the review is marked failed. Accepted range 10000–1800000 ms. Pass `--timeout ""` to clear an override.
- With no arguments, this just reports the current settings (including whether each value is a default or an override) and whether the `codex` CLI is available.
- If the output says the Codex CLI is not available, tell the user it must be installed separately with `npm install -g @openai/codex`.
- If review is enabled, suggest adding a `statusLine` entry running `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs"` so the `codex-autoreview: ON` marker shows. Do not overwrite an existing custom statusline; describe the change instead.
