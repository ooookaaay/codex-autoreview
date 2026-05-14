# codex-autoreview improvement report

Date: 2026-05-14

Scope: public-safe architecture and product review for the Claude Code plugin
`codex-autoreview`. This report intentionally avoids secrets, private names,
emails, absolute home paths, cookies, raw private logs, and private project
content. File references are relative to the plugin repository.

## Executive verdict

`codex-autoreview` has the right core shape for the intended workflow: Claude
does the primary work, Codex runs as a separate reviewer, reviews are advisory,
hooks do not block normal work, and verdicts come back into the Claude session.
The current implementation is already stronger than a simple hook script:
it has per-project enablement, detached workers, state locking, timeouts,
session-scoped surfacing, cleanup, and tests.

Before public release, the biggest improvements are not more features. They are:

1. Make the Codex subprocess privacy-hardened by default.
2. Anchor each review to the exact plan/diff that triggered it.
3. Deduplicate repeated reviews of the same unchanged input.
4. Use current Codex/Claude primitives where they reduce custom machinery.
5. Add a strict output schema so Claude gets actionable review results instead
   of free-form text.

The highest-risk current issue is that `request.prompt` is persisted in plugin
state. For plan review this can store full plan text; for code review it can
store Claude's last response. That is useful for recovery, but public plugins
should minimize prompt persistence by default.

## What was reviewed

Plugin files:

- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- `commands/config.md`
- `commands/last.md`
- `prompts/auto-code-review.md`
- `prompts/auto-plan-review.md`
- `scripts/auto-code-review-hook.mjs`
- `scripts/auto-plan-review-hook.mjs`
- `scripts/codex-autoreview.mjs`
- `scripts/lib/auto-review.mjs`
- `scripts/lib/codex.mjs`
- `scripts/lib/git.mjs`
- `scripts/lib/process.mjs`
- `scripts/lib/prompts.mjs`
- `scripts/lib/state.mjs`
- `scripts/lib/workspace.mjs`
- `scripts/review-worker.mjs`
- `scripts/session-end-cleanup-hook.mjs`
- `scripts/statusline.mjs`
- `scripts/surface-verdict-hook.mjs`
- `tests/codex-autoreview.test.mjs`
- `tests/helpers.mjs`

Current local tool versions used for compatibility checks:

- Claude Code: `2.1.141`
- Codex CLI: `0.130.0`
- `npm test`: 49 tests passed

Official references checked:

- Claude Code hooks reference:
  https://code.claude.com/docs/en/hooks
- Claude Code plugins reference:
  https://code.claude.com/docs/en/plugins-reference
- OpenAI Codex non-interactive mode:
  https://developers.openai.com/codex/noninteractive
- OpenAI Codex configuration reference:
  https://developers.openai.com/codex/config-reference
- OpenAI Codex sandbox and approvals:
  https://developers.openai.com/codex/agent-approvals-security#sandbox-and-approvals
- OpenAI Codex common sandbox/approval combinations:
  https://developers.openai.com/codex/agent-approvals-security#common-sandbox-and-approval-combinations
- OpenAI Codex MCP:
  https://developers.openai.com/codex/mcp
- OpenAI Codex App Server:
  https://developers.openai.com/codex/app-server#api-overview
- OWASP LLM01 prompt injection:
  https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- OWASP MCP Top 10:
  https://owasp.org/www-project-mcp-top-10/

## Current architecture

The plugin is a standalone Claude Code plugin, not a fork of an OpenAI plugin.
It uses Claude hooks and slash commands:

- `PreToolUse` with matcher `ExitPlanMode` starts a plan review.
- `Stop` starts a code review when the working tree is dirty.
- `UserPromptSubmit` injects finished Codex verdicts into the next Claude turn.
- `SessionEnd` cleans up this plugin's workers and transient review files.
- `/codex-autoreview:config` manages per-project settings.
- `/codex-autoreview:last` prints the latest saved verdict.

The execution path is:

1. Hook checks config and Codex CLI availability.
2. Hook writes a queued review record.
3. Hook starts detached `review-worker.mjs`.
4. Worker runs `codex exec` with `--sandbox read-only`.
5. Worker writes final verdict/output/error into plugin state.
6. `UserPromptSubmit` injects completed unsurfaced reviews once.
7. `SessionEnd` kills/reconciles only this session's unfinished workers.

Good existing decisions:

