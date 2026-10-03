import { describe, expect, it } from "vitest";
import { attributeQuota, fuseOtherPct } from "../src/attribution.js";
import {
  increaseBetween,
  increaseIndex,
  isotonic,
  limitRatio,
  nonCodeSeries,
  parseProductBreakdown,
  type BreakdownSample,
} from "../src/products.js";
import type { QuotaSample } from "../src/windows.js";

const T0 = new Date("2026-09-28T00:00:00Z").getTime();
const min = (m: number) => new Date(T0 + m * 60_000);
const WEEK_A = "2026-09-23T17:59:59.774Z";
const WEEK_B = "2026-09-30T18:00:00.141Z";

/** 2026-09-29 线上响应的原样结构 */
function body(code: number, chat: number, weekStart = WEEK_A) {
  return {
    seven_day: { utilization: 9 },
    seven_day_breakdown: {
      as_of: "2026-09-29T03:54:23.747897+00:00",
      window_started_at: weekStart,
      rows: [
        { key: "claude_code", display_name: "Claude Code", percent: code },
        { key: "chat", display_name: "Chats", percent: chat },
        { key: "cowork", display_name: "Cowork", percent: 0 },
        { key: "other", display_name: "Other", percent: 0 },
      ],
    },
  };
}

function sample(m: number, weekly: number, code: number, weekStart = WEEK_A): BreakdownSample {
  return { ts: min(m), weeklyPct: weekly, breakdown: parseProductBreakdown(body(code, 100 - code, weekStart))! };
}

describe("parseProductBreakdown", () => {
  it("读整份响应，也读单独的 seven_day_breakdown", () => {
    const whole = parseProductBreakdown(body(97, 3))!;
    expect(whole.rows.map((r) => [r.key, r.label, r.sharePct])).toEqual([
      ["claude_code", "Claude Code", 97],
      ["chat", "Chats", 3],
      ["cowork", "Cowork", 0],
      ["other", "Other", 0],
    ]);
    expect(whole.windowStartedAt?.toISOString()).toBe("2026-09-23T17:59:59.774Z");
    expect(parseProductBreakdown(body(97, 3).seven_day_breakdown)).toEqual(whole);
  });

  it("team 组织给 null、老响应没有这个字段 → null，不是全 0", () => {
    expect(parseProductBreakdown({ seven_day_breakdown: null })).toBeNull();
    expect(parseProductBreakdown({ five_hour: { utilization: 3 } })).toBeNull();
    expect(parseProductBreakdown({ seven_day_breakdown: { rows: [] } })).toBeNull();
  });
});

describe("isotonic", () => {
  it("把整数份额造成的来回抖动压成非降序列，均值不变", () => {
    const y = [0.12, 0.15, 0.24, 0.18, 0.27];
    const fit = isotonic(y);
    expect(fit).toEqual([0.12, 0.15, 0.21, 0.21, 0.27]);
    expect(fit.reduce((a, b) => a + b)).toBeCloseTo(y.reduce((a, b) => a + b));
  });
});

describe("nonCodeSeries", () => {
  it("Code 在涨、chat 没动时份额被稀释，累计量仍然不降", () => {
    // 4%×4 = 0.16 → 5%×3 = 0.15（真实 chat 没变，只是份额被 Code 稀释）→ 6%×4 = 0.24
    const s = nonCodeSeries([sample(0, 4, 96), sample(5, 5, 97), sample(10, 6, 96)]);
    for (let i = 1; i < s.length; i++) expect(s[i]!.pct).toBeGreaterThanOrEqual(s[i - 1]!.pct);
    expect(s[2]!.pct).toBeCloseTo(0.24);
  });

  it("按 window_started_at 分周，各周分别拟合", () => {
    const s = nonCodeSeries([sample(0, 90, 90), sample(5, 91, 90), sample(10, 1, 50, WEEK_B)]);
    expect(s.map((p) => Number(p.pct.toFixed(2)))).toEqual([9, 9.1, 0.5]);
  });
});

