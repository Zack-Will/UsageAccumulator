import type { UsageEvent } from "./types.js";

/** 单位一律「美元 / 百万 token」。 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
}

export type PricingTable = Record<string, ModelPrice>;

/**
 * 刻意不内置任何写死的价格。
 *
 * 价格会变，且我没有 Claude 5 系列的权威报价；凭印象填进来会让所有成本统计
 * 静默出错，比缺价格危险得多。正确做法是从 LiteLLM 的 model_prices JSON 拉取
 * 快照存到 pricing.json，由 loadPricingTable() 注入。
 *
 * 模型不在表里时 computeCostUsd 返回 null（而不是 0 或猜一个值），
 * 调用方必须显式处理「成本未知」这个状态。
 */
export const EMPTY_PRICING: PricingTable = {};

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWrite5mUsd: number;
  cacheWrite1hUsd: number;
  totalUsd: number;
}

export function computeCostUsd(
  e: Pick<
    UsageEvent,
    | "model"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWrite5mTokens"
    | "cacheWrite1hTokens"
  >,
  table: PricingTable,
): CostBreakdown | null {
  const p = table[e.model] ?? table[normalizeModel(e.model)];
  if (!p) return null;
  const per = (tok: number, rate: number) => (tok / 1_000_000) * rate;
  const inputUsd = per(e.inputTokens, p.inputPerMTok);
  const outputUsd = per(e.outputTokens, p.outputPerMTok);
  const cacheReadUsd = per(e.cacheReadTokens, p.cacheReadPerMTok);
  const cacheWrite5mUsd = per(e.cacheWrite5mTokens, p.cacheWrite5mPerMTok);
  const cacheWrite1hUsd = per(e.cacheWrite1hTokens, p.cacheWrite1hPerMTok);
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWrite5mUsd,
    cacheWrite1hUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWrite5mUsd + cacheWrite1hUsd,
  };
}

/**
 * 模型名归一化。v1 只做最小处理：剥掉第三方网关加的后缀（如 `claude-opus-5[1m]`）。
 * 套壳客户端（codewiz-cc）的命名规则等 v2 拿到真实样本再补，见 ARCHITECTURE.md §14。
 */
export function normalizeModel(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").trim();
}
