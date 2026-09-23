import { describe, expect, it } from "vitest";
import {
  alignedSeries,
  bucketTicks,
  byCostThenTokens,
  cacheHitPct,
  modelDisplayName,
  usageTotals,
} from "../src/api/derive";
import type { DistributionBucket } from "../src/api/types";
import { fmtUntil, fmtWhen, niceMaxPct } from "../src/charts/base";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 23, 0, 0, 0);

function bucket(over: Partial<DistributionBucket> = {}): DistributionBucket {
  return {
    key: "k",
    events: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    unpriced_events: 0,
    ...over,
  };
}

describe("bucketTicks / 时间轴补零", () => {
  it("★ 空着的小时也要有刻度 —— 以前被挤掉，夜里十几个小时看着和两小时一样宽", () => {
    const ticks = bucketTicks(T0 + 17 * H, T0 + 23 * H, "hour");
    expect(ticks.map((t) => (t - T0) / H)).toEqual([17, 18, 19, 20, 21, 22]);
  });

  it("起点按桶取整，与服务端 truncToBucket 对齐", () => {
    const ticks = bucketTicks(T0 + 17 * H + 25 * 60_000, T0 + 19 * H, "hour");
    expect(ticks[0]).toBe(T0 + 17 * H);
  });

  it("天桶按 UTC 零点取整（跟随服务端）", () => {
    const ticks = bucketTicks(T0 + 5 * H, T0 + 3 * 24 * H, "day");
    expect(ticks).toEqual([T0, T0 + 24 * H, T0 + 48 * H]);
  });

  it("参数反了返回空，而不是死循环", () => {
    expect(bucketTicks(T0 + H, T0, "hour")).toEqual([]);
    expect(bucketTicks(Number.NaN, T0, "hour")).toEqual([]);
  });
});

describe("alignedSeries", () => {
  const ticks = [T0, T0 + H, T0 + 2 * H];
  const b = bucket({
    key: "mac",
    series: [
      { ts: new Date(T0).toISOString(), total_tokens: 100, events: 2, cost_usd: 1.5, unpriced_events: 0 },
      { ts: new Date(T0 + 2 * H).toISOString(), total_tokens: 50, events: 1, cost_usd: null, unpriced_events: 1 },
    ],
  });

  it("按刻度对齐，空桶补 0", () => {
    const [s] = alignedSeries([b], ticks, "tokens", (x) => x.key);
    expect(s!.values).toEqual([100, 0, 50]);
  });

  it("★ cost 口径：空桶是 $0（确实没花），缺价是 null（花了但不知道多少）—— 两者不能混", () => {
    const [s] = alignedSeries([b], ticks, "cost", (x) => x.key);
    expect(s!.values).toEqual([1.5, 0, null]);
  });
});

describe("usageTotals / cacheHitPct", () => {
  it("★ 命中率的分母是输入侧，不含输出 —— 输出从不走缓存", () => {
    // 输入 10 + 缓存读 880 + 缓存写 110 = 1000；输出 5000 不该进分母
    expect(cacheHitPct(10, 880, 110)).toBeCloseTo(88, 6);
  });

  it("没有任何输入侧 token 时是 null（未知），不是 0%", () => {
    expect(cacheHitPct(0, 0, 0)).toBeNull();
  });

  it("跨桶汇总，缓存写把 5m 与 1h 合起来算", () => {
    const t = usageTotals([
      bucket({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 800, cache_write_5m_tokens: 40, cache_write_1h_tokens: 60, total_tokens: 915, events: 3, cost_usd: 2 }),
      bucket({ input_tokens: 0, output_tokens: 1, cache_read_tokens: 80, cache_write_5m_tokens: 0, cache_write_1h_tokens: 10, total_tokens: 91, events: 1, cost_usd: null, unpriced_events: 1 }),
    ]);
    expect(t.totalTokens).toBe(1006);
    expect(t.cacheWrite).toBe(110);
    expect(t.events).toBe(4);
    expect(t.cost.usd).toBe(2);
    expect(t.cost.unpricedEvents).toBe(1);
    expect(t.cacheHitPct).toBeCloseTo((880 / 1000) * 100, 6);
  });
});

describe("usageTotals / 平均上下文与单次金额", () => {
  it("平均上下文 = 输入侧总量 ÷ 调用次数（实测形态：每次 2 个未缓存 + 大段缓存读）", () => {
    // 216 次调用、未缓存输入 432（每次 2）、缓存读 116.0M、缓存写 2.0M —— 截图里那张卡的数
    const t = usageTotals([
      bucket({ events: 216, input_tokens: 432, cache_read_tokens: 116_000_000, cache_write_1h_tokens: 2_000_000, cost_usd: 46.52 }),
    ]);
    expect(t.avgContext).toBeCloseTo((432 + 116_000_000 + 2_000_000) / 216, 3);
    expect(t.avgCostPerCall).toBeCloseTo(46.52 / 216, 6);
  });

  it("单次金额只按有报价的调用平均 —— 缺价的调用不能拉低均值", () => {
    const t = usageTotals([
      bucket({ events: 10, cost_usd: 5, unpriced_events: 0 }),
      bucket({ events: 4, cost_usd: null, unpriced_events: 4 }),
    ]);
    expect(t.avgCostPerCall).toBeCloseTo(0.5, 6);
  });

  it("全部缺价 → 单次金额是 null（未知），不是 $0", () => {
    const t = usageTotals([bucket({ events: 3, cost_usd: null, unpriced_events: 3 })]);
    expect(t.avgCostPerCall).toBeNull();
  });

  it("没有调用 → 两个均值都是 null，不除以 0", () => {
    const t = usageTotals([]);
    expect(t.avgContext).toBeNull();
    expect(t.avgCostPerCall).toBeNull();
  });
});

