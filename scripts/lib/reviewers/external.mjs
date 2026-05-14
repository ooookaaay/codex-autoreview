/**
 * `external` reviewer backend — SCAFFOLD, non-default.
 *
 * Runs an arbitrary user-configured CLI (e.g. `claude -p`, `gemini`) as a
 * second reviewer. The full implementation is Wave 2B; Phase 1 ships the
 * interface conformance + the documented `externalCommand` config contract so
 * the worker and the registry can already route to it.
 *
 * The `externalCommand` config contract (from
 * `docs/research/external-reviewer-architecture.md` §1) — a single config
 * object the dispatcher persists under `request.backendConfig`:
 *
 * ```jsonc
 * {
 *   "command": "claude",                 // resolved on PATH
 *   "args": ["-p", "--output-format", "json", "--model", "sonnet"],
 *   "promptDelivery": "stdin",           // "stdin" | "file" | "arg"
 *   "outputCapture": "stdout",           // "stdout" | "file"
 *   "outputFormat": "json",              // "json" | "text"
 *   "resultPath": "result",              // dot-path into JSON → verdict text
 *   "timeoutMs": 240000,
 *   "env": ["HOME", "PATH"]              // explicit allowlist (privacy)
 * }
 * ```
 *
 * Placeholders substituted in every `args[]` element AND exported as env vars:
 *   `{prompt}` `{promptFile}` `{outputFile}` `{cwd}` `{kind}` `{base}`.
 *
 * Three-tier output handling (the structured-output strategy):
 *   1. native schema flag → pass the plugin's F2 schema (gold path);
 *   2. native JSON envelope → extract via `resultPath`, then tier 3;
 *   3. prompt-enforced text contract → `fromVerdictLine` parses the verdict
 *      line (the universal floor — every tool supports it).
 *
 * @file
 */

import { failedParsedReview } from "./exec-shared.mjs";

/**
 * Validate the shape of an `externalCommand` config object. Returns a list of
 * human-readable problems (empty = valid). Phase 2's `run` calls this first;
 * exposed now so the config command / `/doctor` can validate without running.
 *
 * @param {unknown} config
 * @returns {string[]}
 */
export function validateExternalConfig(config) {
  /** @type {string[]} */
  const problems = [];
  if (!config || typeof config !== "object") {
    return ["externalCommand config must be an object."];
  }
  const cfg = /** @type {Record<string, unknown>} */ (config);
  if (typeof cfg.command !== "string" || !cfg.command.trim()) {
    problems.push("`command` is required and must be a non-empty string.");
  }
  if (cfg.args != null && !Array.isArray(cfg.args)) {
    problems.push("`args` must be an array of strings when present.");
  } else if (Array.isArray(cfg.args) && cfg.args.some((a) => typeof a !== "string")) {
    problems.push("`args` must contain only strings.");
  }
  const deliveries = ["stdin", "file", "arg"];
  if (cfg.promptDelivery != null && !deliveries.includes(String(cfg.promptDelivery))) {
    problems.push(`\`promptDelivery\` must be one of: ${deliveries.join(", ")}.`);
  }
  const captures = ["stdout", "file"];
  if (cfg.outputCapture != null && !captures.includes(String(cfg.outputCapture))) {
    problems.push(`\`outputCapture\` must be one of: ${captures.join(", ")}.`);
  }
  const formats = ["json", "text"];
  if (cfg.outputFormat != null && !formats.includes(String(cfg.outputFormat))) {
    problems.push(`\`outputFormat\` must be one of: ${formats.join(", ")}.`);
  }
  if (cfg.promptDelivery === "arg" && Array.isArray(cfg.args)) {
    if (!cfg.args.some((a) => typeof a === "string" && a.includes("{prompt}"))) {
      problems.push('`promptDelivery: "arg"` requires `{prompt}` to appear in `args`.');
    }
  }
  if (cfg.env != null && !Array.isArray(cfg.env)) {
    problems.push("`env` must be an array of env-var-name strings (allowlist).");
  }
  return problems;
}

/** @type {import("./index.mjs").ReviewerBackend} */
export const externalBackend = {
  id: "external",

  capabilities: {
    // Depends on the configured tool; the conservative default is the
    // universal floor (prompt-enforced text contract). Phase 2 refines these
    // per resolved tool capability.
    structuredOutput: false,
    accurateUsage: false,
    reviewScoped: false,
    claimBased: false
  },

  /**
   * @param {import("./index.mjs").ProbeCtx} ctx
   * @returns {{ available: boolean, detail: string }}
   */
  probe(ctx) {
    const config = ctx.backendConfig ?? {};
    const command =
      config && typeof config === "object" && typeof config.command === "string"
        ? config.command
        : null;
    if (!command) {
      return {
        available: false,
        detail: "external backend is not configured (no `command`)"
      };
    }
    // Phase 2 runs `<command> --version`; Phase 1 only reports config validity.
    const problems = validateExternalConfig(config);
    return problems.length === 0
      ? { available: false, detail: "external backend scaffold — wiring lands in Wave 2B" }
      : { available: false, detail: `external backend config invalid: ${problems[0]}` };
  },

  /**
   * SCAFFOLD: full placeholder-substitution + three-tier output handling lands
   * in Wave 2B.
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
        "external backend is a Phase 1 scaffold — full implementation lands in Wave 2B."
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
    return failedParsedReview(detail || "external backend is not yet implemented.");
  }
};
