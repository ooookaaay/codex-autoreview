/**
 * `app-server` reviewer backend — DOCUMENTED STUB, non-default (Phase 4).
 *
 * Talks to `codex app-server` over JSON-RPC 2.0 / stdio instead of one-shot
 * `codex exec`: `initialize` → `initialized` handshake, then `thread/start` →
 * `review/start {delivery:"detached", target:{type:"uncommittedChanges"|...}}`,
 * consuming `item/completed` `exitedReviewMode` events for the final review
 * (transport & lifecycle per `docs/research/external-reviewer-architecture.md`
 * §5).
 *
 * Wave 2B scaffolds the JSON-RPC SHAPE — the request builders and the event
 * matcher below are the real wire shapes — so Phase 4 only has to wire the
 * stdio broker (handshake, persistent child, notification pump, wall-clock
 * timeout) behind the SAME `probe/run/parse` interface. The architecture
 * decision (app-server slots in as the 4th backend with no re-architecting)
 * stays a cost decision, not an open question. `run` is intentionally still a
 * clear "not yet wired" path — the broker lifecycle is Phase 4.
 *
 * @file
 */

import { failedParsedReview } from "./exec-shared.mjs";

/** JSON-RPC protocol version the app-server speaks. */
export const JSONRPC_VERSION = "2.0";

/**
 * Build the `initialize` JSON-RPC request — the FIRST message a client must
 * send; the server replies, emits `initialized`, and only then accepts other
 * methods. `clientInfo` identifies the plugin to the server.
 *
 * @param {object} params
 * @param {number} params.id - JSON-RPC request id.
 * @param {string} [params.clientName]
 * @param {string} [params.clientVersion]
 * @returns {object} a JSON-RPC request object (newline-delimit when writing it)
 */
export function buildInitializeRequest(params) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: params.id,
    method: "initialize",
    params: {
      clientInfo: {
        name: params.clientName ?? "codex-autoreview",
        version: params.clientVersion ?? "0.2.0"
      }
    }
  };
}

/**
 * Build the `thread/start` JSON-RPC request — creates the conversation the
 * review will attach to. Its response carries the `threadId` that
 * {@link buildReviewStartRequest} then targets.
 *
 * @param {object} params
 * @param {number} params.id
 * @param {string} params.cwd - Repo working directory for the thread.
 * @returns {object}
 */
export function buildThreadStartRequest(params) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: params.id,
    method: "thread/start",
    params: {
      cwd: params.cwd
    }
  };
}

/**
 * Map the plugin's review `kind` (+ optional base ref) to a `review/start`
 * `target` object. For `code` the target is the uncommitted working-tree
 * changes (matches the plugin's code-review use case exactly), unless a base
 * ref is known. For `plan` there is no diff — the target is `custom`,
 * free-form instructions (the plan-review use case).
 *
 * @param {"plan" | "code"} kind
 * @param {string | null} [base]
 * @returns {object} a `review/start` `target`
 */
export function buildReviewTarget(kind, base = null) {
  if (kind === "plan") {
    return { type: "custom" };
  }
  if (base) {
    return { type: "baseBranch" };
  }
  return { type: "uncommittedChanges" };
}

/**
 * Build the `review/start` JSON-RPC request. `delivery: "detached"` forks a
 * clean, isolated review thread per run (the right choice for the plugin —
 * never mutates the user's working thread). The custom review instructions
 * (the plugin's profile prompt) ride along so the review uses the plugin's
 * versioned policy, not an ad-hoc prompt.
 *
 * @param {object} params
 * @param {number} params.id
 * @param {string} params.threadId - From the `thread/start` response.
 * @param {"plan" | "code"} params.kind
 * @param {string | null} [params.base]
 * @param {string} [params.prompt] - Custom review instructions.
 * @returns {object}
 */