describe("increaseBetween", () => {
  const series = nonCodeSeries([sample(0, 4, 97), sample(60, 4, 96), sample(120, 5, 96), sample(180, 6, 95)]);

  it("区间内的增量 = 两端拟合值之差", () => {
    // 0.12 → 0.16 → 0.20 → 0.30
    expect(increaseBetween(series, min(0), min(120))).toBeCloseTo(0.08);
    expect(increaseBetween(series, min(60), min(180))).toBeCloseTo(0.14);
  });

  it("起点之前没有点：本周从起点就看得见时从 0 算，否则只从第一个点算", () => {
    const weekStart = new Date(WEEK_A);
    const s = nonCodeSeries([sample(0, 4, 97), sample(60, 5, 96)]);
    expect(increaseBetween(s, weekStart, min(60))).toBeCloseTo(0.2);
    // 从本周中途某个时刻问起，但那之前没有采样：第一个点之前涨的没人看见
    expect(increaseBetween(s, min(-30), min(60))).toBeCloseTo(0.08);
  });

  it("跨周时新周整个值都算增量", () => {
    const s = nonCodeSeries([sample(0, 90, 90), sample(10, 2, 50, WEEK_B)]);
    // 旧周 9 → 新周 1：跨周那段的增量是 1，不是 1 − 9
    expect(increaseIndex(s)(min(0), min(10))).toBeCloseTo(1);
  });
});

describe("limitRatio", () => {
  const pairs = (xs: Array<[number, number, number]>) => ({
    short: xs.map(([m, a]) => ({ ts: min(m), pct: a })) as QuotaSample[],
    long: xs.map(([m, , b]) => ({ ts: min(m), pct: b })) as QuotaSample[],
  });

  it("按段首尾相减再求和，跨过 5h 重置", () => {
    const { short, long } = pairs([
      [0, 10, 2],
      [60, 40, 5],
      [120, 0, 5], // 5h 重置
      [180, 30, 8],
    ]);
    const r = limitRatio(short, long, { maxGapMs: 90 * 60_000 })!;
    expect(r.ratio).toBeCloseTo((30 + 30) / (3 + 3));
    expect(r.segments).toBe(2);
  });

  it("7d 总共只涨了几个点时不给 —— ±1 的量化误差太大", () => {
    const { short, long } = pairs([
      [0, 10, 2],
      [5, 40, 4],
    ]);
    expect(limitRatio(short, long)).toBeNull();
  });
});

describe("fuseOtherPct", () => {
  it("没有拆分时就是差额法下界", () => {
    const r = attributeQuota(
      [
        { ts: min(0), pct: 10 },
        { ts: min(5), pct: 12 },
      ],
      [],
    );
    expect(fuseOtherPct(r, null, 12)).toBe(2);
  });

  it("边写代码边聊天：差额法判不了，拆分补上", () => {
    const samples = [
      { ts: min(0), pct: 10 },
      { ts: min(5), pct: 14 },
    ];
    const r = attributeQuota(samples, [{ ts: min(2) }], { nonCode: () => 1.5 });
    expect(r.otherPctLowerBound).toBe(0);
    expect(r.nonCodeInAmbiguousPct).toBe(1.5);
    expect(fuseOtherPct(r, 1.5, 14)).toBe(1.5);
  });

  it("安静时段别的机器在跑 Code：拆分看不见，差额法补上；两者重叠部分不重复算", () => {
    const samples = [
      { ts: min(0), pct: 10 },
      { ts: min(5), pct: 13 }, // 安静：+3（其中 1 点是聊天，2 点是没装探针的机器）
      { ts: min(10), pct: 15 }, // 本地在跑：+2（其中 0.5 是聊天）
    ];
    const chat = (f: Date, t: Date) => (f.getTime() === min(0).getTime() ? 1 : t.getTime() === min(10).getTime() ? 0.5 : 0);
    const r = attributeQuota(samples, [{ ts: min(8) }], { nonCode: chat, quietLeadMs: 4 * 60_000 });
    expect(r.otherPctLowerBound).toBe(3);
    expect(r.nonCodeInAmbiguousPct).toBe(0.5);
    // 拆分合计 1.5；差额法 3 + 判不了区间里的 0.5 = 3.5
    expect(fuseOtherPct(r, 1.5, 15)).toBe(3.5);
  });

  it("不超过官方百分比本身", () => {
    const r = attributeQuota([{ ts: min(0), pct: 1 }], []);
    expect(fuseOtherPct(r, 4, 1)).toBe(1);
  });
});
