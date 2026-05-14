# Codebase Structure

**Analysis Date:** 2026-05-14

## Directory Layout

```
codex-autoreview/                       # repo root
├── .claude-plugin/
│   └── marketplace.json                # single-plugin marketplace manifest → ./plugins/codex-autoreview
├── package.json                        # repo-root wrapper; `npm test` proxies into the plugin
├── LICENSE                             # Apache-2.0
├── README.md
└── plugins/
    └── codex-autoreview/               # THE PLUGIN — everything ships from here
        ├── .claude-plugin/
        │   └── plugin.json             # Claude Code plugin manifest (name, version, keywords)
        ├── package.json                # plugin package: ESM ("type":"module"), Node >=18.18, `node --test`
        ├── CHANGELOG.md
        ├── LICENSE  ·  NOTICE          # NOTICE attributes code vendored from codex-plugin-cc
        ├── README.md
        ├── hooks/
        │   └── hooks.json              # maps Claude Code hook events → scripts/*-hook.mjs (exec form)
        ├── commands/                   # slash-command definitions (markdown front-matter + body)
        │   ├── config.md  ·  doctor.md  ·  last.md  ·  onboard.md  ·  run.md
        ├── prompts/                    # versioned reviewer-prompt parts (composed by lib/prompts.mjs)
        │   ├── _verifier-contract.md    # shared verifier contract (always first section)
        │   ├── auto-code-review.md      # kind=code task block (has {{...}} runtime slots)
        │   ├── auto-plan-review.md      # kind=plan task block
        │   └── profiles/                # one file per review profile
        │       ├── generic-code.md  ·  plan-devils-advocate.md  ·  security-review.md
        │       ├── migration-review.md  ·  ai-eval-review.md  ·  gsd-plan-review.md
        ├── scripts/                    # ALL executable code
        │   ├── codex-autoreview.mjs     # CLI entry point (config/last/run/onboard/doctor)
        │   ├── doctor.mjs               # `/doctor` self-diagnostics (read-only)
        │   ├── statusline.mjs           # statusline segment
        │   ├── review-worker.mjs        # detached background worker (the review lifecycle)
        │   ├── onboarding-hook.mjs           # SessionStart hook
        │   ├── auto-plan-review-hook.mjs     # PreToolUse/ExitPlanMode hook
        │   ├── auto-code-review-hook.mjs     # Stop hook
        │   ├── pre-push-review-hook.mjs      # PreToolUse/Bash hook (git push detector)
        │   ├── surface-verdict-hook.mjs      # UserPromptSubmit hook
        │   ├── session-end-cleanup-hook.mjs  # SessionEnd hook
        │   └── lib/                     # shared, non-entry-point modules
        │       ├── auto-review.mjs       # dispatchBackgroundReview — dispatch + dedupe + spawn
        │       ├── state.mjs             # per-project JSON state, lock, ring buffer, self-heal
        │       ├── codex.mjs             # `codex exec` integration (argv, run, --json parsing, env)
        │       ├── git.mjs               # working-tree inspection + F4 anchoring hashes
        │       ├── prompts.mjs           # prompt-template loading + assembleReviewPrompt
        │       ├── review-schema.mjs     # versioned claim-based result schema + renderers
        │       ├── pricing.mjs           # dated USD/MTok table + computeCostUsd
        │       ├── process.mjs           # spawnSync wrappers, binaryAvailable probe
        │       ├── workspace.mjs         # resolveWorkspaceRoot (git-root detection)
        │       ├── comparison.mjs        # two-reviewer consensus / comparison logic
        │       └── reviewers/            # the pluggable reviewer backends
        │           ├── index.mjs         # registry + typedefs + getReviewerBackend
        │           ├── exec-shared.mjs   # shared helpers for the codex exec-* backends
        │           ├── exec-generic.mjs  # DEFAULT backend — generic `codex exec`
        │           ├── exec-review.mjs   # `codex exec review` subcommand backend (scaffold)
        │           ├── external.mjs      # arbitrary user CLI as a 2nd reviewer
        │           └── app-server.mjs    # `codex app-server` JSON-RPC backend (stub, Phase 4)
        ├── tests/                       # `node --test` suites + helpers
        │   ├── helpers.mjs
        │   ├── foundation.test.mjs  ·  codex-autoreview.test.mjs
        │   ├── phase2-cli.test.mjs  ·  phase2-dispatch.test.mjs
        │   ├── phase2-docs.test.mjs  ·  phase2-surfacing.test.mjs
        └── docs/                        # design docs, plans, research notes (not shipped logic)
            ├── IMPLEMENTATION-PLAN.md  ·  AUDIT-FINDINGS.md  ·  *-report-2026-05-14.md
            └── research/                # platform/CLI/architecture research notes
```

## Directory Purposes

**`/` (repo root):**
- Purpose: Marketplace wrapper around the single plugin.
- Contains: `.claude-plugin/marketplace.json`, a thin `package.json` (its `test` script proxies into the plugin), `LICENSE`, `README.md`.
- Key files: `.claude-plugin/marketplace.json` — declares the marketplace and points `source` at `./plugins/codex-autoreview`.

