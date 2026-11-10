import type { CodexUsageEvent } from "./codex-types.js";
import { effectiveRates, lookupPrice, priceParts, type PricingTable } from "./pricing.js";

/**
 * Current Standard API equivalent, not subscription billing or historical charged rates.
 * Rates live in the shared price catalog (deploy/pricing.json, hot-reloadable on the server);
 * `price_version` names the catalog snapshot the number was computed from.
 */
export const CODEX_PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";
export interface CodexCostEstimate {
  usd: number | null;
  basis: "api_equivalent_current_rates";
  price_version: string;
  missing_reason: string | null;
}
/** ChatGPT work mode runs the same model under a "-wm" slug (e.g. gpt-6-astra-wm). */
const WORK_MODE_SUFFIX = "-wm";
export const isCodexWorkModeModel = (model: string): boolean =>
  model.endsWith(WORK_MODE_SUFFIX) && model.length > WORK_MODE_SUFFIX.length;
const baseModel = (model: string): string =>
  isCodexWorkModeModel(model) ? model.slice(0, -WORK_MODE_SUFFIX.length) : model;

/** Whether the catalog has a price for this Codex model (work-mode slugs resolve to their base model). */
export function hasCodexPrice(model: string, table: PricingTable): boolean {
  return lookupPrice(table, baseModel(model)) !== null;
}

/**
 * Unknown/retired model aliases remain unpriced instead of silently borrowing another model's rate.
 * Long-context pricing (e.g. 2x input/cache, 1.5x output above 272K input) is a catalog tier, keyed on
 * the full input (`input_tokens` already includes cached and cache-write tokens).
 */
export function computeCodexCost(e: CodexUsageEvent, table: PricingTable, priceVersion: string): CodexCostEstimate {
  const result: CodexCostEstimate = {
    usd: null, basis: "api_equivalent_current_rates", price_version: priceVersion, missing_reason: null,
  };
  const missing = (reason: string): CodexCostEstimate => ({ ...result, missing_reason: reason });
  const p = lookupPrice(table, baseModel(e.model));
  if (!p) return missing("unknown_model");
  if (e.quality_flags.some((flag) => flag === "cached_input_tokens_unreported" || flag === "cache_write_input_tokens_unreported")) {
    return missing("input_breakdown_unavailable");
  }
  const counts = [e.input_tokens, e.cached_input_tokens, e.cache_write_input_tokens, e.output_tokens, e.reasoning_output_tokens, e.total_tokens];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      e.cached_input_tokens + e.cache_write_input_tokens > e.input_tokens ||
      e.reasoning_output_tokens > e.output_tokens || e.total_tokens !== e.input_tokens + e.output_tokens) {
    return missing("invalid_token_partition");
  }
  const uncached = e.input_tokens - e.cached_input_tokens - e.cache_write_input_tokens;
  // reasoning tokens are part of output_tokens: never charge them twice
  const priced = priceParts(effectiveRates(p, e.input_tokens), [
    ["input", uncached],
    ["cache_read", e.cached_input_tokens],
    ["cache_write", e.cache_write_input_tokens],
    ["output", e.output_tokens],
  ]);
  if ("missing" in priced) return missing(priced.missing === "cache_write" ? "unknown_cache_write_price" : `unknown_${priced.missing}_price`);
  return { ...result, usd: Math.round(priced.usd * 1_000_000) / 1_000_000 };
}
