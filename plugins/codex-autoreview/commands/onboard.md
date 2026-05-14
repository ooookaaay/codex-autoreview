---
description: Run (or re-run) the guided codex-autoreview onboarding for this project — walks through Codex setup, enabling review, model/effort, statusline, and the optional second reviewer
argument-hint: '[--complete]'
allowed-tools: Bash(node:*)
---

The user invoked `/codex-autoreview:onboard`. Guide them through onboarding this project.

Arguments received: `$ARGUMENTS`

First, read the current onboarding state and checklist by running the command
yourself with the **Bash tool**. The only valid argument is an optional
`--complete` flag — never splice the raw `$ARGUMENTS` string into the command
line.

Invoke:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" onboard [--complete]`

If the user passed `--complete`, append exactly that one literal flag as a
separate explicit argument. Otherwise run `onboard` with no extra argument.

Then walk the user through any checklist item that is not yet done (`[ ]`). The required steps are the first two; the rest are optional but worth offering:

1. **Codex CLI installed & logged in.** If the checklist shows it is not available, tell the user to install it (`npm install -g @openai/codex`) and log in (`codex login`). The plugin needs a working `codex` CLI — without it the review hooks no-op.

2. **Enable automatic review for this project.** If review is OFF, offer to run `/codex-autoreview:config --enable`. Until the project is enabled AND onboarded, the automatic `ExitPlanMode` plan review and `Stop` code review do nothing.

3. **Model / reasoning effort (optional).** Ask whether the user wants a specific Codex model or a non-default reasoning effort. Defaults: model inherited from `~/.codex/config.toml`, effort `medium`. Adjust with `/codex-autoreview:config --model <m> --effort <e>` if they want.

4. **Statusline marker (optional).** Suggest adding a `statusLine` entry running `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs"` so the `codex-autoreview: ON` marker and live review progress show in the status line. Do not overwrite an existing custom statusline — describe the change and let the user add it as a segment.

5. **Reviewer backend / second reviewer (optional).** Mention that a second reviewer (e.g. `claude` or `gemini`) can be configured with `/codex-autoreview:config --backend external --backend-config '<json>'`, and that a review profile/persona can be set with `--profile <id>`. Most users can skip this.

Once the required steps are done (Codex installed + logged in, review enabled), finish onboarding by running:

When the user confirms setup is complete, run `/codex-autoreview:onboard --complete` — which invokes `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" onboard --complete` via the Bash tool.

When you run `onboard --complete`, the project is marked onboarded and the automatic review hooks become active. Onboarding is sticky — re-running this command just re-walks the checklist; it never un-onboards the project.

Notes:
- If `$ARGUMENTS` already contains `--complete`, the command above has already marked the project onboarded — confirm that to the user and summarize the final state from the output.
- This is the manual re-entry point. The `SessionStart` onboarding hook triggers the same flow automatically on a project that has never been onboarded.
