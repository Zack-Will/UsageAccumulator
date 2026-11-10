import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { computeCodexCost as compute } from "../src/codex-pricing.js";
import { buildPricingTable, parsePriceEntries } from "../src/pricing.js";
import type { CodexUsageEvent } from "../src/codex-types.js";

const event = (over: Partial<CodexUsageEvent> = {}): CodexUsageEvent => ({
  event_id: "1", session_id: "s", turn_id: null, parent_session_id: null, ts: "2026-10-01T00:00:00Z",
  model: "gpt-6-astra", model_provider: null, reasoning_effort: "high", service_tier: null, project: null,
  input_tokens: 100_000, cached_input_tokens: 50_000, cache_write_input_tokens: 20_000,
  output_tokens: 10_000, reasoning_output_tokens: 5_000, total_tokens: 110_000, quality_flags: [], ...over,
});
// 用仓库里正式的价格表：这些数字原本写死在代码里，搬进数据文件后必须算出一模一样的结果
const parsed = parsePriceEntries(JSON.parse(readFileSync(new URL("../../../deploy/pricing.json", import.meta.url), "utf8")));
const TABLE = buildPricingTable([parsed.entries]);
const computeCodexCost = (e: CodexUsageEvent) => compute(e, TABLE, "v-test");

describe("Codex current Standard API equivalent", () => {
  it("loads the bundled catalog without errors", () => {
    expect(parsed.errors).toEqual([]);
  });
  it("stamps the catalog version it priced with", () => {
    expect(computeCodexCost(event()).price_version).toBe("v-test");
  });
  it("partitions input and does not charge reasoning twice", () => {
    expect(computeCodexCost(event()).usd).toBe(1.1); // .3 net + .05 cached + .25 writes + .5 output
  });
  it("applies the long-context rate to the full request", () => {
    expect(computeCodexCost(event({ input_tokens: 300_000, total_tokens: 310_000 })).usd).toBe(5.95);
  });
  it("keeps actual zero separate from missing price", () => {
    expect(computeCodexCost(event({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 })).usd).toBe(0);
    expect(computeCodexCost(event({ model: "gpt-future" }))).toMatchObject({ usd: null, missing_reason: "unknown_model" });
  });
  it("prices work-mode slugs at their base model's rates", () => {
    expect(computeCodexCost(event({ model: "gpt-6-astra-wm" })).usd).toBe(1.1);
    expect(computeCodexCost(event({ model: "gpt-future-wm" })).missing_reason).toBe("unknown_model");
    expect(computeCodexCost(event({ model: "-wm" })).missing_reason).toBe("unknown_model");
  });
  it("rejects impossible subsets and unknown cache-write pricing", () => {
    expect(computeCodexCost(event({ input_tokens: 1 })).usd).toBeNull();
    expect(computeCodexCost(event({ model: "gpt-5.3-codex" })).missing_reason).toBe("unknown_cache_write_price");
  });
});
