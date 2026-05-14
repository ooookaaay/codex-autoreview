# Coding Conventions

**Analysis Date:** 2026-05-14

## Naming Patterns

**Files:**
- All source is `.mjs` (native ESM, `"type": "module"`). No `.js`, `.ts`, `.cjs`.
- Library modules: lowercase, single word or `kebab-case` — `codex.mjs`, `state.mjs`, `auto-review.mjs`, `review-schema.mjs`.
- Hook entry points: `<event>-hook.mjs` suffix — `auto-code-review-hook.mjs`, `onboarding-hook.mjs`, `session-end-cleanup-hook.mjs`, `surface-verdict-hook.mjs`, `pre-push-review-hook.mjs`.
- Reviewer backends: one file per backend id under `scripts/lib/reviewers/`, named after the id — `exec-generic.mjs`, `exec-review.mjs`, `external.mjs`, `app-server.mjs`, plus `index.mjs` (registry) and `exec-shared.mjs` (shared helpers).
- Test files: `<area>.test.mjs` under `tests/` — `foundation.test.mjs`, `phase2-cli.test.mjs`, `phase2-dispatch.test.mjs`. Non-test shared code in `tests/` is `helpers.mjs` (no `.test` infix).

**Functions:**
- `camelCase` for all functions — `resolveReviewModel`, `buildCodexExecArgs`, `parseCodexJsonStream`, `dispatchBackgroundReview`.
- Verb-first names that state intent: `resolve*` (config-to-value resolution), `build*` (construct an args vector / env / string), `parse*` (raw output → structured), `normalize*` (validate + canonicalize user input, throw on bad), `is*`/`has*` (boolean predicates), `get*`/`list*` (read accessors), `ensure*` (idempotent setup).
- Each `.mjs` file has a `main()` for the entry-point scripts; helpers are module-scoped functions above it.

**Variables:**
- `camelCase` for locals and parameters.
- `UPPER_SNAKE_CASE` for module-level constants — `STATE_VERSION`, `MAX_REVIEWS`, `LOCK_STALE_MS`, `DEFAULT_REVIEW_EFFORT`, `CODEX_ENV_ALLOWLIST`.
- Exported constants are also `UPPER_SNAKE_CASE` and frozen when they are collections: `Object.freeze([...])` — see `VALID_REASONING_EFFORTS`, `CODEX_ENV_ALLOWLIST`, `TERMINAL_STATUSES` in `scripts/lib/codex.mjs` and `scripts/lib/state.mjs`.
- Numeric literals use digit separators for readability: `240_000`, `256 * 1024`, `30_000`.

**Types:**
- No TypeScript. Types are expressed entirely via JSDoc `@typedef` / `@param` / `@returns`.
- `@typedef` objects are `PascalCase` — `AutoReviewConfig`, `ReviewRecord`, `ReviewGap`, `DismissedFinding`, `BackendCapabilities`, `CodexJsonStreamResult`.
- Cross-module type references use the import-path form: `import("./review-schema.mjs").ReviewResult`.

## Code Style

**Formatting:**
- No Prettier / ESLint / Biome config present (`ls .eslintrc* .prettierrc* eslint.config.*` → none). Style is enforced by convention and review, not tooling.
- 2-space indentation throughout.
- Double quotes for all strings — `"node:fs"`, `"exec-generic"`. Single quotes appear only inside string literals that contain double quotes (e.g. embedded JSON in `tests/helpers.mjs`).
- Semicolons always.
- Trailing commas are NOT used in multi-line arrays/objects/arg lists — last element has no comma (see `buildCodexExecArgs`, `defaultState`).
- Lines kept roughly within ~90 chars; long strings are split with `+` concatenation across lines.

**Linting:**
- None configured. The `package.json` `test` script is the only quality gate: `node --test tests/*.test.mjs`.

## Import Organization

**Order** (blank line between groups):
1. Node built-ins, each with the `node:` prefix — `import fs from "node:fs";`, `import { spawn } from "node:child_process";`. Always `node:`-prefixed, never bare `fs`.
2. Internal modules, relative paths with explicit `.mjs` extension — `import { binaryAvailable } from "./process.mjs";`.

- Named imports are sorted alphabetically within a multi-line `import { ... }` block.
- Test files add a third grouping: built-ins, then `./helpers.mjs`, then the modules under test (often with a `// F1 — ...` section comment before each cluster).

**Path Aliases:**
- None. All internal imports are relative (`./lib/...`, `../scripts/lib/...`). No bundler, no `paths` mapping.

## Error Handling

**Hooks must never throw — "a hook must never block the session":**
- Every hook entry file ends with a top-level `try { main(); } catch (error) { ... process.exitCode = 1; }` wrapper (see `scripts/auto-code-review-hook.mjs:171`). The detached worker uses the async equivalent: `main().catch((error) => { ... })` (`scripts/review-worker.mjs:692`).
- Inside hooks, defensive `catch {}` (empty catch) is the dominant pattern — ~50 occurrences across `scripts/`. Used wherever a failure must degrade to a clean no-op: unreadable stdin, malformed JSON, missing file, a bad callback. Each empty catch carries a one-line comment explaining what is being swallowed and why ("Malformed JSON on stdin — a clean no-op, never a crash.").
- Functions that read external state (`readUserCodexDefaultModel`, `resolveProjectInstructionsPath`, `loadState`) are documented as **NEVER throws** and return `null` / a default on any problem.