**`plugins/codex-autoreview/`:**
- Purpose: The actual published plugin — the unit `marketplace.json` ships.
- Contains: the plugin manifest, hooks config, commands, prompts, scripts, tests, docs.
- Key files: `.claude-plugin/plugin.json` (manifest), `package.json` (`"type": "module"`, Node `>=18.18.0`), `hooks/hooks.json`.

**`plugins/codex-autoreview/hooks/`:**
- Purpose: Wire Claude Code hook events to scripts.
- Contains: just `hooks.json` — each entry uses exec form (`command: "node"`, `args: ["${CLAUDE_PLUGIN_ROOT}/scripts/<hook>.mjs"]`) so the plugin root passes as a literal arg.

**`plugins/codex-autoreview/commands/`:**
- Purpose: Slash-command definitions consumed by Claude Code.
- Contains: one `.md` per command (`config`, `doctor`, `last`, `onboard`, `run`) with YAML front-matter (`description`, `argument-hint`, `allowed-tools`) and a prompt body that drives the CLI.

**`plugins/codex-autoreview/prompts/`:**
- Purpose: Versioned, on-disk reviewer-prompt parts — the reviewer's policy is never an ad-hoc string built in code.
- Contains: `_verifier-contract.md`, the kind task blocks `auto-<kind>-review.md`, and `profiles/<profile>.md`.
- Key files: `lib/prompts.mjs` composes these in order: contract → profile → optional repo `.codex-autoreview.md` → task block.

**`plugins/codex-autoreview/scripts/`:**
- Purpose: All executable code.
- Contains: entry-point scripts directly under `scripts/` (CLI, worker, statusline, doctor, six `*-hook.mjs`); shared modules under `scripts/lib/`.
- Key files: `review-worker.mjs`, `codex-autoreview.mjs`.

**`plugins/codex-autoreview/scripts/lib/`:**
- Purpose: Shared, importable modules — never run directly.
- Contains: dispatch (`auto-review.mjs`), state (`state.mjs`), codex/git/prompt/schema/pricing/process/workspace/comparison helpers.

**`plugins/codex-autoreview/scripts/lib/reviewers/`:**
- Purpose: The pluggable reviewer-backend implementations and their registry.
- Contains: `index.mjs` (registry + JSDoc typedefs for the backend interface), `exec-shared.mjs`, and one file per backend id.

**`plugins/codex-autoreview/tests/`:**
- Purpose: The `node --test` suite.
- Contains: `*.test.mjs` suites grouped by area + a shared `helpers.mjs`.

**`plugins/codex-autoreview/docs/`:**
- Purpose: Design intent, implementation plans, audit findings, and research notes — reference material, not shipped logic.
- Contains: `IMPLEMENTATION-PLAN.md`, `AUDIT-FINDINGS.md`, dated reports, and `docs/research/` (platform / CLI / architecture / verifier-pattern research the code cites by name).

## Key File Locations

**Entry Points:**
- `plugins/codex-autoreview/scripts/codex-autoreview.mjs`: CLI behind every slash command.
- `plugins/codex-autoreview/scripts/review-worker.mjs`: detached background worker.
- `plugins/codex-autoreview/scripts/*-hook.mjs`: the six Claude Code hook scripts.
- `plugins/codex-autoreview/scripts/statusline.mjs`: statusline segment.

**Configuration / Manifests:**
- `.claude-plugin/marketplace.json`: marketplace manifest (repo root).
- `plugins/codex-autoreview/.claude-plugin/plugin.json`: plugin manifest.
- `plugins/codex-autoreview/hooks/hooks.json`: hook-event → script wiring.
- `plugins/codex-autoreview/package.json`: ESM declaration, Node engine, test script.
- `<reviewed-repo>/.codex-autoreview.md`: optional per-project reviewer instructions (read by `lib/prompts.mjs`; not part of this repo).

**Core Logic:**
- `plugins/codex-autoreview/scripts/lib/auto-review.mjs`: dispatch + dedupe + detached spawn.
- `plugins/codex-autoreview/scripts/lib/state.mjs`: the per-project state store and locking.
- `plugins/codex-autoreview/scripts/lib/codex.mjs`: `codex exec` integration.
- `plugins/codex-autoreview/scripts/lib/reviewers/index.mjs`: the backend registry and interface.
- `plugins/codex-autoreview/scripts/lib/review-schema.mjs`: the structured-result schema.

**Testing:**
- `plugins/codex-autoreview/tests/*.test.mjs`: suites.
- `plugins/codex-autoreview/tests/helpers.mjs`: shared test helpers.

## Naming Conventions

