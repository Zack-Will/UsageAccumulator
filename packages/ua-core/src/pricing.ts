import type { UsageEvent } from "./types.js";

/**
 * 模型价格目录。单位一律「美元 / 百万 token」。
 *
 * 刻意不内置任何写死的价格：价格会变，凭印象填会让所有成本统计静默出错，
 * 比缺价危险得多。价格是**数据**，由服务端从 pricing.json 读入（可热加载），
 * 模型不在表里时成本返回 null（不是 0），调用方必须显式处理「成本未知」。
 *
 * 这里只放解析、校验与计算，零依赖 —— 探针会把 @ua/core 打包成单文件。
 *
 * 一个模型的条目（v2）：
 *   {
 *     "input": 8, "output": 40, "cache_read": 0.2, "cache_write_5m": 10, "cache_write_1h": 16,
 *     "tiers": [{ "prompt_over": 272000, "multiply": { "input": 2, "output": 1.5 } }],
 *     "aliases": ["some-gateway-name"], "source": "…", "verified_at": "2026-11-10"
 *   }
 * 旧格式（inputPerMTok / outputPerMTok / cacheReadPerMTok / cacheWrite5mPerMTok / cacheWrite1hPerMTok）照收。
 */

/** cache_write 是不分 TTL 的写入单价（Codex）；Claude 的写入分 5m / 1h 两档，单价不同 */
export const RATE_KEYS = ["input", "output", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h"] as const;
export type RateKey = (typeof RATE_KEYS)[number];
export type Rates = Partial<Record<RateKey, number>>;

/**
 * 按提示长度分档：提示 token 数**超过** promptOver 时，整个请求改用这一档。
 * 单价 = (rates[k] ?? 基础单价) × (multiply[k] ?? 1)。多档时取门槛最高的那个命中档。
 */
export interface PriceTier {
  promptOver: number;
  rates: Rates;
  multiply: Rates;
}

export interface ModelPrice {
  /** 规范名（表里别名指向同一个对象，用它区分） */
  model: string;
  rates: Rates;
  tiers: PriceTier[];
  aliases: string[];
  source: string | null;
  verifiedAt: string | null;
  /** 来自哪一层文件（bundled / override），供状态接口展示 */
  origin: string | null;
}

/** 键是模型名或别名，值是同一个 ModelPrice 对象 */
export type PricingTable = Record<string, ModelPrice>;

export const EMPTY_PRICING: PricingTable = {};

const META_KEYS = new Set(["tiers", "aliases", "source", "verified_at", "note", "provider"]);
const LEGACY: Record<string, RateKey> = {
  inputPerMTok: "input",
  outputPerMTok: "output",
  cacheReadPerMTok: "cache_read",
  cacheWrite5mPerMTok: "cache_write_5m",
  cacheWrite1hPerMTok: "cache_write_1h",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseRates(raw: unknown, where: string, errors: string[], positive = false): Rates | null {
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    errors.push(`${where}: must be an object`);
    return null;
  }
  const out: Rates = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(RATE_KEYS as readonly string[]).includes(k)) {
      errors.push(`${where}: unknown rate "${k}"`);
      return null;
    }
    if (!isRate(v) || (positive && v === 0)) {
      errors.push(`${where}.${k}: must be a ${positive ? "positive" : "non-negative"} number`);
      return null;
    }
    out[k as RateKey] = v;
  }
  return out;
}

/** 解析一个模型条目。出错时把原因追加到 errors 并返回 null —— 宁可缺这一个模型，不收半截价格。 */
export function parseModelPrice(model: string, raw: unknown, origin: string | null, errors: string[]): ModelPrice | null {
  const where = `model "${model}"`;
  if (!isObj(raw)) {
    errors.push(`${where}: must be an object`);
    return null;
  }

  // 旧格式：五个字段一个不能少（当初就是这么约定的，缺一个说明数据坏了）
  if (Object.keys(raw).some((k) => Object.hasOwn(LEGACY, k))) {
    const rates: Rates = {};
    for (const [legacy, key] of Object.entries(LEGACY)) {
      const v = raw[legacy];
      if (!isRate(v)) {
        errors.push(`${where}: ${legacy} must be a non-negative number`);
        return null;
      }
      rates[key] = v;
    }
    return { model, rates, tiers: [], aliases: [], source: null, verifiedAt: null, origin };
  }

  const rateFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_") || META_KEYS.has(k)) continue;
    rateFields[k] = v;
  }
  const rates = parseRates(rateFields, where, errors);
  if (!rates) return null;
  if (rates.input === undefined || rates.output === undefined) {
    errors.push(`${where}: input and output are required`);
    return null;
  }

  const tiers: PriceTier[] = [];
  if (raw["tiers"] !== undefined) {
    if (!Array.isArray(raw["tiers"])) {
      errors.push(`${where}.tiers: must be an array`);
      return null;
    }
    for (const [i, t] of raw["tiers"].entries()) {
      const tw = `${where}.tiers[${i}]`;
      if (!isObj(t) || typeof t["prompt_over"] !== "number" || !Number.isSafeInteger(t["prompt_over"]) || t["prompt_over"] <= 0) {
        errors.push(`${tw}: prompt_over must be a positive integer`);
        return null;
      }
      const extra = Object.keys(t).filter((k) => !["prompt_over", "rates", "multiply"].includes(k) && !k.startsWith("_"));
      if (extra.length) {
        errors.push(`${tw}: unknown field "${extra[0]}"`);
        return null;
      }
      const tr = parseRates(t["rates"], `${tw}.rates`, errors);
      const tm = parseRates(t["multiply"], `${tw}.multiply`, errors, true);
      if (!tr || !tm) return null;
      if (!Object.keys(tr).length && !Object.keys(tm).length) {
        errors.push(`${tw}: needs rates or multiply`);
        return null;
      }
      tiers.push({ promptOver: t["prompt_over"], rates: tr, multiply: tm });
    }
    tiers.sort((a, b) => a.promptOver - b.promptOver);
    if (tiers.some((t, i) => i > 0 && t.promptOver === tiers[i - 1]!.promptOver)) {
      errors.push(`${where}.tiers: duplicate prompt_over`);
      return null;
    }
  }

  let aliases: string[] = [];
  if (raw["aliases"] !== undefined) {
    if (!Array.isArray(raw["aliases"]) || !raw["aliases"].every((a) => typeof a === "string" && a.trim() !== "")) {
      errors.push(`${where}.aliases: must be an array of non-empty strings`);
      return null;
    }
    aliases = raw["aliases"].map((a: string) => a.trim());
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { model, rates, tiers, aliases, source: str(raw["source"]), verifiedAt: str(raw["verified_at"]), origin };
}