**`normalize*` functions are the exception — they DO throw:**
- User-supplied config values are validated by `normalize*` helpers that `throw new Error(...)` with an actionable message on bad input — `normalizeReasoningEffort`, `normalizeTimeoutMs`, `normalizeModel` in `scripts/lib/codex.mjs`. Empty/absent input returns `null` ("clear the override"); invalid input throws.

**Process-level guarantees:**
- `runCodexReview` (`scripts/lib/codex.mjs`) returns a Promise that **always resolves** (never rejects) — spawn failure, timeout, and signal-kill are all mapped into the resolved result object (`{ status, stdout, stderr, signal, error, timedOut, timeoutMs }`).
- `killProcessTree` is best-effort: tries the process group, falls back to the direct pid, swallows "already dead".

## Logging

**Framework:** None. Plain `process.stderr.write(...)`.
- Hooks log human-facing notes through a local `logNote(message)` helper that writes one line to stderr and no-ops on empty input.
- All user-facing log lines are prefixed `codex-autoreview: ` so they are attributable in Claude's hook output.
- stdout is reserved for protocol/contract output (CLI verdict text, statusline segment); diagnostics go to stderr.
- The worker appends to a per-review log file via an `appendLog(logFile, message)` helper.

## Comments

**When to Comment:**
- Comments are heavy and intentional. They explain **why**, not what — design rationale, threat-model reasoning, and cross-version facts (e.g. "verified against `codex-cli 0.130.0`").
- Every module starts with a `/** ... @file */` block describing the module's purpose and key design decisions. Adapted-from-`codex-plugin-cc` modules cite their provenance and the Apache-2.0 license in that block (see `scripts/lib/state.mjs:1`).
- Every empty `catch {}` has an inline comment justifying the swallow.
- Module-level constants get a full doc comment explaining the chosen value (see `DEFAULT_REVIEW_EFFORT`, `LOCK_STALE_MS`).
- Section dividers in larger files use a `// ----...` or `// ===...` rule with a heading.

**JSDoc/TSDoc:**
- JSDoc is mandatory on every exported function and every non-trivial internal function — `@param`, `@returns`, and `@typedef` for object shapes.
- `@param` types use the TS-in-JSDoc syntax: `{string | null}`, `{Record<string, unknown>}`, `{{ model?: unknown }}`, `{NodeJS.ProcessEnv}`.
- Inline `/** @type {...} */` casts annotate otherwise-untyped locals — `/** @type {ReviewRecord[]} */ const nonTerminal = [];`.
- `{@link OtherFunction}` cross-references are used liberally to tie related functions together.

## Function Design

**Size:** Functions are focused and single-purpose. Larger functions (`runCodexReview`, `withStateLock`, `reconcileAndPruneReviews`) are the exception and are heavily commented, broken into clearly-labeled internal steps.

**Parameters:**
- A function taking more than ~2 arguments takes a single **options/params object**, destructured or accessed by key — `buildCodexExecArgs(params)`, `dispatchBackgroundReview({ cwd, kind, ... })`, `runCodexReview(params)`.
- Optional options objects default to `{}` — `function getCodexAvailability(cwd, options = {})`.
- Booleans and tunables are passed by name in the options object, never positionally.

**Return Values:**
- Functions return **plain result objects**, not throw, for expected-failure cases — `{ available: boolean, detail: string }`, `{ applied: boolean }`, `{ dispatched, deduped, reviewId, detail }`.
- `null` is the canonical "absent / use default" value (never `undefined` for that meaning).
- Predicates return real booleans, often via `Boolean(...)` to coerce.

## Module Design

**Exports:**
- Named exports only — `export function`, `export const`. No `export default` anywhere in `scripts/`.
- A module exports its public functions, its typedefs (via JSDoc), and its tunable constants so tests can assert against them.
- Entry-point scripts (`codex-autoreview.mjs`, `review-worker.mjs`, `statusline.mjs`) ALSO export their internal helpers (e.g. `buildStatuslineSegment`) for direct unit testing, then run `main()` only under a main-guard.

**Main-guard pattern:**
- Scripts that are both importable and runnable detect "run as entry point" before invoking `main()`. Two forms in use:
  - `if (import.meta.url === \`file://${process.argv[1]}\`) { ... }` — `scripts/statusline.mjs:233`.
  - An `isRunAsEntrypoint()` helper comparing `path.resolve(process.argv[1])` to `fileURLToPath(import.meta.url)` — `scripts/review-worker.mjs:681`.
- This is what lets the test suite import `main`-bearing modules without executing them.

**Barrel Files:**
- One deliberate registry barrel: `scripts/lib/reviewers/index.mjs` imports the four backend modules and exposes `BACKEND_IDS`, `DEFAULT_BACKEND_ID`, `getReviewerBackend`, `isKnownBackend`. New backends are added there.
- No general-purpose `index.mjs` barrels elsewhere — modules are imported directly by path.

**Adapted-code provenance:**
- Modules ported from the sibling `codex-plugin-cc` project (e.g. `state.mjs`) keep an explicit `@file` note crediting OpenAI / Apache-2.0 and pointing at `../../NOTICE`. Preserve this when extending such files.

---

*Convention analysis: 2026-05-14*
