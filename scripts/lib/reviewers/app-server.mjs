/**
 * `app-server` reviewer backend — SCAFFOLD, non-default (Phase 4).
 *
 * Talks to `codex app-server` over JSON-RPC 2.0 / stdio instead of one-shot
 * `codex exec`: `initialize` → `initialized` handshake, then `thread/start` →
 * `review/start {delivery:"detached", target:{type:"uncommittedChanges"|...}}`,
 * consuming `item/completed` `exitedReviewMode` events for the final review.
 *
 * Phase 1 ships ONLY the interface conformance so the registry can already
 * name it and the architecture decision (the app-server backend slots in
 * behind the SAME `probe/run/parse` interface — see
 * `docs/research/external-reviewer-architecture.md` §5) stays a cost decision,
 * not an architectural one. The broker/handshake/thread lifecycle is Phase 4.
 *
 * @file
 */

import { failedParsedReview } from "./exec-shared.mjs";

/** @type {import("./index.mjs").ReviewerBackend} */
export const appServerBackend = {
  id: "app-server",

  capabilities: {
    // App-server yields richer structured review items than `codex exec` text,
    // and real usage — Phase 4 confirms and sets these true.
    structuredOutput: true,
    accurateUsage: true,
    reviewScoped: true,
    claimBased: true
  },

  /**
   * @param {import("./index.mjs").ProbeCtx} _ctx
   * @returns {{ available: boolean, detail: string }}
   */
  probe(_ctx) {
    return {
      available: false,
      detail: "app-server backend is a Phase 1 scaffold — implementation lands in Phase 4"
    };
  },

  /**
   * SCAFFOLD: the JSON-RPC/stdio broker lands in Phase 4.
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
        "app-server backend is a Phase 1 scaffold — implementation lands in Phase 4."
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