/**
 * 把一份 pricing.json 的内容解析成条目列表。接受 `{ models: {...} }` 外壳或直接的模型映射；
 * 以 `_` / `$` 开头的键是说明，跳过。坏条目单独报错、不影响其它条目。
 */
export function parsePriceEntries(raw: unknown, origin: string | null = null): {
  entries: ModelPrice[];
  version: string | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isObj(raw)) return { entries: [], version: null, errors: ["pricing file is not an object"] };
  const source = isObj(raw["models"]) ? raw["models"] : raw;
  const version = typeof raw["version"] === "string" && raw["version"].trim() ? raw["version"].trim() : null;
  const entries: ModelPrice[] = [];
  for (const [model, value] of Object.entries(source)) {
    if (model.startsWith("_") || model.startsWith("$")) continue;
    if (source === raw && model === "version") continue;
    const p = parseModelPrice(model, value, origin, errors);
    if (p) entries.push(p);
  }
  return { entries, version, errors };
}

/**
 * 按层合并成查表用的 PricingTable：后面的层整条覆盖前面同名的模型。
 * 别名与归一化后的名字（剥掉 `[1m]` 之类的网关后缀）都登记进来，但不抢占已有的规范名。
 */
export function buildPricingTable(layers: ModelPrice[][]): PricingTable {
  const byModel = new Map<string, ModelPrice>();
  for (const layer of layers) for (const p of layer) byModel.set(p.model, p);
  const table: PricingTable = {};
  for (const p of byModel.values()) table[p.model] = p;
  for (const p of byModel.values()) {
    for (const name of [normalizeModel(p.model), ...p.aliases]) {
      if (!table[name]) table[name] = p;
    }
  }
  return table;
}

/** 表里的规范条目（去掉别名带来的重复） */
export function pricedModels(table: PricingTable): ModelPrice[] {
  return Object.entries(table)
    .filter(([name, p]) => name === p.model)
    .map(([, p]) => p)
    .sort((a, b) => a.model.localeCompare(b.model));
}

export function lookupPrice(table: PricingTable, model: string): ModelPrice | null {
  return table[model] ?? table[normalizeModel(model)] ?? null;
}

/** 某个提示长度下实际生效的单价 */
export function effectiveRates(p: ModelPrice, promptTokens: number): Rates {
  let tier: PriceTier | undefined;
  for (const t of p.tiers) if (promptTokens > t.promptOver) tier = t;
  if (!tier) return p.rates;
  const out: Rates = {};
  for (const k of RATE_KEYS) {
    const base = tier.rates[k] ?? p.rates[k];
    if (base !== undefined) out[k] = base * (tier.multiply[k] ?? 1);
  }
  return out;
}

/**
 * 按若干「token 数 × 单价」求和。某一项有 token 却没有单价 → 返回缺的那一项的名字，
 * 由调用方决定怎么报（成本未知），绝不当成 0 美元。
 */
export function priceParts(rates: Rates, parts: [RateKey, number][]): { usd: number } | { missing: RateKey } {
  let usd = 0;
  for (const [k, tokens] of parts) {
    if (tokens === 0) continue;
    const r = rates[k];
    if (r === undefined) return { missing: k };
    usd += (tokens / 1_000_000) * r;
  }
  return { usd };
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWrite5mUsd: number;
  cacheWrite1hUsd: number;
  totalUsd: number;
}

/** Claude 事件的成本。缺价、或有 token 的那一项没有单价 → null。 */
export function computeCostUsd(
  e: Pick<UsageEvent, "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWrite5mTokens" | "cacheWrite1hTokens">,
  table: PricingTable,
): CostBreakdown | null {
  const p = lookupPrice(table, e.model);
  if (!p) return null;
  // Anthropic 的长提示分档按整个提示算：未缓存输入 + 缓存读 + 缓存写
  const prompt = e.inputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens;
  const r = effectiveRates(p, prompt);
  const parts: [RateKey, number][] = [
    ["input", e.inputTokens],
    ["output", e.outputTokens],
    ["cache_read", e.cacheReadTokens],
    ["cache_write_5m", e.cacheWrite5mTokens],
    ["cache_write_1h", e.cacheWrite1hTokens],
  ];
  if ("missing" in priceParts(r, parts)) return null;
  const per = (tok: number, rate: number | undefined) => (tok === 0 ? 0 : (tok / 1_000_000) * rate!);
  const inputUsd = per(e.inputTokens, r.input);
  const outputUsd = per(e.outputTokens, r.output);
  const cacheReadUsd = per(e.cacheReadTokens, r.cache_read);
  const cacheWrite5mUsd = per(e.cacheWrite5mTokens, r.cache_write_5m);
  const cacheWrite1hUsd = per(e.cacheWrite1hTokens, r.cache_write_1h);
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
