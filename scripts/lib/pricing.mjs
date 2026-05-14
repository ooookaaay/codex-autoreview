/**
 * Token-cost estimation for codex-autoreview.
 *
 * A dated, hardcoded USD-per-1M-token table plus a pure cost calculator. The
 * worker captures real token counts from `codex exec --json` (the
 * `turn.completed.usage` event — see {@link ./reviewers/exec-shared.mjs}) and
 * calls {@link computeCostUsd} to turn them into an estimated `costUsd`.
 *
 * Design rules (verifier-patterns research, F6):
 *   - The table carries a verification date ({@link PRICING_AS_OF}); a stale
 *     table is a soft warning surface, never a hard failure.
 *   - An unknown model is NOT an error: {@link computeCostUsd} returns `null`
 *     with `pricedWith: null` so the review still completes and the cost is
 *     honestly labelled "unknown" downstream. It NEVER throws.
 *   - `cached_input_tokens` is a SUBSET of `input_tokens` (not additive), so
 *     fresh input billed = `input - cached`; cached input is billed at the
 *     cheaper cached rate.
 *
 * Resolution order for the rate of a given model (callers layer this):
 *   per-run flag override → project config override → this table → unknown.
 *
 * @file
 */

/**
 * The date the {@link PRICING_USD_PER_MTOK} table was last verified against
 * OpenAI's published pricing. Surfaced by `/last` / `/doctor` so a stale table
 * is visible. ISO `YYYY-MM-DD`.
 *
 * Source: developers.openai.com/api/docs/pricing — verified 2026-05-14.
 */
export const PRICING_AS_OF = "2026-05-14";

/**
 * Age in days past which the pricing table should be flagged as stale. Used by
 * {@link pricingStaleDays} / {@link isPricingStale}; surfaced as a soft note,
 * never a blocker.
 */
export const PRICING_STALE_AFTER_DAYS = 120;

/**
 * @typedef {object} ModelRate
 * @property {number} in - USD per 1M fresh (uncached) input tokens.
 * @property {number} cachedIn - USD per 1M cached input tokens.
 * @property {number} out - USD per 1M output tokens (includes reasoning tokens).
 */

/**
 * Hardcoded USD-per-1M-token rates, verified {@link PRICING_AS_OF}.
 *
 * NOTE (verifier-patterns research): there is no `gpt-5.5-codex`. Codex CLI
 * v0.130 defaults to `gpt-5.5` (the standard frontier model). The dedicated
 * Codex-tuned public model IDs are `gpt-5.3-codex` / `gpt-5.2-codex`.
 *
 * @type {Readonly<Record<string, ModelRate>>}
 */
export const PRICING_USD_PER_MTOK = Object.freeze({
  "gpt-5.5": { in: 5.0, cachedIn: 0.5, out: 30.0 },
  "gpt-5.4": { in: 2.5, cachedIn: 0.25, out: 15.0 },
  "gpt-5.4-mini": { in: 0.75, cachedIn: 0.075, out: 4.5 },
  "gpt-5.4-nano": { in: 0.2, cachedIn: 0.02, out: 1.25 },
  "gpt-5.3-codex": { in: 1.75, cachedIn: 0.175, out: 14.0 },
  "gpt-5.2-codex": { in: 1.75, cachedIn: 0.175, out: 14.0 }
});

/**
 * Days elapsed since the pricing table was verified.
 *
 * @param {{ now?: number }} [options]
 * @returns {number}
 */
export function pricingStaleDays(options = {}) {
  const now = options.now ?? Date.now();
  const asOf = Date.parse(`${PRICING_AS_OF}T00:00:00Z`);
  if (!Number.isFinite(asOf)) {
    return 0;
  }
  return Math.max(0, Math.floor((now - asOf) / (24 * 60 * 60 * 1000)));
}

/**
 * Whether the hardcoded pricing table is old enough to warrant a soft note.
 *
 * @param {{ now?: number }} [options]
 * @returns {boolean}
 */