export function buildReviewStartRequest(params) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: params.id,
    method: "review/start",
    params: {
      threadId: params.threadId,
      delivery: "detached",
      target: buildReviewTarget(params.kind, params.base ?? null),
      ...(params.prompt ? { instructions: params.prompt } : {})
    }
  };
}

/**
 * Whether a streamed JSON-RPC notification is the TERMINAL review event — an
 * `item/completed` carrying an `exitedReviewMode` item. That item holds the
 * final review text the backend's `parse` consumes; its arrival (followed by
 * the turn going `completed`) ends the run.
 *
 * @param {unknown} message - A parsed JSON-RPC notification.
 * @returns {boolean}
 */
export function isExitedReviewModeEvent(message) {
  if (!message || typeof message !== "object") {
    return false;
  }
  const msg = /** @type {Record<string, any>} */ (message);
  return (
    msg.method === "item/completed" &&
    msg.params &&
    typeof msg.params === "object" &&
    msg.params.item &&
    typeof msg.params.item === "object" &&
    msg.params.item.type === "exitedReviewMode"
  );
}

/**
 * Pull the final review text out of an `exitedReviewMode` `item/completed`
 * notification. Returns `""` when the shape is not as expected.
 *
 * @param {unknown} message
 * @returns {string}
 */
export function extractReviewTextFromEvent(message) {
  if (!isExitedReviewModeEvent(message)) {
    return "";
  }
  const item = /** @type {Record<string, any>} */ (message).params.item;
  // The review payload lives under the item; tolerate a couple of shapes
  // (`item.review.text`, `item.text`) since the wire shape is documented
  // loosely upstream — Phase 4 pins this against a live server.
  const review = item.review && typeof item.review === "object" ? item.review : null;
  if (review && typeof review.text === "string") {
    return review.text;
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  return "";
}

/** @type {import("./index.mjs").ReviewerBackend} */
export const appServerBackend = {
  id: "app-server",

  capabilities: {
    // App-server yields richer structured review items than `codex exec` text,
    // and real usage — Phase 4 confirms and sets these true once the broker is
    // wired against a live server.
    structuredOutput: true,
    accurateUsage: true,
    reviewScoped: true,
    claimBased: true
  },

  /**
   * STUB: the live probe spawns `codex app-server` and runs the
   * `initialize`/`initialized` handshake under a short timeout — available iff
   * the handshake succeeds. The broker lifecycle is Phase 4, so Wave 2B
   * reports the backend as not-yet-available rather than half-probing it.
   *
   * @param {import("./index.mjs").ProbeCtx} _ctx
   * @returns {{ available: boolean, detail: string }}
   */
  probe(_ctx) {
    return {
      available: false,
      detail:
        "app-server backend is a documented stub — the JSON-RPC/stdio broker lands in Phase 4"
    };
  },

  /**
   * STUB: the live `run` keeps a `codex app-server` stdio child alive for the
   * call (`thread/start` → `review/start` → notification pump until
   * `exitedReviewMode` + turn `completed`), under a hard wall-clock timeout
   * with a tree-kill on hang. The request builders above are the real wire
   * shapes Phase 4 sends.
   *
   * @param {import("./index.mjs").RunCtx} _ctx
   * @returns {Promise<import("./index.mjs").RawRunResult>}
   */
  async run(_ctx) {
    return {
      status: 1,
      stdout: "",
      stderr: "",
      signal: null,
      error: new Error(
        "app-server backend is a documented stub — the JSON-RPC/stdio broker lands in Phase 4."
      ),
      timedOut: false,
      timeoutMs: 0,
      outputFileContent: ""
    };
  },

  /**
   * @param {import("./index.mjs").RawRunResult} raw
   * @param {import("./index.mjs").RunCtx} _ctx
   * @returns {import("./index.mjs").ParsedReview}
   */
  parse(raw, _ctx) {
    const detail =
      raw.error && (raw.error instanceof Error ? raw.error.message : String(raw.error));
    return failedParsedReview(detail || "app-server backend is not yet implemented.");
  }
};
