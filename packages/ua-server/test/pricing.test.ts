import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMPTY_PRICING, computeCostUsd } from "@ua/core";
import { countsTowardQuota, eventCostUsd, loadPricingTable, parsePricingFile } from "../src/pricing.js";
import { makeEvent } from "./helpers.js";

const PRICE = {
  inputPerMTok: 15,
  outputPerMTok: 75,
  cacheReadPerMTok: 1.5,
  cacheWrite5mPerMTok: 18.75,
  cacheWrite1hPerMTok: 30,
};

describe("pricing injection", () => {
  it("ships no hard-coded prices", () => {
    expect(Object.keys(EMPTY_PRICING)).toHaveLength(0);
  });

  it("accepts both the flat map and the { models } wrapper", () => {
    expect(parsePricingFile({ "claude-opus-5": PRICE }).table["claude-opus-5"]).toEqual(PRICE);
    expect(parsePricingFile({ models: { "claude-opus-5": PRICE } }).table["claude-opus-5"]).toEqual(
      PRICE,
    );
  });

  it("ignores _comment-style keys and reports malformed entries", () => {
    const { table, errors } = parsePricingFile({
      _comment: ["note"],
      models: { "claude-opus-5": PRICE, "claude-broken": { inputPerMTok: 1 } },
    });
    expect(Object.keys(table)).toEqual(["claude-opus-5"]);
    expect(errors).toHaveLength(1);
  });

  it("also registers the normalized model name so gateway suffixes hit", () => {
    const { table } = parsePricingFile({ "claude-opus-5[1m]": PRICE });
    expect(table["claude-opus-5"]).toEqual(PRICE);
  });

  it("returns null (not 0) for a model with no price", () => {
    const e = makeEvent({ model: "claude-unknown-9" });
    expect(eventCostUsd(e, parsePricingFile({ "claude-opus-5": PRICE }).table)).toBeNull();
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
    const cost = eventCostUsd(e, parsePricingFile({ "claude-opus-5": PRICE }).table)!;
    // 15 + 18.75 + 30；若把 5m/1h 合并成一档就会得到别的数字
    expect(cost).toBeCloseTo(63.75, 6);
  });

  it("excludes <synthetic> from billing (43 条实测)", () => {
    expect(countsTowardQuota("<synthetic>")).toBe(false);
    expect(countsTowardQuota("claude-opus-5")).toBe(true);
    const e = makeEvent({ model: "<synthetic>" });
    expect(eventCostUsd(e, parsePricingFile({ "<synthetic>": PRICE }).table)).toBeNull();
  });

  it("degrades to an empty table when the file is missing", () => {
    const { table, errors } = loadPricingTable("/definitely/not/here/pricing.json");
    expect(Object.keys(table)).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  // 这条原本断言 pricing.json 是"刻意留空"的。留空只是因为当时没有权威来源；
  // 现已从 LiteLLM 程序化生成快照（见 deploy/pricing.json 的 _source），
  // 所以断言改为"能加载、覆盖实测出现过的模型、且缺价仍返回 null"。
  it("ships deploy/pricing.json as a valid, sourced table", () => {
    const path = fileURLToPath(new URL("../../../deploy/pricing.json", import.meta.url));
    const { table, errors } = loadPricingTable(path);
    expect(errors).toHaveLength(0);
    expect(Object.keys(table).length).toBeGreaterThan(0);

    // 本机真实数据里实际出现过的模型（ARCHITECTURE §2.0），必须全部有价
    for (const m of [
      "claude-opus-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-6",
      "claude-sonnet-5",
    ]) {
      expect(table[m], `${m} 缺少报价`).toBeDefined();
    }

    // 5m 与 1h 必须是不同单价 —— 合并会让 87.8% 的缓存写入算错
    const opus = table["claude-opus-5"]!;
    expect(opus.cacheWrite1hPerMTok).toBeGreaterThan(opus.cacheWrite5mPerMTok);

    // 表里没有的模型仍然必须是"成本未知"而不是 0
    expect(
      computeCostUsd(
        {
          model: "totally-unknown-model",
          inputTokens: 1000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
        },
        table,
      ),
    ).toBeNull();
  });
});