export function isPricingStale(options = {}) {
  return pricingStaleDays(options) > PRICING_STALE_AFTER_DAYS;
}

/**
 * Look up the rate for a model id from the hardcoded table.
 *
 * @param {unknown} model
 * @returns {ModelRate | null}
 */
export function getModelRate(model) {
  if (typeof model !== "string" || !model.trim()) {
    return null;
  }
  return PRICING_USD_PER_MTOK[model.trim()] ?? null;
}

/**
 * Validate a user-supplied per-model rate override (`{in, cachedIn, out}`).
 * `cachedIn` is optional and defaults to `in / 10` (the ~10x cache discount
 * OpenAI's published rates follow). Returns a normalized {@link ModelRate} or
 * `null` if the shape is unusable — never throws, so a bad override degrades to
 * "unknown cost" rather than breaking a review.
 *
 * @param {unknown} override
 * @returns {ModelRate | null}
 */
export function normalizeRateOverride(override) {
  if (!override || typeof override !== "object") {
    return null;
  }
  const candidate = /** @type {Record<string, unknown>} */ (override);
  const inRate = Number(candidate.in);
  const outRate = Number(candidate.out);
  if (!Number.isFinite(inRate) || inRate < 0 || !Number.isFinite(outRate) || outRate < 0) {
    return null;
  }
  let cachedIn = Number(candidate.cachedIn);
  if (!Number.isFinite(cachedIn) || cachedIn < 0) {
    cachedIn = inRate / 10;
  }
  return { in: inRate, cachedIn, out: outRate };
}

/**
 * @typedef {object} CostResult
 * @property {number | null} costUsd - Estimated cost in USD, or `null` when the
 *   model rate is unknown. Rounded to 6 decimal places when present.
 * @property {boolean} costEstimated - Always `true` for table/override-derived
 *   costs (the plugin never has authoritative billing data); `false` only when
 *   `costUsd` is `null`.
 * @property {string | null} pricedWith - Provenance label: `PRICING_AS_OF` when
 *   the hardcoded table was used, `"override"` when a caller-supplied rate was
 *   used, or `null` when the model was unknown.
 */

/**
 * Compute the estimated USD cost of one review run from its token usage.
 *
 * NEVER throws and NEVER returns a misleading number: an unknown model (no
 * table entry, no override) yields `{costUsd: null, pricedWith: null}` so the
 * caller can render an honest "cost unknown" instead of `$0`.
 *
 * @param {object} params
 * @param {string} params.model - Resolved model id (e.g. `"gpt-5.5"`). May be
 *   empty/unknown — handled gracefully.
 * @param {object} params.usage - Token counts from `codex exec --json`.
 * @param {number} [params.usage.tokensIn] - Total input tokens (incl. cached).
 * @param {number} [params.usage.tokensCachedIn] - Cached subset of input.
 * @param {number} [params.usage.tokensOut] - Output tokens (incl. reasoning).
 * @param {ModelRate | null} [params.rateOverride] - A caller-resolved rate that
 *   wins over the hardcoded table (per-run flag / project config).
 * @returns {CostResult}
 */
export function computeCostUsd(params) {
  const usage = params && params.usage ? params.usage : {};
  const toCount = (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const tokensIn = toCount(usage.tokensIn);
  const tokensOut = toCount(usage.tokensOut);
  // Cached can never exceed total input.
  const tokensCachedIn = Math.min(toCount(usage.tokensCachedIn), tokensIn);
  const freshIn = Math.max(0, tokensIn - tokensCachedIn);

  const override =
    params && params.rateOverride ? normalizeRateOverride(params.rateOverride) : null;
  const rate = override ?? getModelRate(params ? params.model : null);
  if (!rate) {
    return { costUsd: null, costEstimated: false, pricedWith: null };
  }

  const costUsd =
    (freshIn / 1_000_000) * rate.in +
    (tokensCachedIn / 1_000_000) * rate.cachedIn +
    (tokensOut / 1_000_000) * rate.out;

  return {
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    costEstimated: true,
    pricedWith: override ? "override" : PRICING_AS_OF
  };
}
