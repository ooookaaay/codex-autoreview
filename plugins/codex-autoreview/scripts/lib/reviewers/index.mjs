/**
 * Reviewer backend registry — the F1 pluggable-reviewer abstraction.
 *
 * A reviewer BACKEND is a plain object implementing a 3-function interface
 * ({@link ReviewerBackend}: `probe` / `run` / `parse`). The detached
 * `review-worker.mjs` no longer calls codex directly — it looks up a backend
 * by `request.backend` and calls those three methods. The worker's
 * hang-protection machinery (terminal-state machine, signal handlers,
 * compare-and-set claim, stale-heal) is byte-for-byte unchanged; only the three
 * codex-coupling points became backend calls.
 *
 * Backends (`scripts/lib/reviewers/<id>.mjs`):
 *   - `exec-generic` — DEFAULT, today's behavior. Generic `codex exec` +
 *     optional `--output-schema`/`--json`. Full claim-based output + real
 *     token usage. The migration default: a queued record with no `backend`
 *     field resolves here, so F1 is non-breaking.
 *   - `exec-review` — SCAFFOLD. `codex exec review` subcommand: well-scoped,
 *     but prose-only + zero usage → DEGRADED structured result.
 *   - `external` — SCAFFOLD (Wave 2B). Arbitrary user CLI as a 2nd reviewer.
 *   - `app-server` — SCAFFOLD (Phase 4). `codex app-server` over JSON-RPC.
 *
 * @file
 */

import { execGenericBackend } from "./exec-generic.mjs";
import { execReviewBackend } from "./exec-review.mjs";
import { externalBackend } from "./external.mjs";
import { appServerBackend } from "./app-server.mjs";

/**
 * @typedef {object} BackendCapabilities
 * @property {boolean} structuredOutput - Can emit the full claim-based F2 JSON
 *   (`--output-schema` or equivalent). When false, `parse` yields a DEGRADED
 *   result (verdict + maybe findings; empty `claims[]`/`unverified[]`).
 * @property {boolean} accurateUsage - Reports real token counts. When false,
 *   `usage` is `null` (NOT a misleading `$0`).
 * @property {boolean} reviewScoped - The backend scopes the review to the
 *   change itself (git diff plumbing built in). When false, the caller must
 *   construct the diff/prompt.
 * @property {boolean} claimBased - Decomposes the change into atomic claims.
 */

/**
 * @typedef {object} ProbeCtx
 * @property {string} cwd - Repo working directory under review.
 * @property {NodeJS.ProcessEnv} env - Process env (a probe may need PATH).
 * @property {object} [backendConfig] - Backend-specific config (e.g. the
 *   `externalCommand` object for the `external` backend).
 */

/**
 * @typedef {object} RunCtx
 * Everything a backend needs to run, backend-agnostic. Built by the worker
 * from the persisted `request` record.
 * @property {string} cwd - Repo working directory under review.
 * @property {string} prompt - The fully-rendered review prompt.
 * @property {"plan" | "code"} kind - Which review this is.
 * @property {string} profile - Review profile id (F2 enum).
 * @property {string | null} [base] - Git base ref, when known (`--base`-style).
 * @property {string} outputFile - Abs path the backend writes its final
 *   message to (mirrors `codex --output-last-message`).
 * @property {string | null} [schemaFile] - Abs path to the F2 JSON Schema file
 *   when structured output is wanted (only honored by structured backends).
 * @property {number} timeoutMs - Hard wall-clock cap for the run.
 * @property {string | null} [model] - Resolved model id, or null for default.
 * @property {string | null} [effort] - Resolved reasoning effort.
 * @property {NodeJS.ProcessEnv} env - Source env; backends pass an allowlisted
 *   subset to any child they spawn.
 * @property {import("../pricing.mjs").ModelRate | null} [rateOverride] - A
 *   caller-resolved pricing rate that wins over the hardcoded table.
 * @property {(pid: number | undefined) => void} onChild - Invoked with the
 *   spawned child pid (and `undefined` on exit) so the worker can reap the
 *   process tree if the worker itself is killed mid-run.
 * @property {object} [backendConfig] - Backend-specific config.
 */

