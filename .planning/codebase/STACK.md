# Technology Stack

**Analysis Date:** 2026-05-14

## Languages

**Primary:**
- JavaScript (ESM, `.mjs`) — all plugin runtime code under `plugins/codex-autoreview/scripts/` (hooks, library modules, reviewer backends, CLI, statusline, worker). Every source file is a native ES module; `package.json` sets `"type": "module"`.

**Secondary:**
- Markdown — slash-command definitions (`plugins/codex-autoreview/commands/*.md`) and review prompt templates (`plugins/codex-autoreview/prompts/**/*.md`). These are data/config consumed by the runtime, not compiled.
- JSON — plugin/marketplace manifests and hook wiring (`.claude-plugin/marketplace.json`, `plugins/codex-autoreview/.claude-plugin/plugin.json`, `plugins/codex-autoreview/hooks/hooks.json`).
- TOML (read-only, partial) — the plugin extracts ONLY the top-level `model = "..."` key from the user's `~/.codex/config.toml` via a hand-rolled line scanner in `scripts/lib/codex.mjs` (`readUserCodexDefaultModel`). It is deliberately NOT a TOML parser and pulls in no TOML dependency.

## Runtime

**Environment:**
- Node.js `>=18.18.0` — declared in `engines` of both `package.json` (repo root) and `plugins/codex-autoreview/package.json`. The plugin relies on Node 18+ built-ins only (`node:test`, `fs.realpathSync.native`, `Atomics.wait`, `SharedArrayBuffer`).

**Package Manager:**
- npm (implied — `npm test` scripts, no alternate lockfile manager configured).
- Lockfile: none committed. There are zero third-party runtime or dev dependencies, so a lockfile would be empty; `node_modules/` is gitignored.

## Frameworks

**Core:**
- None. The plugin is a Claude Code plugin — its "framework" is the Claude Code plugin/hook contract itself, expressed declaratively in `plugins/codex-autoreview/hooks/hooks.json` (SessionStart, PreToolUse, Stop, UserPromptSubmit, SessionEnd hooks) and `plugins/codex-autoreview/.claude-plugin/plugin.json`.

**Testing:**
- `node:test` (Node's built-in test runner) — no Jest/Vitest/Mocha. Test command: `node --test tests/*.test.mjs` (`plugins/codex-autoreview/package.json`). Assertions use the built-in `node:assert`.
- Test fixtures live in `plugins/codex-autoreview/tests/helpers.mjs` (temp dirs, git repo init, a fake `codex` CLI shim so tests never touch the real Codex).

**Build/Dev:**
- None. No bundler, transpiler, or build step — `.mjs` files run directly under Node. No `tsconfig.json`, no `.eslintrc`/`.prettierrc`, no Babel.

## Key Dependencies

**Critical:**
- Zero npm dependencies. `plugins/codex-autoreview/package.json` has no `dependencies` or `devDependencies` blocks at all. This is a deliberate posture — minimal dependency closure for a security-sensitive review plugin.

**Node built-ins used (the de facto dependency surface):**
- `node:child_process` — `spawn` / `spawnSync` for the `codex` CLI and external reviewers (`scripts/lib/codex.mjs`, `scripts/lib/process.mjs`, `scripts/lib/reviewers/external.mjs`).
- `node:fs` — state persistence, atomic writes, lock files (`scripts/lib/state.mjs`).
- `node:crypto` — `createHash("sha256")` for diff fingerprints, plan hashes, and workspace-dir slugs (`scripts/lib/git.mjs`, `scripts/lib/state.mjs`).
- `node:os` — tmpdir / homedir resolution.
- `node:path`, `node:process`, `node:url` — pathing and `import.meta.url` resolution.

**Infrastructure:**
- The `codex` CLI (external binary, not an npm package) — see INTEGRATIONS.md. Validated against `codex-cli 0.130.0` per in-code comments.

## Configuration

**Environment:**
- `CLAUDE_PLUGIN_ROOT` — injected by Claude Code; every hook in `hooks/hooks.json` passes it as a literal `args[]` element to locate plugin scripts.
- `CLAUDE_PLUGIN_DATA` — optional; when set, per-workspace state lives under `<CLAUDE_PLUGIN_DATA>/state/`. Otherwise state falls back to `<os.tmpdir()>/codex-autoreview/` (`scripts/lib/state.mjs`, `resolveStateDir`).
- `CODEX_HOME` — read to locate the user's `~/.codex` (auth + `config.toml`); honored in `scripts/lib/codex.mjs`.
- The `codex` child process receives only an allowlisted env subset (`CODEX_ENV_ALLOWLIST` in `scripts/lib/codex.mjs`) — secret-bearing vars are never forwarded.
- `.env` / `.env.*` are gitignored and the plugin NEVER reads them — this is part of its own stated threat model (`.gitignore` comment).

**Per-project state config:**
- Persisted JSON state at `<state-dir>/state.json`, schema version 2 (`scripts/lib/state.mjs`). Config keys: `enabled`, `model`, `effort`, `timeoutMs`, `backend`, `backendConfig`, `profile`, `pricing`, `dismissedFindings`, `onboardedAt`. Managed via `/codex-autoreview:config`.

**Build:**
- No build config files. `package.json` (root) `scripts.test` delegates to the plugin's own test script via `npm test --prefix plugins/codex-autoreview`.

## Platform Requirements

**Development:**
- Node.js >= 18.18.0, Git, and the `codex` CLI installed and logged in.
- Cross-platform aware: `scripts/lib/process.mjs` switches `shell` behavior on `win32`; `CODEX_ENV_ALLOWLIST` includes Windows-specific vars (`SYSTEMROOT`, `WINDIR`, `APPDATA`, etc.); `spawn` calls pass `windowsHide: true`.

**Production:**
- Distributed as a Claude Code plugin via a single-plugin marketplace (`.claude-plugin/marketplace.json`, version `0.3.0`). Source path `./plugins/codex-autoreview`. License: Apache-2.0. Homepage/repo: `https://github.com/ooookaaay/codex-autoreview`.
- No server, no container, no hosting — it runs in-process inside the user's Claude Code session plus detached local Node worker processes.

---

*Stack analysis: 2026-05-14*
