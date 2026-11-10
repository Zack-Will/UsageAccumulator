import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PRICING, computeCostUsd, lookupPrice } from "@ua/core";
import { PriceBook, countsTowardQuota, eventCostUsd, loadPricingTable, parsePricingFile, pricingVersion } from "../src/pricing.js";
import { BUNDLED_PRICING_PATH, makeEvent } from "./helpers.js";

const LEGACY = {
  inputPerMTok: 15,
  outputPerMTok: 75,
  cacheReadPerMTok: 1.5,
  cacheWrite5mPerMTok: 18.75,
  cacheWrite1hPerMTok: 30,
};
const V2 = { input: 15, output: 75, cache_read: 1.5, cache_write_5m: 18.75, cache_write_1h: 30 };

/** 只有 1M 输入、其余为 0 的事件：成本 = input 单价 */
const inputOnly = (model: string, inputTokens = 1_000_000) =>
  makeEvent({ model, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });

describe("pricing file parsing", () => {
  it("ships no hard-coded prices", () => {
    expect(Object.keys(EMPTY_PRICING)).toHaveLength(0);
  });

  it("reads the v2 format and the legacy five-field format to the same rates", () => {
    const a = parsePricingFile({ models: { "claude-opus-5": V2 } }).table["claude-opus-5"]!;
    const b = parsePricingFile({ "claude-opus-5": LEGACY }).table["claude-opus-5"]!;
    expect(a.rates).toEqual(V2);
    expect(b.rates).toEqual(V2);
  });

  it("ignores _comment-style keys, keeps notes, and reports malformed entries without dropping good ones", () => {
    const { table, errors } = parsePricingFile({
      _comment: ["note"],
      version: "2026-11-10",
      models: {
        "claude-opus-5": { ...V2, source: "official", verified_at: "2026-11-10", note: "x" },
        "claude-broken": { inputPerMTok: 1 },
        "claude-typo": { input: 1, output: 2, cach_read: 0.1 },
        "claude-negative": { input: -1, output: 2 },
        "claude-no-output": { input: 1 },
      },
    });
    expect(Object.keys(table)).toEqual(["claude-opus-5"]);
    expect(table["claude-opus-5"]!.source).toBe("official");
    expect(errors).toHaveLength(4);
    expect(errors.join("\n")).toContain('unknown rate "cach_read"');
  });

  it("registers the normalized model name and aliases so gateway names hit", () => {
    const { table } = parsePricingFile({ "claude-opus-5[1m]": V2, "claude-x": { ...V2, aliases: ["x-gateway"] } });
    expect(table["claude-opus-5"]?.rates).toEqual(V2);
    expect(eventCostUsd(inputOnly("claude-x"), table)).toBeCloseTo(15, 9);
    expect(lookupPrice(table, "x-gateway")?.model).toBe("claude-x");
  });

  it("validates tiers", () => {
    const bad = parsePricingFile({ m: { input: 1, output: 2, tiers: [{ prompt_over: 0, multiply: { input: 2 } }] } });
    expect(bad.errors).toHaveLength(1);
    const empty = parsePricingFile({ m: { input: 1, output: 2, tiers: [{ prompt_over: 10 }] } });
    expect(empty.errors[0]).toContain("needs rates or multiply");
    const zeroMul = parsePricingFile({ m: { input: 1, output: 2, tiers: [{ prompt_over: 10, multiply: { input: 0 } }] } });
    expect(zeroMul.errors).toHaveLength(1);
  });

  it("degrades to an empty table when the file is missing", () => {
    const { table, errors } = loadPricingTable("/definitely/not/here/pricing.json");
    expect(Object.keys(table)).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});

describe("cost computation", () => {
  const table = parsePricingFile({ "claude-opus-5": V2 }).table;

  it("returns null (not 0) for a model with no price", () => {
    expect(eventCostUsd(makeEvent({ model: "claude-unknown-9" }), table)).toBeNull();
  });

  it("computes cost with 5m and 1h cache priced separately", () => {
    const e = makeEvent({
      model: "claude-opus-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    });
    // 15 + 18.75 + 30；若把 5m/1h 合并成一档就会得到别的数字
    expect(eventCostUsd(e, table)).toBeCloseTo(63.75, 6);
  });

  it("excludes <synthetic> from billing (43 条实测)", () => {
    expect(countsTowardQuota("<synthetic>")).toBe(false);
    expect(countsTowardQuota("claude-opus-5")).toBe(true);
    expect(eventCostUsd(makeEvent({ model: "<synthetic>" }), parsePricingFile({ "<synthetic>": V2 }).table)).toBeNull();
  });

  it("a component with tokens but no rate makes the whole cost unknown, never $0 for that part", () => {
    const t = parsePricingFile({ "claude-y": { input: 1, output: 5 } }).table;
    expect(eventCostUsd(inputOnly("claude-y"), t)).toBeCloseTo(1, 9);
    expect(eventCostUsd(makeEvent({ model: "claude-y", cacheReadTokens: 10 }), t)).toBeNull();
  });

  it("prompt-length tiers: replacement rates and multipliers apply to the whole request above the threshold", () => {
    const t = parsePricingFile({
      "claude-haiku-9": {
        input: 0.1, output: 0.5, cache_read: 0.01, cache_write_5m: 0.125, cache_write_1h: 0.2,
        tiers: [{ prompt_over: 100_000, rates: { input: 0.5, output: 2.5 } }],
      },
      "claude-long": { ...V2, tiers: [{ prompt_over: 200_000, multiply: { input: 2, output: 1.5 } }] },
    }).table;
    expect(eventCostUsd(inputOnly("claude-haiku-9", 100_000), t)).toBeCloseTo(0.01, 9); // 正好等于门槛：不升档
    expect(eventCostUsd(inputOnly("claude-haiku-9", 100_001), t)).toBeCloseTo(0.0500005, 9);
    // 门槛按整个提示算：未缓存输入 + 缓存读 + 缓存写
    const cached = makeEvent({ model: "claude-haiku-9", inputTokens: 1000, outputTokens: 0, cacheReadTokens: 150_000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });
    expect(eventCostUsd(cached, t)).toBeCloseTo((1000 * 0.5 + 150_000 * 0.01) / 1e6, 12); // 缓存读单价没在这一档里改，沿用基础价
    const long = makeEvent({ model: "claude-long", inputTokens: 300_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });
    expect(eventCostUsd(long, t)).toBeCloseTo(0.3 * 30 + 75 * 1.5, 9);
  });
});

describe("deploy/pricing.json", () => {
  it("is valid and covers every model seen in real data", () => {
    const { table, errors } = loadPricingTable(BUNDLED_PRICING_PATH);
    expect(errors).toHaveLength(0);
    // 本机真实数据里实际出现过的模型（ARCHITECTURE §2.0），必须全部有价
    for (const m of [
      "claude-opus-5", "claude-fable-5-1", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-5",
      "claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2",
      "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.3-codex",
    ]) {
      expect(table[m], `${m} 缺少报价`).toBeDefined();
    }
    // 5m 与 1h 必须是不同单价 —— 合并会让 87.8% 的缓存写入算错
    const opus = table["claude-opus-5"]!.rates;
    expect(opus.cache_write_1h).toBeGreaterThan(opus.cache_write_5m!);
    // 官方特例：Fable 5.1 / 5.2 缓存读是 0.025x，不是数据错误
    expect(table["claude-fable-5-2"]!.rates.cache_read).toBe(0.2);
    // 表里没有的模型仍然必须是"成本未知"而不是 0
    expect(computeCostUsd({ model: "totally-unknown-model", inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }, table)).toBeNull();
  });
});

describe("pricingVersion", () => {
  it("changes only when prices change, not when notes do", () => {
    const a = parsePricingFile({ m: { ...V2, source: "a" } }).table;
    const b = parsePricingFile({ _comment: "x", m: { ...V2, source: "b", note: "y" } }).table;
    const c = parsePricingFile({ m: { ...V2, input: 16 } }).table;
    expect(pricingVersion(a)).toBe(pricingVersion(b));
    expect(pricingVersion(a)).not.toBe(pricingVersion(c));
  });
});

describe("PriceBook: layered, hot-reloadable, never replaced by a broken file", () => {
  let dir: string;
  let bundled: string;
  let override: string;
  const write = (path: string, models: Record<string, unknown>) => writeFile(path, JSON.stringify({ models }));
  const quiet = { info: () => {}, warn: () => {}, error: () => {} };
  const book = () =>
    new PriceBook(
      [
        { kind: "bundled", path: bundled, optional: false },
        { kind: "override", path: override, optional: true },
      ],
      quiet,
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ua-pricing-"));
    bundled = join(dir, "bundled.json");
    override = join(dir, "override.json");
    await write(bundled, { "claude-a": V2, "claude-b": V2 });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a missing optional override is fine; the override replaces same-named models wholesale", async () => {
    const b = book();
    expect(b.reload()).toBe(true);
    expect(b.status().rejected).toBeNull();
    expect(b.claudeCost(inputOnly("claude-a"))).toBeCloseTo(15, 9);

    await write(override, { "claude-a": { input: 1, output: 2 }, "claude-new": { input: 3, output: 4 } });
    expect(b.reload()).toBe(true);
    expect(b.claudeCost(inputOnly("claude-a"))).toBeCloseTo(1, 9);
    expect(b.claudeCost(inputOnly("claude-new"))).toBeCloseTo(3, 9);
    expect(b.claudeCost(inputOnly("claude-b"))).toBeCloseTo(15, 9);
    const origins = Object.fromEntries(b.status().models.map((m) => [m.model, m.origin]));
    expect(origins).toEqual({ "claude-a": "override", "claude-b": "bundled", "claude-new": "override" });
  });

  it("a broken file on reload keeps the previous table and reports why", async () => {
    const b = book();
    b.reload();
    const before = b.version;
    await writeFile(override, "{ not json");
    expect(b.reload()).toBe(false);
    expect(b.version).toBe(before);
    expect(b.claudeCost(inputOnly("claude-a"))).toBeCloseTo(15, 9);
    expect(b.status().rejected?.errors[0]).toContain("override: not valid JSON");

    // 一个坏条目也整份不生效：不能因为写错一个字段把别的价格改了一半
    await write(override, { "claude-a": { input: 1, output: 2 }, "claude-bad": { input: "x" } });
    expect(b.reload()).toBe(false);
    expect(b.claudeCost(inputOnly("claude-a"))).toBeCloseTo(15, 9);

    await write(override, { "claude-a": { input: 1, output: 2 } });
    expect(b.reload()).toBe(true);
    expect(b.status().rejected).toBeNull();
    expect(b.claudeCost(inputOnly("claude-a"))).toBeCloseTo(1, 9);
  });

  it("at startup, with nothing better to fall back to, it keeps the valid entries", async () => {
    await write(bundled, { "claude-a": V2, "claude-bad": { input: "x" } });
    const b = book();
    expect(b.reload()).toBe(true);
    expect(b.claudeCost(inputOnly("claude-a"))).toBeCloseTo(15, 9);
    expect(b.status().rejected?.errors).toHaveLength(1);
  });

  it("notifies listeners only when prices actually change", async () => {
    const b = book();
    b.reload();
    const fn = vi.fn();
    b.onChange(fn);
    b.reload();
    expect(fn).not.toHaveBeenCalled();
    await write(override, { "claude-a": { input: 1, output: 2 } });
    b.reload();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("picks up edits by itself, including the write-temp-then-rename that editors do", async () => {
    const b = book();
    b.reload();
    const stop = b.watch(20);
    try {
      const tmp = join(dir, ".override.json.tmp");
      await writeFile(tmp, JSON.stringify({ models: { "claude-a": { input: 2, output: 2 } } }));
      await rename(tmp, override);
      await vi.waitFor(() => expect(b.claudeCost(inputOnly("claude-a"))).toBeCloseTo(2, 9), { timeout: 3000, interval: 25 });
    } finally {
      stop();
    }
  });
});
