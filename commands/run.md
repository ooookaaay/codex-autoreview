---
description: Run a manual on-demand Codex review of the current code changes (or a plan) — dispatched through a native review subagent
argument-hint: '[plan|code] [--plan "<plan text>"] [--note "<context>"]'
allowed-tools: Task, Bash(node:*)
---

The user asked for a manual Codex review with `/codex-autoreview:run`.

Arguments received: `$ARGUMENTS`

Run the review by **spawning a native review subagent with the Agent tool** (do
NOT run the review CLI directly in the main session). The subagent keeps the
review visible in Claude's status as `◯ … codex review` with the harness's own
timer and token accounting for the whole duration.

Steps:

1. Decide the review kind from `$ARGUMENTS`:
   - `plan` if the first argument is `plan`, or if a `--plan` value is given;
   - otherwise `code` (the default — reviews the uncommitted working-tree changes).

2. Use the **Agent tool** (`Task`) to launch ONE subagent. Give it this prompt,
   substituting the kind and passing through any `--plan` / `--note` values:

   > You are running a manual Codex review. Run exactly this command and wait
   > for it to finish — it dispatches the review, polls until Codex returns a
   > verdict, and prints the result:
   >
   > `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-autoreview.mjs" run <kind> [--plan "<plan text>"] [--note "<context>"]`
   >
   > Do not do anything else. When the command prints the verdict, return its
   > full output verbatim as your final message — every finding, file path, and
   > line number exactly as Codex reported it. Do not summarize or shorten it.

   The `run` CLI subcommand owns the whole review lifecycle (dispatch → poll →
   print), so the subagent only has to run that one command and relay its
   output. The subagent must NOT modify any files — a review is read-only.

3. When the subagent returns, present its full output to the user. Do not
   condense it. If the verdict line is `ISSUES:` / `CONCERNS:`, draw the user's
   attention to the findings but do not act on them unless asked.

Notes:
- If the working tree has no uncommitted changes, the `run` command reports
  "nothing to review" cleanly — relay that and stop.
- If the Codex CLI is not available, the `run` command says so — tell the user
  to install it with `npm install -g @openai/codex` and stop.
- This manual review does NOT require the project to be enabled or onboarded —
  it is an explicit on-demand action. The automatic `Stop` / `ExitPlanMode`
  reviews are the ones gated on the per-project toggle and onboarding.
- The review still uses the project's configured model, effort, timeout, and
  reviewer backend (see `/codex-autoreview:config`).
