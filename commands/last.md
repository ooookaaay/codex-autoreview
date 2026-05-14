---
description: Show the most recent Codex review verdict for this project (plan or code)
argument-hint: '[plan|code]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" last $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- The review id, kind, status, and timestamp
- The verdict line (`SOUND:` / `CONCERNS:` / `CLEAN:` / `ISSUES:`)
- The complete Codex output, including every finding, file path, and line number exactly as reported
- Any error messages

If the status is still `queued` or `running`, tell the user the background review has not finished yet and to re-run `/codex-autoreview:last` shortly.

Pass `plan` or `code` as the argument to scope to that review kind; with no argument it shows the most recent review of either kind.