/**
 * @typedef {object} RawRunResult
 * Uniform raw result across backends — what `run` resolves with and `parse`
 * consumes.
 * @property {number} status - Child exit status (or 1 on spawn/signal).
 * @property {string} stdout - Captured stdout (bounded).
 * @property {string} stderr - Captured stderr (bounded).
 * @property {string | null} signal - Killing signal, when killed by one.
 * @property {Error | null} error - Spawn/run error, when any.
 * @property {boolean} timedOut - The hard wall-clock timeout fired.
 * @property {number} timeoutMs - The timeout that was in effect.
 * @property {string} outputFileContent - Trimmed content of `outputFile`, or
 *   `""` when it was never written (the authoritative "did we get a verdict"
 *   signal — never the exit code).
 */

/**
 * @typedef {object} ParsedReview
 * The worker-facing structured review — what `parse` returns and the worker
 * persists. `verdict`/`output` are RENDERED FROM `result` so they are always
 * derived, never hand-rolled.
 * @property {boolean} ok - `false` means the review produced no usable verdict.
 * @property {string | null} verdict - The compact `<VERDICT>: <summary>` line.
 * @property {string | null} output - The compact human-facing review text.
 * @property {import("../review-schema.mjs").ReviewResult | null} result - The
 *   full F2 structured object (persisted under `review.result`).
 * @property {import("../review-schema.mjs").ReviewUsage | null} usage - Token /
 *   cost block, or `null` when the backend has no accurate usage.
 * @property {boolean} degraded - `true` when the structured fields could not
 *   be fully populated (a non-`structuredOutput` backend).
 * @property {string | null} errorMessage - Failure detail when `ok` is false.
 */

/**
 * @typedef {object} ReviewerBackend
 * @property {string} id - Stable backend id (the `request.backend` value).
 * @property {BackendCapabilities} capabilities - Static capability metadata —
 *   lets the worker / Phase 2 decide what to expect WITHOUT running anything.
 * @property {(ctx: ProbeCtx) => { available: boolean, detail: string }} probe
 *   Time-boxed availability check. MUST NOT throw, MUST NOT block.
 * @property {(ctx: RunCtx) => Promise<RawRunResult>} run
 *   Invoke the backend to completion under a hard wall-clock timeout. MUST
 *   spawn detached, enforce `timeoutMs`, kill the tree on timeout, call
 *   `ctx.onChild`, and NEVER throw — return `{timedOut}` / `{error}` instead.
 * @property {(raw: RawRunResult, ctx: RunCtx) => ParsedReview} parse
 *   Turn the raw result into a {@link ParsedReview}. MUST NOT throw.
 */

/** The default backend id — today's behavior; keeps the F1 migration non-breaking. */
export const DEFAULT_BACKEND_ID = "exec-generic";

/**
 * The backend registry: id → {@link ReviewerBackend}.
 * @type {Readonly<Record<string, ReviewerBackend>>}
 */
const REGISTRY = Object.freeze({
  [execGenericBackend.id]: execGenericBackend,
  [execReviewBackend.id]: execReviewBackend,
  [externalBackend.id]: externalBackend,
  [appServerBackend.id]: appServerBackend
});

/** All registered backend ids. @type {readonly string[]} */
export const BACKEND_IDS = Object.freeze(Object.keys(REGISTRY));

/**
 * Look up a reviewer backend by id. An unknown id — or a missing/empty id, as
 * on an old queued record from before F1 — resolves to {@link DEFAULT_BACKEND_ID}
 * so the migration is non-breaking and the worker never crashes on a stale
 * record.
 *
 * @param {string | null | undefined} id
 * @returns {ReviewerBackend}
 */
export function getReviewerBackend(id) {
  if (typeof id === "string" && id && REGISTRY[id]) {
    return REGISTRY[id];
  }
  return REGISTRY[DEFAULT_BACKEND_ID];
}

/**
 * Whether `id` names a registered backend (an exact match, no default
 * fallback). Used by the config command to validate a requested backend.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isKnownBackend(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(REGISTRY, id);
}