describe("byCostThenTokens", () => {
  it("有报价的按金额降序，缺价的沉底", () => {
    const rows = [
      bucket({ key: "a", cost_usd: 1, total_tokens: 9 }),
      bucket({ key: "b", cost_usd: null, total_tokens: 99 }),
      bucket({ key: "c", cost_usd: 5, total_tokens: 1 }),
    ].sort(byCostThenTokens);
    expect(rows.map((r) => r.key)).toEqual(["c", "a", "b"]);
  });
});

describe("modelDisplayName", () => {
  it.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-opus-5", "Opus 5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-sonnet-4-5-20250929", "Sonnet 4.5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-3-7-sonnet-20250219", "Sonnet 3.7"],
    ["claude-opus-5[1m]", "Opus 5"],
    ["claude-opus-4-5@20251101", "Opus 4.5"],
  ])("%s → %s", (raw, shown) => {
    expect(modelDisplayName(raw)).toBe(shown);
  });

  it("认不出的原样返回，不瞎猜", () => {
    expect(modelDisplayName("claude-mythos-preview")).toBe("claude-mythos-preview");
    expect(modelDisplayName("some-gateway-model")).toBe("some-gateway-model");
  });
});

describe("fmtUntil / fmtWhen", () => {
  it("相对时长", () => {
    expect(fmtUntil(55 * 60_000)).toBe("55 分钟后");
    expect(fmtUntil(105 * 60_000)).toBe("1 小时 45 分后");
    expect(fmtUntil(2 * H)).toBe("2 小时后");
    expect(fmtUntil((5 * 24 + 16) * H)).toBe("5 天 16 小时后");
    expect(fmtUntil(30_000)).toBe("即将");
  });

  it("★ 超过一天的时刻必须带日期 —— 只写 07:00 会被读成明早", () => {
    const now = new Date(2026, 8, 23, 15, 17).getTime(); // 本地 09-23 周三 15:17
    expect(fmtWhen(new Date(2026, 8, 23, 16, 10).getTime(), now)).toBe("16:10");
    expect(fmtWhen(new Date(2026, 8, 24, 7, 0).getTime(), now)).toBe("明天 07:00");
    expect(fmtWhen(new Date(2026, 8, 29, 7, 0).getTime(), now)).toBe("09-29 周二 07:00");
  });
});

describe("niceMaxPct / 燃尽图纵轴", () => {
  it("贴着数据取整齐刻度，留 15% 余量", () => {
    expect(niceMaxPct(5)).toBe(10);
    expect(niceMaxPct(8.6)).toBe(10); // 8.6 × 1.15 = 9.89
    expect(niceMaxPct(9)).toBe(25);
    expect(niceMaxPct(55)).toBe(75);
  });

  it("逼近上限就回到 110%，让 100% 线重新可见", () => {
    expect(niceMaxPct(88)).toBe(110);
    expect(niceMaxPct(100)).toBe(110);
  });
});

describe("fmtUsdSmall", () => {
  it("一毛以下给三位小数：$0.045 不该被显示成 $0.05", async () => {
    const { fmtUsdSmall } = await import("../src/components/UsagePanels");
    expect(fmtUsdSmall(0.045)).toBe("$0.045");
    expect(fmtUsdSmall(0.2154)).toBe("$0.22");
    expect(fmtUsdSmall(1.5)).toBe("$1.50");
  });
});

describe("临时工作区与会话的显示名", () => {
  const SCRATCH =
    "-Users-me-Library-Application-Support-Claude-scratch-workspaces-org-user-scratch-2026-09-22-105cae";

  it("★ 临时工作区没有标题时显示「临时会话 09-22」，而不是随机后缀「105cae」", async () => {
    const { projectLabel } = await import("../src/api/derive");
    expect(projectLabel(SCRATCH)).toBe("临时会话 09-22");
    expect(projectLabel("-Users-me-Repos-Cleave")).toBe("Cleave");
  });

  it("会话名：有标题用标题，没有就「未命名 · id 前 8 位」", async () => {
    const { sessionLabel } = await import("../src/api/derive");
    expect(sessionLabel({ key: "e8c04bc5-162a-48ec", label: "糖果形状口味组合问题" })).toBe("糖果形状口味组合问题");
    expect(sessionLabel({ key: "0d8a057e-67f6-4eaf" })).toBe("未命名 · 0d8a057e");
  });

  it("会话位置：项目 · 机器；临时工作区写成「临时会话」", async () => {
    const { sessionWhere } = await import("../src/api/derive");
    expect(sessionWhere({ project_slug: "-Users-me-Repos-Cleave", machine_label: "mbp" })).toBe("Cleave · mbp");
    expect(sessionWhere({ project_slug: SCRATCH, machine_label: "K4F59009H4" })).toBe("临时会话 · K4F59009H4");
    expect(sessionWhere({})).toBe("");
  });
});
