import type { CodexUsageEvent } from "./codex-types.js";

/** Current Standard API equivalent, not subscription billing or historical charged rates. */
export const CODEX_PRICE_VERSION = "openai-standard-2026-10-18";
export const CODEX_PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";
export interface CodexCostEstimate {
  usd: number | null;
  basis: "api_equivalent_current_rates";
  price_version: string;
  missing_reason: string | null;
}
// USD / million tokens: net-new input, cache read, cache write, output.
// Unknown/retired model aliases remain unpriced instead of silently borrowing another model's rate.
const PRICES: Record<string, readonly [number, number, number, number]> = {
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-6.1-sol": [2, 0.1, 2.5, 10],
  "gpt-6-sol": [2, 0.2, 2.5, 10],
  "gpt-6-luna": [0.1, 0.01, 0.125, 0.5],
  "gpt-5.6-sol": [4, 0.4, 5, 20],
  "gpt-5.3-codex": [1.75, 0.175, NaN, 14],
};

export function computeCodexCost(e: CodexUsageEvent): CodexCostEstimate {
  const result: CodexCostEstimate = {
    usd: null, basis: "api_equivalent_current_rates", price_version: CODEX_PRICE_VERSION, missing_reason: null,
  };
  const missing = (reason: string): CodexCostEstimate => ({ ...result, missing_reason: reason });
  const p = PRICES[e.model];
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
  if (e.cache_write_input_tokens > 0 && !Number.isFinite(p[2])) return missing("unknown_cache_write_price");
  // Above 272K input the full request uses 2x input/cache and 1.5x output for these models.
  // Older specialized Codex pricing has no such published rule in this snapshot.
  const long = e.input_tokens > 272_000 && e.model !== "gpt-5.3-codex";
  const inputFactor = long ? 2 : 1;
  const outputFactor = long ? 1.5 : 1;
  const uncached = e.input_tokens - e.cached_input_tokens - e.cache_write_input_tokens;
  const writes = e.cache_write_input_tokens > 0 ? e.cache_write_input_tokens * p[2] : 0;
  const usd = ((uncached * p[0] + e.cached_input_tokens * p[1] + writes) * inputFactor + e.output_tokens * p[3] * outputFactor) / 1_000_000;
  return { ...result, usd: Math.round(usd * 1_000_000) / 1_000_000 };
}
