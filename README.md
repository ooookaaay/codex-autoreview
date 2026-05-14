# codex-autoreview

**A second pair of eyes for Claude Code — every plan and every code change, reviewed by Codex in the background.**

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518.18-339933.svg)](package.json)
[![tests](https://img.shields.io/badge/tests-node%3Atest-brightgreen.svg)](tests/)
[![version](https://img.shields.io/badge/version-0.3.0-orange.svg)](CHANGELOG.md)

A standalone [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin
that sends Claude's plans and code changes to the **Codex CLI** for background
review — as a *verifier, not a builder* — and surfaces the verdict back into
your session. Non-blocking, advisory, and self-cleaning.

It is **fully independent** of OpenAI's `codex` plugin: the integration code is
vendored into `scripts/lib/`. The only external requirement is a separately
installed `codex` CLI.

---

## What it looks like

While a review runs, the statusline shows a live indicator:

```
codex-autoreview: ⏳ code review · 1m23s
```

When it finishes, the next prompt gets the verdict injected as context — only
what matters, not the raw report:

```
ISSUES: off-by-one in the retry loop drops the last attempt

[high] retry budget exhausted one iteration early — src/retry.ts:42
  impact: the final retry never runs; transient failures surface as hard errors
  fix: use `<= maxRetries` instead of `< maxRetries`

tokens: 4180/910 · ~$0.03
```

And when idle, the statusline reflects the last verdict: `CLEAN · VERIFIED`,
`ISSUES · FEEDBACK`, `pending:2`, or `FAILED · stale`.

---

## Install

The plugin has **no npm dependencies** and needs **Node ≥ 18.18** — the same
runtime Claude Code already uses. Setup is three steps: install the Codex CLI,
add the plugin, then enable & onboard it per project.

### 1. Install the Codex CLI (a separate prerequisite)

The plugin does **not** bundle Codex — it shells out to a `codex` binary on your
`PATH`.

```sh
npm install -g @openai/codex
codex login            # only if your model provider requires it
codex --version        # confirm it resolves
```

Without `codex`, every hook is a clean no-op and `/codex-autoreview:doctor`
tells you exactly what's missing — the plugin never breaks your session.

### 2. Add the plugin to Claude Code

**From GitHub (recommended):**

```sh
claude plugin marketplace add ooookaaay/codex-autoreview
claude plugin install codex-autoreview@codex-autoreview
```

**From a local clone** (for development or air-gapped setups):

```sh
git clone https://github.com/ooookaaay/codex-autoreview
claude plugin marketplace add ./codex-autoreview
claude plugin install codex-autoreview@codex-autoreview
```

Either way you can also use the interactive `/plugin` menu inside Claude Code.
Verify with `claude plugin list` — `codex-autoreview` should appear enabled.

### 3. Enable & onboard it for a project

Reviews are **off per project** by default — installing the plugin changes
nothing until you opt a repo in:

```
/codex-autoreview:config --enable
/codex-autoreview:onboard
```

`onboard` walks you through the rest (codex login → model/effort → statusline →
optional `.codex-autoreview.md`). Until onboarding completes, the review hooks
stay a clean no-op.

### 4. (Optional) Show the live statusline indicator

A plugin manifest cannot register `statusLine` — Claude Code does not honor that
key from a plugin — so add it to your Claude Code `settings.json` yourself:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs\""
  }
}
```

If you already have a statusline, add this as one segment instead of replacing it.

### Updating & uninstalling

```sh
claude plugin marketplace update codex-autoreview   # pull the latest
claude plugin uninstall codex-autoreview            # remove it
```

---

## Quick start

Once installed and onboarded, you do nothing — reviews happen on their own:

1. **Plan a change.** When Claude leaves plan mode (`ExitPlanMode`), a
   devil's-advocate plan review fires in the background.
2. **Write code.** When Claude stops (`Stop`), a bug-finding review runs over
   the uncommitted working tree.
3. **Keep working.** The next time you submit a prompt, any finished verdict is
   injected as context — verdict + high/medium findings + critical gaps only.
4. **Push.** A `git push` is warned or blocked if the last review found blockers.

Want a review right now, on demand?

```
/codex-autoreview:run            # review the current working tree
/codex-autoreview:run plan       # review the last plan
```

---

## Features

| | |
| --- | --- |
| 🧭 **Plan review** | `ExitPlanMode` → a devil's-advocate pass before any code is written. |
| 🐛 **Code review** | `Stop` → a claim-based bug hunt over the uncommitted working tree. |
| 💬 **Verdict surfacing** | The next prompt gets the verdict + high/medium findings + critical gaps — not the raw report. |
| 🎭 **Six review profiles** | `generic-code`, `plan-devils-advocate`, `security-review`, `migration-review`, `ai-eval-review`, `gsd-plan-review`. |
| 📄 **Project config** | Drop a `.codex-autoreview.md` in a repo for project-specific reviewer instructions and a default profile. |
| 🩺 **`/doctor`** | Self-diagnosis: codex install/login, config, stuck reviews, orphans, log bloat, stale pricing. |
| ▶️ **`/run`** | On-demand review as a real Claude subagent — visible in Claude's native status with a timer. |
| 🚦 **Pre-push gate** | A `git push` is warned/blocked when the last review found blockers. |
| 💵 **Tokens & cost** | `codex exec --json` usage parsed into tokens; a dated, override-able table estimates USD. |
| 🔌 **Pluggable backends** | `exec-generic`, `exec-review`, and `externalCommand` for an independent second reviewer. |
| 🧹 **Self-cleaning** | `SessionEnd` reaps orphaned workers, finalizes in-flight reviews, prints a digest, prunes old records. |
| ⏱️ **Hang-proof** | Hard timeout + process-tree kill + guaranteed terminal state + stuck-job self-healing. |

---

## How it works

Reviews run as a **detached background process** and return control
immediately — Claude is never blocked.

```
ExitPlanMode / Stop ─▶ dispatch detached worker ─▶ codex exec (read-only)
                                                        │
   UserPromptSubmit ◀── inject verdict ◀── structured JSON result ◀┘
```

Codex reviews as a **verifier, not a builder**: it does not write or fix code —
it proves or disproves claims with deterministic, read-only evidence. The work
under review is decomposed into atomic claims; anything that can't be backed by
a file, diff, command output, or test is reported as an `unverified` gap *with
the oracle that would settle it next time*. The result is a strict JSON object
(`verdict`, `confidence`, `claims[]`, `findings[]`, `unverified[]`, `usage`);
the human-readable verdict is rendered from it.

The reviewer's policy is **versioned on disk** — `prompts/_verifier-contract.md`
(the shared contract), `prompts/profiles/*.md` (the six profiles), and the
per-kind task blocks — never an ad-hoc string inside a hook.

The hooks are a clean **no-op** when: reviews are off or onboarding is
incomplete, there is nothing reviewable, the `codex` CLI is missing, or the
hook gets malformed input.

<details>
<summary><b>Hang protection — the details</b></summary>

- Every `codex exec` runs under a hard, configurable wall-clock timeout
  (default 240s). On timeout the whole `codex` process tree is killed and the
  review is marked `failed`.
- The background worker flushes a terminal state (`completed`/`failed`) on
  *every* error path — including being `SIGTERM`/`SIGINT`-killed itself.
- The dispatch hooks only spawn the worker and exit; they never wait.
- A review stuck in `queued`/`running` far past its bound is flagged (not shown
  as healthy) by `/codex-autoreview:last` and the statusline.
- A review orphaned by a `SIGKILL`/OOM/crash self-heals: it is reconciled to
  `failed` by `SessionEnd` and on the next dispatch.

</details>

---

## Configuration

```
/codex-autoreview:config                       # show current settings + codex availability
/codex-autoreview:config --enable               # turn reviews on for this project
/codex-autoreview:config --disable              # turn them off
```

<details>
<summary><b>Model, reasoning effort & timeout</b></summary>

```
/codex-autoreview:config --enable --model gpt-5.4-mini --effort high --timeout 180000
```

- **`--effort`** — `low` · `medium` (default) · `high` · `xhigh`. This is the
  plugin's *own* default; it is **not** inherited from your global
  `~/.codex/config.toml`, so a global `xhigh` does not slow every background
  review. `medium` is responsive but still has enough reasoning budget to trace
  cross-file logic.
- **`--model`** — unset by default, inherited from `~/.codex/config.toml`. A
  hardcoded model can be rejected by ChatGPT-auth accounts, so the plugin does
  not pin one. (`gpt-5.4-mini` above is only an illustration — use a model your
  account can access.)
- **`--timeout`** — hard per-review timeout in ms (default `240000`, range
  `10000`–`1800000`). On expiry the `codex` process tree is killed and the
  review is `failed`.
- **Reset** — pass an empty string: `--model ""`, `--effort ""`, `--timeout ""`.

Invalid `--effort`/`--timeout` values are rejected with a clear error; settings
are left unchanged.

</details>

<details>
<summary><b>Review profiles</b></summary>

A profile sets the review's emphasis, evidence bar, finding bar, and output
caps. All profiles share the verifier contract.

| Profile | Focus |
| --- | --- |
| `generic-code` | Correctness of the just-made code change (default for code reviews). |
| `plan-devils-advocate` | Strongest reasons a plan should not execute as written (default for plan reviews). |
| `security-review` | Injection, authn/authz, secret exposure, SSRF, unsafe crypto. Higher finding cap; favors false positives. |
| `migration-review` | Behavior parity, data-loss risk, backward compatibility, rollback path. |
| `ai-eval-review` | Eval coverage gaps, oracle quality, label leakage, prompt-injection in eval inputs. |
| `gsd-plan-review` | GSD plan artifacts: phase decomposition, requirement traceability, verification-loop completeness, wave conflicts. |

Selection: built-in default → `.codex-autoreview.md` per-project override →
`/codex-autoreview:run --profile <name>` per-run override.

</details>

<details>
<summary><b>Project-local <code>.codex-autoreview.md</code></b></summary>

Drop a `.codex-autoreview.md` at a repository root to give the reviewer
project-specific instructions and a default profile.

- Discovered from the current directory, then up to the git root — so it works
  from a subdirectory too.
- Folded into the review prompt *after* the contract and profile. It **refines**
  the profile but never relaxes the verifier contract or lowers the evidence bar.
- An oversized file is truncated so it cannot bloat the prompt.

> **Privacy:** this file is sent to Codex as part of the prompt. Keep it free of
> secrets, keys, and tokens — treat it as ordinary project notes.

</details>

<details>
<summary><b>Tokens & cost</b></summary>

`codex exec --json` usage events are parsed into `tokensIn`/`tokensOut`; a
dated pricing table (`scripts/lib/pricing.mjs`, stamped `PRICING_AS_OF`)
estimates the USD cost.

- Override per project (`pricing.<modelId>`) or per run (`--price-in` /
  `--price-out`).
- An unknown model degrades to an honest "cost unknown" — never a fake `$0` —
  and never fails the review.
- `/codex-autoreview:doctor` flags a pricing table older than 120 days.

</details>

---

## Verdicts

A review's first line follows a fixed contract:

- **plan** — `SOUND:` (reasonable to execute) or `CONCERNS:` (address first)
- **code** — `CLEAN:` (no material bugs) or `ISSUES:` (problems found)
- **`STALE:`** — the reviewed input changed; the review is out of date

The verdict surfaces **automatically** into the next prompt (once each, marked
`surfacedAt`) — only the verdict, high/medium findings, and critical unverified
gaps, not the raw report. A finding you dismiss is not re-surfaced by later
reviews. You can always replay the full last verdict manually:

```
/codex-autoreview:last           # most recent
/codex-autoreview:last plan      # filter by kind
/codex-autoreview:last code
```

---

## Commands

| Command | Purpose |
| --- | --- |
| `/codex-autoreview:config` | View or change per-project settings: enable/disable, model, effort, timeout. |
| `/codex-autoreview:last` | Show the last saved Codex verdict (plan or code). |
| `/codex-autoreview:run` | Run a review on demand as a real Claude subagent. |
| `/codex-autoreview:doctor` | Self-diagnosis: codex, config, stuck reviews, orphans, logs, pricing. |
| `/codex-autoreview:onboard` | Re-run the onboarding flow. |

---

## Troubleshooting

Start with `/codex-autoreview:doctor` — it checks the Codex install and login,
the per-project config, stuck or orphaned reviews, log bloat, and pricing
staleness, and tells you what to fix.

| Symptom | Likely cause & fix |
| --- | --- |
| Nothing happens on plan/stop | Reviews are off or onboarding is incomplete for this repo — run `/codex-autoreview:config --enable` then `/codex-autoreview:onboard`. |
| `codex` not found | The Codex CLI is not on `PATH` — `npm install -g @openai/codex`, then re-check with `codex --version`. |
| Reviews `FAILED` immediately | Codex auth/model issue — run `codex login`, and check `--model` is one your account can access (or reset it with `--model ""`). |
| A review is stuck `running` | It is flagged stale by the statusline and `/codex-autoreview:last`; `SessionEnd` and the next dispatch self-heal it to `failed`. `/codex-autoreview:doctor` can also report it. |
| Statusline indicator missing | The `statusLine` entry must be in your own Claude Code `settings.json` — see Install step 4. A plugin manifest cannot register it. |
| Verdict never surfaced | Verdicts surface once each, into the **next** prompt after the review finishes — replay any time with `/codex-autoreview:last`. |
| Cost shows "unknown" | The model is not in the dated pricing table — set `pricing.<modelId>` per project or `--price-in`/`--price-out` per run. |

---

## Privacy

Designed privacy-first. What you should know:

- **Codex reads your repository files.** To review a change, `codex exec` runs
  with `--sandbox read-only` and `--cd` at the project root, and inspects the
  working tree itself (`git diff`, file reads). It is read-only — the plugin and
  the reviewer never modify, check out, or delete anything in your project.
- **Don't put secrets where reviews can see them.** Secret files (`.env`, keys)
  are deny-globbed from the reviewer. But `.codex-autoreview.md` and the plan
  text *are* sent to Codex in the prompt — keep them free of secrets and
  credentials.
- **What's stored in plugin state** (`state.json`, in the plugin's data
  directory — *not* your repo): project settings, a ring buffer of recent
  reviews with their structured result (verdict, findings, unverified gaps,
  tokens/cost), `surfacedAt`/`onboardedAt` markers, dismissed findings, and
  accumulated review gaps. **The full prompt text is not kept after dispatch** —
  it is redacted/deleted.
- **Minimal env allowlist.** No secret environment variables are forwarded to
  the child `codex`; auth paths are not logged; no keys or cookie-auth are
  bundled.
- **`~/.codex` is never touched** — Codex's own config, auth, and history are
  out of scope for every hook.

---

## Requirements

- **Node.js ≥ 18.18.0** — already present if you have Claude Code.
- **The `codex` CLI, installed separately** — `npm install -g @openai/codex`,
  then `codex login` if your provider requires it. Without it the hooks no-op
  cleanly, and `/codex-autoreview:config` and `/codex-autoreview:doctor` say so.

## Tests

```
npm test
```

No dependencies, no build — the suite is plain `node --test`.

## License

Apache-2.0 (see `LICENSE`). Some modules under `scripts/lib/` are vendored or
adapted from OpenAI's `codex-plugin-cc`, also Apache-2.0; attribution is in
`NOTICE` and in each vendored file's header.