- Reviews are disabled by default per project.
- Model override is optional; no hardcoded model is passed by default.
- Reasoning effort has a plugin default (`medium`) instead of inheriting a slow
  global Codex default.
- Worker has a hard wall-clock timeout and process-group kill.
- State writes are atomic and protected by a lock.
- Surfacing is session-scoped, so one Claude session should not consume another
  session's verdict.
- `SessionEnd` explicitly avoids touching Codex auth/config/history.
- The prompt contracts are compact and force first-line verdicts.

## Product fit for the observed workflow

The target user pattern is not "ask a bot for a vague review". It is a
single-operator, multi-agent development workflow with strong constraints:

- The reviewer must be adversarial but not noisy.
- Findings must be grounded in files, diffs, plans, and practical failure modes.
- Automation must not mutate unrelated code, docs, or planning artifacts.
- No hidden cleanup, reset, checkout, or file deletion behavior is acceptable.
- Public artifacts must not contain secrets, names, emails, cookies, home paths,
  or private logs.
- The operator wants concise decisions and useful next actions, not broad essays.
- Review results should come back automatically; manual polling is a fallback.
- Personal auth flows, including web-cookie based provider access, must never be
  copied into a public plugin or printed in logs.

The plugin mostly matches this. The missing pieces are review input anchoring,
privacy minimization, dedupe, and structured reviewer output.

## Priority recommendations

| Priority | Recommendation | Why it matters | Suggested acceptance check |
| --- | --- | --- | --- |
| P0 | Stop persisting full `request.prompt` after dispatch. | State can contain full plans and Claude responses. Public plugins should minimize sensitive prompt retention. | After a completed/failed review, `state.json` contains only metadata, hashes, status, verdict, and output; prompt-bearing request file is deleted or redacted. |
| P0 | Run Codex with ephemeral/non-interactive hardening. | `codex exec` can persist session rollout files unless `--ephemeral` is used. Non-interactive review should also never ask for approval. | `buildCodexExecArgs()` includes `--ephemeral` and `-c approval_policy="never"` or a verified equivalent. |
| P0 | Sanitize the environment passed to Codex. | Current worker inherits the parent environment. A read-only model can still run commands that print env vars unless constrained. | Add env allowlist tests. Secret-like env vars (`TOKEN`, `KEY`, `SECRET`, `COOKIE`) are absent from child env unless explicitly required. |
| P0 | Deny secret files from reviewer reads where possible. | Claude hook docs explicitly recommend skipping `.env`, `.git`, keys, etc. Codex permissions can deny project globs. | A test fixture with `.env` verifies the generated Codex config denies it or prompt/output redaction removes it. |
| P1 | Anchor code reviews to a diff fingerprint captured at hook time. | The Stop hook queues a review, but the worker reviews the working tree later. If files change meanwhile, the result can target the wrong change. | Store `HEAD`, status, changed-file list, and a diff hash. If changed before worker starts, mark review `stale` or include a clear stale warning. |
| P1 | Deduplicate identical pending/recent reviews. | Stop hooks can fire repeatedly while the same dirty tree remains. Without dedupe, usage and noise grow. | Same `kind + session + inputHash` while queued/running/recent reuses the existing review id. |
| P1 | Use `codex exec review --uncommitted` for code review, or test it behind a config flag. | Codex CLI 0.130.0 has a dedicated non-interactive review subcommand. It is likely better scoped than asking generic `codex exec` to inspect the tree. | Add `backend=generic-exec|exec-review`; compare outputs on fixtures before switching default. |
| P1 | Add JSON schema output for reviewer verdicts. | Parsing a first text line is fragile. Codex supports `--output-schema` for structured final output. | Worker stores `{verdict, summary, findings[], confidence, stale, reviewedInputHash}` and renders text from JSON. |
| P1 | Surface failed/stuck reviews, not only completed reviews. | A silent timeout looks like no review happened. The operator needs to know automation failed. | `UserPromptSubmit` injects a one-line failed/stuck notice once, capped and session-scoped. |
| P1 | Make malformed hook input a clean no-op for plan/code hooks. | `JSON.parse` currently throws in plan/code hooks. Claude treats exit 1 as non-blocking but noisy. | Bad JSON stdin exits 0 and does not dispatch. |
| P1 | Re-check `none` reasoning effort against current Codex docs. | Official `model_reasoning_effort` docs list `minimal|low|medium|high|xhigh`; `none` is listed for plan-mode effort, not model effort. | Either remove `none`, map it to omitted effort, or add a real Codex smoke test proving current CLI accepts it. |
| P1 | Cap captured stdout/stderr from Codex. | A failed/hung process can emit large logs and grow memory. | stdout/stderr buffers are bounded; overflow is summarized and written to a bounded log file. |
| P2 | Add include/exclude globs. | Public users differ: some want docs/plans reviewed, others want only source code. | Config supports default excludes for `.env`, secrets, large/generated files, plus user globs. |
| P2 | Make review surfacing action-safe. | Injected review context can cause Claude to act during an unrelated later prompt. | Surfaced context says findings are advisory and should not trigger edits unless the current task still calls for edits or the user approves. |
| P2 | Improve statusline signal. | Current statusline only shows ON/model/effort. The useful operator signal is pending/issues/failed. | Statusline can show `pending:1`, `issues`, or `failed` without noisy detail. |
| P2 | Add release metadata. | The manifest is valid, but public distribution benefits from repository/homepage/keywords and explicit support matrix. | `.claude-plugin/plugin.json` has public repo metadata and docs mention supported OS/version range. |

