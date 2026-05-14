---
description: Self-diagnostics for codex-autoreview — checks the Codex CLI, auth, project config, stuck reviews, orphaned workers, ~/.codex log bloat, and pricing-table staleness
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

The user invoked `/codex-autoreview:doctor`.

Arguments received: `$ARGUMENTS`

Run the diagnostics yourself with the **Bash tool**. `doctor` takes no
arguments — ignore anything in `$ARGUMENTS` and never splice it into the
command line.

Invoke exactly:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" doctor`

Present the full diagnostic report to the user. Do not summarize it — every check line and every suggested action matters.

The report is read-only: `/codex-autoreview:doctor` never changes anything, never deletes any files (including under `~/.codex`). Each problem is reported with a concrete next step the user can take themselves.

The checks are:
- **codex CLI** — installed and runnable (a time-boxed `codex --version` probe).
- **codex auth** — whether `~/.codex` exists and holds an auth file; a missing one means `codex login` has not been run.
- **config** — the per-project plugin config is valid: the reviewer backend is known, the `externalCommand` config (if the backend is `external`) is well-formed, pricing overrides parse, and the timeout is sane.
- **onboarding** — whether the project has completed onboarding (review hooks no-op until it has).
- **stuck reviews** — any review still `queued`/`running` past its staleness bound; its worker died without recording a result. These self-heal on the next dispatch or `SessionEnd`.
- **review workers** — any in-flight review whose recorded worker pid is no longer a live process (an orphaned worker).
- **codex home size** — a warn-only size check of `~/.codex`; the plugin runs `--ephemeral` and does not add to it, but a user's interactive Codex use can grow it. The plugin never prunes it — that is the user's call.
- **pricing table** — whether the plugin's hardcoded USD-per-1M-token table is old enough that cost estimates may have drifted.

If any check is `FAIL`, walk the user through the suggested action. If checks are only `WARN`, reassure the user nothing is broken — the warnings are advisory.
