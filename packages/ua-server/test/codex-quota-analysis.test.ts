import { describe, expect, it } from "vitest";
import type { CodexQuotaWindow } from "@ua/core";
import { analyzeCodexWindow, codexPeriods, type CodexQuotaHistoryPoint } from "../src/codex-quota-analysis.js";

const T0 = Date.parse("2026-10-13T00:00:00Z");
const MIN = 60_000;
const WEEK = 7 * 24 * 60 * MIN;
const at = (min: number) => new Date(T0 + min * MIN).toISOString();

/** 一个 7d 窗口，resetsAtMin 是计划重置（分钟偏移） */
const w = (used: number, resetsAtMin: number, extra: Partial<CodexQuotaWindow> = {}): CodexQuotaWindow => ({
  window_id: "codex:secondary", limit_id: "codex", slot: "secondary", label: null,
  used_percent: used, duration_minutes: 7 * 24 * 60, resets_at: at(resetsAtMin), ...extra,
});
/** 每 5 分钟一个样本 */
const series = (points: Array<[number, number, number]>): CodexQuotaHistoryPoint[] =>
  points.map(([min, used, reset]) => ({ captured_at: at(min), windows: [w(used, reset)] }));

const END = WEEK / MIN; // 第一期计划在 T0 + 7d 重置

describe("Codex 额度：期与段", () => {
  it("期内的官方重置：开新段、不开新期；本期累计 = 各段峰值之和", () => {
    const h = series([[0, 40, END], [5, 45, END], [10, 51, END], [15, 0, END], [20, 10, END], [25, 30, END]]);
    const [p, ...rest] = codexPeriods(h).get("codex:secondary")!;
    expect(rest).toEqual([]);
    expect(p!.resets).toEqual([{ after: at(10), at: at(15), from_pct: 51, to_pct: 0, kind: "in_period" }]);
    expect(p!.cumulative_pct).toBe(81);
    expect(p!.final_pct).toBe(30);
    expect(p!.samples.map((s) => s.segment)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("重置把 resets_at 推走：旧期按重置提前结束，新期由这次重置打开", () => {
    const moved = 20 + END; // 重置时刻 + 7d
    const h = series([[0, 40, END], [10, 51, END], [20, 0, moved], [25, 6, moved]]);
    const periods = codexPeriods(h).get("codex:secondary")!;
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ end_reason: "reset", ended_at: at(20), cumulative_pct: 51 });
    expect(periods[1]!.opened_by_reset).toMatchObject({ kind: "new_period", from_pct: 51, to_pct: 0, at: at(20) });
    expect(periods[1]).toMatchObject({ starts_at: at(20), cumulative_pct: 6, scheduled_end: at(moved) });
  });

  it("计划重置到点：新的一期，不记成重置事件", () => {
    const next = END + END;
    const h = series([[END - 10, 90, END], [END + 5, 3, next]]);
    const periods = codexPeriods(h).get("codex:secondary")!;
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ end_reason: "scheduled", ended_at: at(END), resets: [] });
    expect(periods[1]).toMatchObject({ opened_by_reset: null, cumulative_pct: 3 });
  });

  it("两个来源时钟差几秒造成的 1 个点回退：不算重置，也不重复计入", () => {
    const h = series([[0, 50, END], [5, 51, END], [5.2, 50, END], [10, 52, END]]);
    const [p] = codexPeriods(h).get("codex:secondary")!;
    expect(p!.resets).toEqual([]);
    expect(p!.cumulative_pct).toBe(52);
  });

  it("空闲窗口的 resets_at 漂移但用量没掉：同一期，计划终点跟着更新", () => {
    const h = series([[0, 0, 300], [5, 0, 305], [10, 0, 310]]);
    const periods = codexPeriods(h).get("codex:secondary")!;
    expect(periods).toHaveLength(1);
    expect(periods[0]!.scheduled_end).toBe(at(310));
  });

  it("采样断档超过 30 分钟：累计只是下界，标出来", () => {
    const h = series([[0, 10, END], [5, 12, END], [60, 20, END]]);
    expect(codexPeriods(h).get("codex:secondary")![0]!.has_gap).toBe(true);
  });

  it("预测只用当前段：重置前的高速率与 51→0 这一步都不进速率", () => {
    // 重置前每 5 分钟涨 5 点；重置后每 5 分钟涨 1 点
    const h = series([[0, 40, END], [5, 45, END], [10, 50, END], [15, 0, END], [20, 1, END], [25, 2, END], [30, 3, END]]);
    const [p] = codexPeriods(h).get("codex:secondary")!;
    const a = analyzeCodexWindow(p!, new Date(T0 + 30 * MIN));
    expect(a.rate_pct_per_min).toBeCloseTo(0.2, 6);
    expect(a.projected_pct.mid).toBeGreaterThan(3);
  });

  it("多个窗口各切各的", () => {
    const h: CodexQuotaHistoryPoint[] = [
      { captured_at: at(0), windows: [w(10, END), w(30, 300, { window_id: "codex:primary", duration_minutes: 300 })] },
      { captured_at: at(5), windows: [w(11, END), w(0, 300, { window_id: "codex:primary", duration_minutes: 300 })] },
    ];
    const periods = codexPeriods(h);
    expect(periods.get("codex:primary")![0]!.resets).toHaveLength(1);
    expect(periods.get("codex:secondary")![0]!.resets).toHaveLength(0);
  });
});

import { codexFullCost, codexFullCostEstimate, codexFullCostReference } from "../src/codex-quota-analysis.js";

describe("Codex 满额约", () => {
  it("本地花费 ÷ 本期累计；没有花费或累计为 0 时不编数", () => {
    expect(codexFullCost(20, 40)).toBeCloseTo(50, 9);
    expect(codexFullCost(0, 40)).toBeNull();
    expect(codexFullCost(null, 40)).toBeNull();
    expect(codexFullCost(20, 0)).toBeNull();
  });

  it("往期参考只取已结束、累计 ≥ 30% 的期，取中位数", () => {
    const p = (ended: boolean, cum: number, usd: number | null) => ({ ended_at: ended ? "x" : null, cumulative_pct: cum, full_cost_usd: usd });
    expect(codexFullCostReference([p(true, 80, 100), p(true, 20, 999), p(true, 60, 140), p(false, 90, 1), p(true, 50, 120)]))
      .toEqual({ usd: 120, periods: 3 });
    expect(codexFullCostReference([p(true, 10, 50)])).toBeNull();
  });

  it("本期累计太小就用往期参考；够大就外推本期，缺价时标下界", () => {
    const ref = { usd: 120, periods: 4 };
    expect(codexFullCostEstimate({ cost_usd: 2, cumulative_pct: 5, unpriced_events: 0 }, ref))
      .toEqual({ usd: 120, basis: "reference", reference_periods: 4, lower_bound: false });
    expect(codexFullCostEstimate({ cost_usd: 30, cumulative_pct: 40, unpriced_events: 3 }, ref))
      .toEqual({ usd: 75, basis: "current", reference_periods: null, lower_bound: true });
    // 没有参考时小累计照样外推：使用者知情
    expect(codexFullCostEstimate({ cost_usd: 2, cumulative_pct: 5, unpriced_events: 0 }, null)?.basis).toBe("current");
    expect(codexFullCostEstimate({ cost_usd: 0, cumulative_pct: 5, unpriced_events: 0 }, null)).toBeNull();
  });
});
