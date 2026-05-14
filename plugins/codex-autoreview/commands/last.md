---
description: Show the most recent Codex review verdict for this project (plan or code)
argument-hint: '[plan|code]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

The user invoked `/codex-autoreview:last`.

Arguments received: `$ARGUMENTS`

Run the command yourself with the **Bash tool**. The only valid argument is an
optional `plan` or `code` review-kind selector — never splice the raw
`$ARGUMENTS` string into the command line.

Invoke:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" last [plan|code]`

If the user passed `plan` or `code`, append exactly that one literal word as a
separate explicit argument. If they passed anything else, run `last` with no
extra argument (it then shows the most recent review of either kind).

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- The review id, kind, status, and timestamp
- The reviewer backend that produced it (and whether the result is `degraded` — a prose-only backend with no claim-level structure)
- The verdict line (`SOUND:` / `CONCERNS:` / `CLEAN:` / `ISSUES:`)
- The token count and estimated cost line, when present (`tokens: <in>/<out> · ~$<cost>`)
- The complete Codex output, including every finding, file path, and line number exactly as reported
- Any error messages

If the status is still `queued` or `running`, tell the user the background review has not finished yet and to re-run `/codex-autoreview:last` shortly. If the status is marked `LIKELY STUCK`, the background worker has most likely died — tell the user to re-run the action (or `/codex-autoreview:run`) to dispatch a fresh review.

Pass `plan` or `code` as the argument to scope to that review kind; with no argument it shows the most recent review of either kind.