**Files:**
- All source is `*.mjs` (explicit ESM); `"type": "module"` is also set.
- Hook scripts: `<purpose>-hook.mjs` (e.g. `auto-code-review-hook.mjs`, `session-end-cleanup-hook.mjs`).
- Shared library modules: lowercase, hyphenated, noun-ish (`auto-review.mjs`, `review-schema.mjs`).
- Reviewer backends: the file basename IS the backend `id` (`exec-generic.mjs` → `id: "exec-generic"`).
- Prompt parts: `auto-<kind>-review.md`; profile files are `profiles/<profile-id>.md`; shared parts are `_`-prefixed (`_verifier-contract.md`).
- Tests: `<area>.test.mjs`, phase-2 work grouped as `phase2-<area>.test.mjs`.
- Commands: `commands/<command-name>.md` — the file basename is the slash-command name.
- Docs: dated reports use a `YYYY-MM-DD` suffix; stable docs are `UPPERCASE-WITH-HYPHENS.md`.

**Directories:**
- Lowercase, hyphenated. The plugin lives at `plugins/<plugin-name>/`; `.claude-plugin/` holds manifests at both repo root and plugin root.

**Code identifiers (observed):**
- Functions / variables: `camelCase` (`dispatchBackgroundReview`, `resolveWorkspaceRoot`).
- Module-level constants: `UPPER_SNAKE_CASE` (`DEFAULT_BACKEND_ID`, `STALE_RUNNING_MS`, `MAX_REVIEWS`).
- Exported "enum-like" arrays: `Object.freeze([...])` named `UPPER_SNAKE` (`REVIEW_VERDICTS`, `BACKEND_IDS`).
- Types are JSDoc `@typedef`s (the codebase is plain JS + JSDoc, no `.ts` files).

## Where to Add New Code

**New reviewer backend:**
- Implementation: `plugins/codex-autoreview/scripts/lib/reviewers/<id>.mjs` exporting a `{ id, capabilities, probe, run, parse }` object that matches the `ReviewerBackend` typedef in `index.mjs`.
- Register it: add the import + registry entry in `plugins/codex-autoreview/scripts/lib/reviewers/index.mjs`.
- Reuse shared codex-exec helpers from `reviewers/exec-shared.mjs` where applicable.
- Tests: a suite under `plugins/codex-autoreview/tests/` (e.g. extend `phase2-dispatch.test.mjs` or add a new `*.test.mjs`).

**New Claude Code hook:**
- Implementation: `plugins/codex-autoreview/scripts/<purpose>-hook.mjs` — parse stdin JSON defensively, gate on `config.enabled` / `isOnboarded` / availability, wrap `main()` in `try/catch`, exit 0.
- Wire it: add an entry in `plugins/codex-autoreview/hooks/hooks.json` using exec form (`command: "node"`, `args: ["${CLAUDE_PLUGIN_ROOT}/scripts/<purpose>-hook.mjs"]`).

**New slash command:**
- Definition: `plugins/codex-autoreview/commands/<name>.md` with YAML front-matter + body.
- Backing logic: add a subcommand handler in `plugins/codex-autoreview/scripts/codex-autoreview.mjs` (or a dedicated script the CLI delegates to, like `doctor.mjs`).

**New shared helper:**
- Add a focused module under `plugins/codex-autoreview/scripts/lib/`. Keep it import-only (no top-level side effects) so the worker and tests can import it freely; gate any `main()` behind an `isRunAsEntrypoint()`-style check if the file is also executable.

**New review profile:**
- Add `plugins/codex-autoreview/prompts/profiles/<profile-id>.md`, then add the id to BOTH `REVIEW_PROFILES` in `lib/review-schema.mjs` and `KNOWN_PROFILES` in `lib/prompts.mjs` (they are intentionally duplicated to keep prompt assembly free of the schema module).

**New state field:**
- Add it to `defaultState()` in `lib/state.mjs`, bump `STATE_VERSION`, and make `loadState` fill it defensively from defaults so older state files still load (the codebase treats every schema change as additive and backward-compatible).

**New tests:**
- Add `plugins/codex-autoreview/tests/<area>.test.mjs` using `node:test`; share fixtures via `tests/helpers.mjs`. Run with `npm test` (from repo root or the plugin dir).

## Special Directories

**`plugins/codex-autoreview/docs/` and `docs/research/`:**
- Purpose: Design docs, implementation plan, audit findings, and the research notes the source cites by filename (e.g. `docs/research/codex-cli.md`).
- Generated: No — hand-written.
- Committed: Yes.

**`.claude-plugin/` (repo root and plugin root):**
- Purpose: Claude Code plugin/marketplace manifests.
- Generated: No.
- Committed: Yes.

**`node_modules/`:**
- Purpose: Dependencies — but the plugin has none declared; both `package.json` files list only Node core usage. Present only if `npm install` is run for tooling.
- Generated: Yes.
- Committed: No (`.gitignore`).

**Per-project state directory (runtime, not in the repo):**
- Purpose: The plugin's own JSON state + per-review log/output files for a *reviewed* project.
- Location: `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/` when Claude Code sets `CLAUDE_PLUGIN_DATA`, else `os.tmpdir()/codex-autoreview/<slug>-<hash>/` (`lib/state.mjs:resolveStateDir`).
- Generated: Yes, at runtime.
- Committed: No — it lives outside any repo.

---

*Structure analysis: 2026-05-14*
