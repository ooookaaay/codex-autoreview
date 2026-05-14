---
description: View or change codex-autoreview settings for this project — enable/disable, model, reasoning effort, per-review timeout, reviewer backend, second reviewer, review profile, and pricing overrides
argument-hint: '[--enable|--disable] [--model <model>] [--effort <low|medium|high|xhigh>] [--timeout <ms>] [--backend <id>] [--profile <id>]'
allowed-tools: Bash(node:*)
---

The user invoked `/codex-autoreview:config`.

Arguments received: `$ARGUMENTS`

Run the config command yourself with the **Bash tool**. Parse the arguments
above into discrete, validated flags and pass each one as a separate explicit
argument — never splice the raw `$ARGUMENTS` string into the command line.

Invoke:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" config <parsed flags…>`

For example, if the user passed `--enable --effort high`, run the CLI with the
two separate arguments `--enable` and `--effort` `high`. With no arguments, run
`config` with no extra arguments. Reject anything that is not a recognized flag
from the `argument-hint` rather than passing it through.

Present the full command output to the user.

Notes:
- `--enable` turns on the automatic plan and code reviews for this project. Both run as detached background Codex jobs and never block the main session.
- `--disable` turns them back off. When disabled, the hooks no-op cleanly.
- `--model <model>` sets the Codex model the reviews use. Default: unset — the model is inherited from the user's `~/.codex/config.toml` (a hardcoded model can be rejected by ChatGPT-auth accounts). Pass `--model ""` to clear an override.
- `--effort <low|medium|high|xhigh>` sets the Codex reasoning effort. Default: **`medium`** — this is the plugin's OWN default and is deliberately NOT inherited from `~/.codex/config.toml`, so a slow global default (e.g. `xhigh`) does not make every automatic review slow. Pass `--effort ""` to clear an override back to `medium`.
- `--timeout <ms>` sets a hard per-review wall-clock timeout for `codex exec`. Default: **240000 ms (240s)**. On timeout the codex process tree is killed and the review is marked failed. Accepted range 10000–1800000 ms. Pass `--timeout ""` to clear an override.
- `--backend <id>` selects the reviewer backend: `exec-generic` (default — generic `codex exec`, full claim-based output + real token counts), `exec-review` (the `codex exec review` subcommand — well-scoped but prose-only, no token counts), `external` (an arbitrary user CLI as a second reviewer — see `--backend-config`), or `app-server` (a Phase 4 stub, not yet runnable). Pass `--backend ""` to reset to the default.
- `--backend-config '<json>'` configures the `external` backend's `externalCommand` object: `{"command":"claude","args":["-p","--output-format","json","--model","sonnet"],"promptDelivery":"stdin","outputCapture":"stdout","outputFormat":"json","resultPath":"result"}`. `args[]` may use the placeholders `{prompt}` `{promptFile}` `{outputFile}` `{cwd}` `{kind}` `{base}`. An invalid config is rejected with a clear error and nothing is changed. `--clear-backend-config` removes it.
- `--profile <id>` selects the review persona: `generic-code`, `plan-devils-advocate`, `security-review`, `migration-review`, `ai-eval-review`, or `gsd-plan-review`. With no profile set, each review kind uses its per-kind default. Pass `--profile ""` to clear it.
- `--pricing '<json>'` sets per-model USD-per-1M-token rate overrides that win over the plugin's hardcoded table, e.g. `{"gpt-5.5":{"in":5.0,"out":30.0}}` (`cachedIn` is optional, defaults to `in/10`). `--clear-pricing` removes all overrides.
- With no arguments, this just reports the current settings (including whether each value is a default or an override, the backend, profile, pricing, and whether the project is onboarded) and whether the `codex` CLI is available.
- If the output says the Codex CLI is not available, tell the user it must be installed separately with `npm install -g @openai/codex`.
- If the output says the project is NOT onboarded, suggest running `/codex-autoreview:onboard` — the automatic review hooks no-op until onboarding is complete.
- If review is enabled, suggest adding a `statusLine` entry running `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs"` so the `codex-autoreview: ON` marker shows. Do not overwrite an existing custom statusline; describe the change instead.
