# codex-autoreview

**A second pair of eyes for Claude Code — every plan and every code change, reviewed by Codex in the background.**

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518.18-339933.svg)](plugins/codex-autoreview/package.json)
[![tests](https://img.shields.io/badge/tests-233%20passing-brightgreen.svg)](plugins/codex-autoreview/tests/)
[![version](https://img.shields.io/badge/version-0.3.1-orange.svg)](plugins/codex-autoreview/CHANGELOG.md)

This repository is a single-plugin [Claude Code](https://docs.claude.com/en/docs/claude-code)
marketplace. The plugin sends Claude's plans and code changes to the **Codex
CLI** for background review — as a *verifier, not a builder* — and surfaces the
verdict back into your session. Non-blocking, advisory, and self-cleaning.

It is **fully independent** of OpenAI's `codex` plugin: the integration code is
vendored. The only external requirement is a separately installed `codex` CLI.

---

## Install

```sh
# 1. Install the Codex CLI separately (the plugin does not bundle it)
npm install -g @openai/codex
codex login            # if your model provider requires it

# 2. Add this repo as a marketplace and install the plugin
claude plugin marketplace add ooookaaay/codex-autoreview
claude plugin install codex-autoreview@codex-autoreview

# 3. Enable & onboard it for a project (reviews are off per project by default)
#    Inside Claude Code:
#      /codex-autoreview:config --enable
#      /codex-autoreview:onboard
```

**📖 Full setup & usage manual:**
[`plugins/codex-autoreview/README.md`](plugins/codex-autoreview/README.md) —
install, configuration, review profiles, the privacy model, troubleshooting,
and how it all works.

---

## What it does

| | |
| --- | --- |
| 🧭 **Plan review** | `ExitPlanMode` → a devil's-advocate pass before any code is written. |
| 🐛 **Code review** | `Stop` → a claim-based bug hunt over the uncommitted working tree. |
| 💬 **Verdict surfacing** | The next prompt gets the verdict + high/medium findings + critical gaps — not the raw report. |
| 🎭 **Six review profiles** | `generic-code`, `plan-devils-advocate`, `security-review`, `migration-review`, `ai-eval-review`, `gsd-plan-review`. |
| 🩺 **`/doctor`, `/run`, `/last`, `/config`, `/onboard`** | Self-diagnosis, on-demand review, verdict replay, per-project config, guided setup. |
| 🚦 **Pre-push gate** | A `git push` is warned/blocked when the last review found blockers. |
| 💵 **Tokens & cost** | `codex exec --json` usage parsed into tokens; a dated, override-able table estimates USD. |
| ⏱️ **Hang-proof & self-cleaning** | Hard timeout + process-tree kill + guaranteed terminal state + `SessionEnd` cleanup. |

---

## Repository layout

```
.claude-plugin/marketplace.json     # the marketplace catalog
plugins/codex-autoreview/           # the plugin itself
  .claude-plugin/plugin.json        #   plugin manifest
  scripts/  prompts/  commands/  hooks/   #   plugin runtime
  tests/                            #   233-test node:test suite
  README.md  CHANGELOG.md           #   full plugin docs
```

## Tests

```sh
npm test                 # from the repo root (delegates to the plugin)
# or:  cd plugins/codex-autoreview && npm test
```

No dependencies, no build — the suite is plain `node --test` (233 tests).

## License

Apache-2.0 (see [`LICENSE`](LICENSE)). Some vendored modules under
`plugins/codex-autoreview/scripts/lib/` are adapted from OpenAI's
`codex-plugin-cc`, also Apache-2.0; attribution is in
[`plugins/codex-autoreview/NOTICE`](plugins/codex-autoreview/NOTICE).