## Codex subprocess hardening

Current `buildCodexExecArgs()` does the important baseline:

- `codex exec`
- optional `--model`
- optional `-c model_reasoning_effort=...`
- `--cd <cwd>`
- `--sandbox read-only`
- `--skip-git-repo-check`
- `--color never`
- `--output-last-message <file>`

Recommended hardened default:

```text
codex exec
  --cd <cwd>
  --sandbox read-only
  --ephemeral
  --color never
  --output-last-message <file>
  -c approval_policy="never"
  -c shell_environment_policy.inherit="core"
  -c allow_login_shell=false
  -c history.persistence="none"
```

Notes:

- The local `codex exec --help` supports `--ephemeral`, `--json`,
  `--output-schema`, `--ignore-user-config`, and `--ignore-rules`.
- The local help did not show `--ask-for-approval`, but official docs still
  describe approval policy. Use `-c approval_policy="never"` because `-c` is
  supported and documented.
- Do not use `--ignore-user-config` by default. It can break ChatGPT-managed
  auth, model provider setup, and user-level Codex configuration. Offer it only
  as an explicit strict mode.
- Do not ship a web-cookie provider integration in the public plugin. If
  non-Codex reviewers are needed later, expose a generic `externalCommand`
  interface and keep all auth external, never in plugin state.
- Reconsider `--skip-git-repo-check`. For code review inside a Git repo it is
  unnecessary. For plan review it may be useful, but it should be conditional.

Environment hardening:

- Pass a minimal `env` to the worker and Codex, not `...process.env`.
- Keep only what is required to launch Node/Codex and find auth/config:
  `PATH`, `HOME`, `CODEX_HOME`, locale vars, and a small explicit auth allowlist.
- Exclude secret-shaped names by default: `*TOKEN*`, `*KEY*`, `*SECRET*`,
  `*COOKIE*`, `*PASSWORD*`, `*AUTH*`.
- If API-key based automation is explicitly supported, allow only
  `CODEX_API_KEY` for that mode and document the risk.

## Review input anchoring

The current code review prompt says Codex should inspect the working tree. That
is convenient but not deterministic enough for background automation.

Better dispatch record:

```json
{
  "kind": "code",
  "inputHash": "sha256-of-head-status-diff",
  "head": "current HEAD or null",
  "statusPorcelain": "bounded status snapshot",
  "changedFiles": ["relative/path"],
  "diffStat": "bounded diff stat",
  "createdAt": "timestamp",
  "sessionId": "Claude session id"
}
```

Worker behavior:

1. Recompute the fingerprint before running Codex.
2. If it differs, either mark the review `stale` and stop, or run anyway with a
   clear `STALE:` field in the structured output.
3. Include the changed-file list and diff hash in the prompt so Codex knows the
   intended target.

For plan review, use `sha256(planText)` and dedupe identical plan text within a
short TTL.

## Structured output contract

Current text verdicts are readable:

- Plan: `SOUND:` or `CONCERNS:`
- Code: `CLEAN:` or `ISSUES:`

For automation, add a JSON schema and render the text view from it:

```json
{
  "type": "object",
  "required": ["kind", "verdict", "summary", "findings", "reviewedInputHash"],
  "additionalProperties": false,
  "properties": {
    "kind": { "enum": ["plan", "code"] },
    "verdict": {
      "enum": ["SOUND", "CONCERNS", "CLEAN", "ISSUES", "STALE", "FAILED"]
    },
    "summary": { "type": "string", "maxLength": 500 },
    "reviewedInputHash": { "type": "string" },
    "findings": {
      "type": "array",
      "maxItems": 10,
      "items": {
        "type": "object",
        "required": ["severity", "file", "line", "claim", "impact", "fix"],
        "additionalProperties": false,
        "properties": {
          "severity": { "enum": ["high", "medium", "low"] },
          "file": { "type": ["string", "null"] },
          "line": { "type": ["integer", "null"] },
          "claim": { "type": "string" },
          "impact": { "type": "string" },
          "fix": { "type": "string" },
          "confidence": { "enum": ["high", "medium", "low"] }
        }
      }
    }
  }
}
```

This directly matches the product goal: Claude should receive a compact,
actionable peer-review packet, then decide whether each finding is valid.

## Claude hook architecture

Current hook choices are valid in Claude Code 2.1.x. Relevant latest behavior:

- `UserPromptSubmit` can inject context using `hookSpecificOutput.additionalContext`.
- Hook-injected context is capped by Claude Code; the plugin's own 1400-char cap
  is conservative and useful.
- `SessionEnd` cannot block session termination and has a short default timeout;
  the plugin config raises it to 15 seconds, which fits the official maximum
  budget model.
- Claude now supports `async: true` command hooks. Async hook output can be
  delivered on the next conversation turn.

Recommendation on native async hooks:

Do not replace the custom worker immediately. The custom worker provides state,
`/last`, dedupe potential, session scoping, hard timeout behavior, and cleanup.
Native async hooks reduce custom process management but currently do not replace
the plugin's stateful UX. A good next step is a small optional backend:

```text
reviewRunner = "worker" | "claude-async"
```

Use `worker` as default until async hooks can match:

- review id persistence
- session-scoped once-only surfacing
- stale/dedupe handling
- explicit cleanup and user-visible status

## Codex App Server and MCP options

Codex App Server exposes richer primitives than raw `codex exec`: threads,
turns, interrupts, model listing, `review/start`, command execution, plugin
listing, and config reads. It is attractive for a future version, not required
for the first public release.

Recommended stance:

- Keep `codex exec` as the default backend. It is simple, local, scriptable, and
  officially meant for non-interactive automation.
- Add a pluggable backend interface so a future `app-server` backend can be
  introduced without rewriting hooks/state.
- Use Codex MCP only if the plugin needs additional external context. Do not
  bundle MCP servers just to run a review; it increases auth and supply-chain
  surface.

Potential future backends:

```text
exec-generic     current codex exec prompt
exec-review      codex exec review --uncommitted
app-server       Codex App Server thread/review APIs
external-command user-supplied reviewer command, no bundled auth
```

## Provider/auth policy

Public plugin policy should be strict:

- Default provider: installed Codex CLI.
- Default model: unset, inherited from the user's Codex config.
- No bundled API keys.
- No bundled web-cookie auth.
- No automatic copying of auth files.
- No printing of `CODEX_HOME`, auth paths, cookie names, or token values.
- Optional external provider support must be command-based and local-only:
  the user owns the command and credentials; plugin stores only a command name
  and non-secret arguments.

This matters because web-cookie auth is often personal, fragile, and unsuitable
for public plugin distribution. It can exist in a private local setup, but not
as shipped public behavior.

## Plan review behavior

The plan hook is useful, but its timing is subtle. It runs on `ExitPlanMode`,
dispatches a background job, and returns immediately. That means the plan review
may finish after the user has already approved or after implementation has
started.

Recommended modes:

```text
planMode = "advisory" | "soft-gate" | "blocking"
```

- `advisory`: current behavior; never blocks.
- `soft-gate`: starts review and injects a visible warning that the plan is
  under review; Claude should wait for user confirmation before coding.
- `blocking`: waits up to a short timeout for Codex; blocks plan exit only if
  there are `CONCERNS` or the review fails.

Default should remain `advisory` for public safety and low friction, but
operators who rely on Codex as a plan gate need an explicit stricter mode.

## Code review behavior

The `Stop` hook is a good trigger because it avoids reviewing every edit.
Two improvements would make it production-grade:

1. Dedupe by diff fingerprint.
2. Prefer `codex exec review --uncommitted` when available.

