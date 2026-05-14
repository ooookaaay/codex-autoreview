---
description: View or change codex-autoreview settings for this project — enable/disable, model, and reasoning effort
argument-hint: '[--enable|--disable] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" config $ARGUMENTS`

Present the full command output to the user.

Notes:
- `--enable` turns on the automatic plan and code reviews for this project. Both run as detached background Codex jobs and never block the main session.
- `--disable` turns them back off. When disabled, the hooks no-op cleanly.
- `--model <model>` sets the Codex model the reviews use (omit to keep the default).
- `--effort <none|minimal|low|medium|high|xhigh>` sets the Codex reasoning effort.
- With no arguments, this just reports the current settings and whether the `codex` CLI is available.
- If the output says the Codex CLI is not available, tell the user it must be installed separately with `npm install -g @openai/codex`.
- If review is enabled, suggest adding a `statusLine` entry running `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs"` so the `codex-autoreview: ON` marker shows. Do not overwrite an existing custom statusline; describe the change instead.
