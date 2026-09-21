import { readFileSync } from "node:fs";
import { z } from "zod";
import { EMPTY_PRICING, computeCostUsd, normalizeModel, type PricingTable } from "@ua/core";

/**
 * 定价表**注入**，不内置。
 *
 * `@ua/core/pricing.ts` 刻意留空表：价格会变，且没有权威来源，凭印象填会让所有
 * 成本统计静默出错。服务端从 deploy/pricing.json 读一份快照注入；模型不在表里时
 * cost 返回 null（不是 0），调用方必须显式处理「成本未知」。
 *
 * 文件格式（两种都接受）：
 *   { "claude-opus-5": { "inputPerMTok": 15, ... } }
 *   { "_comment": "...", "models": { "claude-opus-5": { ... } } }
 */
const priceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  // 5m 与 1h 单价不同（实测 87.8% 的缓存写入是 1h），必须分列
  cacheWrite5mPerMTok: z.number().nonnegative(),
  cacheWrite1hPerMTok: z.number().nonnegative(),
});

const fileSchema = z.union([
  z.object({ models: z.record(priceSchema) }).passthrough(),
  z.record(z.union([priceSchema, z.unknown()])),
]);

/** 纯函数：把 pricing.json 的内容解析成 PricingTable。解析失败返回空表而不是抛。 */
export function parsePricingFile(raw: unknown): { table: PricingTable; errors: string[] } {
  const errors: string[] = [];
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    return { table: { ...EMPTY_PRICING }, errors: ["pricing file is not an object"] };
  }
  const obj = parsed.data as Record<string, unknown>;
  const source = (obj["models"] && typeof obj["models"] === "object"
    ? obj["models"]
    : obj) as Record<string, unknown>;

  const table: PricingTable = {};
  for (const [model, value] of Object.entries(source)) {
    if (model.startsWith("_") || model.startsWith("$")) continue; // 允许 _comment 之类的说明键
    const p = priceSchema.safeParse(value);
    if (!p.success) {
      errors.push(`model "${model}": ${p.error.issues[0]?.message ?? "invalid price entry"}`);
      continue;
    }
    table[model] = p.data;
    // 顺手把归一化后的名字也登记上，网关加的后缀（claude-opus-5[1m]）才能命中
    const norm = normalizeModel(model);
    if (norm !== model && !table[norm]) table[norm] = p.data;
  }
  return { table, errors };
}

export function loadPricingTable(path: string): { table: PricingTable; errors: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { table: { ...EMPTY_PRICING }, errors: [`pricing file not found: ${path}`] };
  }
  try {
    return parsePricingFile(JSON.parse(text) as unknown);
  } catch {
    return { table: { ...EMPTY_PRICING }, errors: [`pricing file is not valid JSON: ${path}`] };
  }
}

/** 合成标记，实测 43 条。必须排除在计费与限额统计之外。 */
export const SYNTHETIC_MODEL = "<synthetic>";

export function countsTowardQuota(model: string): boolean {
  return model !== SYNTHETIC_MODEL;
}

/**
 * 事件成本。缺价返回 null，`<synthetic>` 也返回 null —— 合成事件根本不该计费。
 */
export function eventCostUsd(
  e: Parameters<typeof computeCostUsd>[0],
  table: PricingTable,
): number | null {
  if (!countsTowardQuota(e.model)) return null;
  const breakdown = computeCostUsd(e, table);
  return breakdown ? breakdown.totalUsd : null;
}