The local Codex CLI supports:

```text
codex exec review --uncommitted
codex exec review --base <branch>
codex exec review --commit <sha>
```

This should be evaluated against the current custom prompt. If native review is
too broad or too verbose, keep the current prompt but still pass a captured diff
summary and changed-file list.

## False-positive control

The current prompts already say "material findings only". For this workflow,
go further. Require Codex to classify each finding:

```text
validity = "likely-valid" | "needs-human-check" | "probably-false"
cost = "must-fix-now" | "can-defer" | "not-worth-it"
```

Claude should then surface:

- what it accepts
- what it rejects
- what it defers
- why

This matches the operator's preference for decisive, evidence-based review
without turning every review into extra work.

## Public release checklist

Required before publishing:

- [ ] No code or docs examples include private home paths, names, emails,
      cookies, tokens, or real private project identifiers.
- [ ] `npm test` passes.
- [ ] Add tests for malformed JSON on plan/code hooks.
- [ ] Add tests for prompt/request deletion or redaction after worker start.
- [ ] Add tests that secret-like env vars are not inherited by Codex.
- [ ] Add tests for duplicate Stop/ExitPlanMode inputs.
- [ ] Add tests for stale diff detection.
- [ ] Add a public docs note explaining what is stored in plugin state.
- [ ] Add a public docs note explaining that Codex can read repository files and
      review output may include snippets or file paths.
- [ ] Add a public docs note that `.env`, private keys, cookies, auth files, and
      generated secrets should be excluded from review scope.
- [ ] Decide whether Windows is supported. If yes, add process-tree cleanup tests
      or use a cross-platform tree-kill strategy. If no, document Linux/macOS
      support only.

## Test gaps to add

Current tests are solid for the existing behavior: 49 pass, including state
locking, timeout, worker terminal states, stuck review detection, auto-surfacing,
and SessionEnd cleanup.

Add these:

- Malformed stdin JSON for `auto-code-review-hook.mjs`.
- Malformed stdin JSON for `auto-plan-review-hook.mjs`.
- Duplicate dirty tree does not dispatch duplicate code reviews.
- Duplicate plan text does not dispatch duplicate plan reviews.
- Review marked stale when worktree fingerprint changes before worker starts.
- `--ephemeral` and approval-policy hardening are present in Codex args.
- `history.persistence="none"` or equivalent privacy mode is present.
- Secret-like env vars are removed from child env.
- `.env`/private key globs are denied or excluded.
- stdout/stderr cap prevents unbounded memory growth.
- SessionEnd does not kill unrelated pid on non-Linux platforms.
- Structured output schema accepts valid reviewer output and rejects malformed
  output.
- `/last` redacts obvious secrets by default, with an explicit raw/debug option
  only if needed.

## Suggested roadmap

### v0.2.x hardening

- Add `--ephemeral`.
- Add `-c approval_policy="never"`.
- Add minimal env allowlist.
- Redact/delete persisted prompts.
- Make plan/code hook JSON parse failures no-op.
- Surface failed/stuck review notices.
- Update README primary model example to avoid naming a model that may not be
  available to every account.

### v0.3 review correctness

- Add input fingerprints.
- Add dedupe.
- Add stale detection.
- Add `exec-review` backend experiment.
- Add structured JSON output schema.
- Add include/exclude globs.

### v0.4 public polish

- Add support matrix and release metadata.
- Add statusline pending/issues/failed indicators.
- Add privacy documentation.
- Add optional strict plan gate.
- Add optional app-server backend investigation.

## Recommended default configuration for public users

```text
enabled = false
model = null
effort = "medium"
timeoutMs = 240000
privacyMode = "strict"
planMode = "advisory"
codeBackend = "exec-review-if-available"
surfaceCompleted = true
surfaceFailures = true
dedupeTtlMs = 600000
maxPromptPersistMs = 0
```

Default posture:

- Do not block Claude.
- Do not mutate the repo.
- Do not persist prompts after use.
- Do not inherit secret env vars.
- Do not assume a specific Codex model.
- Do not ship personal provider auth.

## Bottom line

The plugin is close to a useful public release, but it should not publish as a
"background reviewer" until privacy minimization and input anchoring are fixed.
The current implementation already has the right ergonomics. The next work
should make it deterministic, deduplicated, and safe to run in repositories that
may contain private plans, local auth, or sensitive operational context.
