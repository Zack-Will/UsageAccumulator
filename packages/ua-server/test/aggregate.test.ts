import { describe, expect, it } from "vitest";
import { FIVE_HOURS_MS, type CalibObservation, type QuotaSample } from "@ua/core";
import {
  SEVEN_DAYS_MS,
  buildDistribution,
  buildObservations,
  buildProjectedCurve,
  buildTimelineLanes,
  calendarWeight,
  calibrationPoints,
  computeWindowMetrics,
  dispersionFrom,
  distributionKey,
  downsample,
  formatTrayTitlePct,
  inferWindowMs,
  projectCalendarWindow,
  quotaEvents,
  quotaTokens,
  ratioToPct,
  truncToBucket,
  weekdayWeightsFromEvents,
  windowLabel,
  windowWastePct,
} from "../src/aggregate.js";
import { makeEvent } from "./helpers.js";

const T0 = new Date("2026-09-21T05:30:00.000Z");
const T_END = new Date(T0.getTime() + FIVE_HOURS_MS);
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);

describe("window kinds", () => {
  it("infers window length from the free-form window_kind", () => {
    expect(inferWindowMs("five_hour")).toBe(FIVE_HOURS_MS);
    expect(inferWindowMs("seven_day")).toBe(SEVEN_DAYS_MS);
    // 官方可能把 seven_day_opus 改成别的名字，只要还带 seven 就该认出来
    expect(inferWindowMs("seven_day_fable")).toBe(SEVEN_DAYS_MS);
    expect(inferWindowMs("totally_new_kind")).toBe(FIVE_HOURS_MS);
  });

  it("labels known kinds and passes unknown ones through verbatim", () => {
    expect(windowLabel("five_hour")).toBe("5h");
    expect(windowLabel("seven_day")).toBe("7d");
    expect(windowLabel("seven_day_fable")).toBe("7d Fable");
    expect(windowLabel("brand_new")).toBe("brand_new");
  });
});

describe("§7.5 metrics", () => {
  it("window waste is 100 - pct in the percentage frame", () => {
    expect(windowWastePct(62)).toBe(38);
    expect(windowWastePct(140)).toBe(0);
  });

  it("counts multi-machine overlap and session cut rate", () => {
    const events = [
      // 两台机器在同一分钟里都在烧 → 重叠
      makeEvent({ ts: at(10), machineId: "a", sessionId: "s1" }),
      makeEvent({ ts: at(10), machineId: "b", sessionId: "s2" }),
      makeEvent({ ts: at(20), machineId: "a", sessionId: "s1" }),
      // s3 跨过窗口终点 → 被切断
      makeEvent({ ts: at(290), machineId: "a", sessionId: "s3" }),
      makeEvent({ ts: at(320), machineId: "a", sessionId: "s3" }),
    ];
    const m = computeWindowMetrics({
      events,
      windowStart: T0,
      windowEnd: T_END,
      utilizationPct: 62,
    });
    expect(m.multiMachineOverlap).toBeGreaterThan(0);
    expect(m.sessionCutRate).toBeCloseTo(1 / 3, 6);
    expect(m.machines).toEqual(["a", "b"]);
    expect(m.windowWastePct).toBe(38);
  });

  it("reports the local-vs-official window offset in minutes", () => {
    // 本地块从 05:00（事件所在整点向下取整）起，5h 后是 10:00；官方 10:30 → +30min
    const events = [makeEvent({ ts: at(10), machineId: "a" })];
    const m = computeWindowMetrics({
      events,
      windowStart: T0,
      windowEnd: T_END,
      utilizationPct: 10,
    });
    expect(m.localWindowOffsetMin).toBe(30);
  });

  it("excludes <synthetic> from every quota metric", () => {
    const events = [
      makeEvent({ ts: at(5), machineId: "a", model: "<synthetic>" }),
      makeEvent({ ts: at(5), machineId: "b", model: "<synthetic>" }),
    ];
    expect(quotaEvents(events)).toHaveLength(0);
    const m = computeWindowMetrics({
      events,
      windowStart: T0,
      windowEnd: T_END,
      utilizationPct: 0,
    });
    expect(m.events).toBe(0);
    expect(m.multiMachineOverlap).toBe(0);
    expect(m.localWindowOffsetMin).toBeNull();
  });
});

describe("timeline lanes", () => {
  it("merges nearby events into per-machine spans", () => {
    const lanes = buildTimelineLanes(
      [
        makeEvent({ ts: at(0), machineId: "a" }),
        makeEvent({ ts: at(2), machineId: "a" }),
        makeEvent({ ts: at(60), machineId: "a" }),
        makeEvent({ ts: at(1), machineId: "b" }),
      ],
      5 * 60_000,
    );
    expect(lanes.map((l) => l.machineId)).toEqual(["a", "b"]);
    expect(lanes[0]!.spans).toHaveLength(2);
    expect(lanes[0]!.spans[0]!.events).toBe(2);
    expect(lanes[1]!.spans).toHaveLength(1);
  });
});

describe("distribution", () => {
  it("buckets by the requested dimension", () => {
    const e = makeEvent({ ts: at(0), machineId: "a", projectSlug: null });
    expect(distributionKey(e, "machine")).toBe("a");
    expect(distributionKey(e, "project")).toBe("(unknown)");
    expect(distributionKey(e, "hour")).toBe("2026-09-21T05:00:00.000Z");
  });

  it("keeps unpriced events out of cost but counts them", () => {
    const buckets = buildDistribution(
      [
        { event: makeEvent({ machineId: "a" }), costUsd: 1.5 },
        { event: makeEvent({ machineId: "a" }), costUsd: null },
        { event: makeEvent({ machineId: "b", model: "<synthetic>" }), costUsd: null },
      ],
      "machine",
    );
    expect(buckets).toHaveLength(1); // <synthetic> 整条被排除
    expect(buckets[0]!.key).toBe("a");
    expect(buckets[0]!.costUsd).toBe(1.5);
    expect(buckets[0]!.unpricedEvents).toBe(1);
  });

  it("leaves cost null when nothing in the bucket has a price", () => {
    const buckets = buildDistribution([{ event: makeEvent(), costUsd: null }], "model");
    expect(buckets[0]!.costUsd).toBeNull();
  });
});

describe("calibration observations (§7.0)", () => {
  const samples: QuotaSample[] = [
    { ts: at(0), pct: 10 },
    { ts: at(5), pct: 12 },
    { ts: at(10), pct: 12 }, // Δpct = 0 → 丢掉
    { ts: at(15), pct: 20 },
  ];

  it("pairs official deltas with local tokens and drops idle intervals", () => {
    const events = [
      makeEvent({ ts: at(1), machineId: "a", model: "claude-opus-5" }),
      makeEvent({ ts: at(12), machineId: "a", model: "claude-fable-5-1" }),
    ];
    const obs = buildObservations(samples, events);
    expect(obs).toHaveLength(2);
    expect(obs[0]!.deltaPct).toBe(2);
    expect(Object.keys(obs[0]!.tokensByModel)).toEqual(["claude-opus-5"]);
    expect(obs.every((o) => o.singleMachine)).toBe(true);
  });

  it("marks multi-machine intervals so the regression can drop them", () => {
    const events = [
      makeEvent({ ts: at(1), machineId: "a" }),
      makeEvent({ ts: at(2), machineId: "b" }),
    ];
    const obs = buildObservations(samples, events);
    expect(obs[0]!.singleMachine).toBe(false);
  });

  it("ignores <synthetic> tokens", () => {
    const obs = buildObservations(samples, [
      makeEvent({ ts: at(1), machineId: "a", model: "<synthetic>" }),
    ]);
    expect(obs).toHaveLength(0);
  });
});

describe("units (CONTRACT §4)", () => {
  it("converts core's 0..1 ratios to 0..100", () => {
    expect(ratioToPct(0.34)).toBeCloseTo(34, 9);
    expect(ratioToPct(0)).toBe(0);
    expect(ratioToPct(1)).toBe(100);
  });

  it("keeps computeWindowMetrics on core's 0..1 scale — conversion belongs at the wire layer", () => {
    const events = [
      makeEvent({ ts: at(10), machineId: "a", sessionId: "s1" }),
      makeEvent({ ts: at(10), machineId: "b", sessionId: "s2" }),
    ];
    const m = computeWindowMetrics({
      events,
      windowStart: T0,
      windowEnd: T_END,
      utilizationPct: 10,
    });
    // 内部保持比值，避免两种单位在内部混用
    expect(m.multiMachineOverlap).toBeLessThan(1);
    expect(m.sessionCutRate).toBeLessThanOrEqual(1);
  });
});

describe("7d calendar projection (§7.2)", () => {
  const MON = new Date("2026-09-21T00:00:00.000Z"); // 周一
  const flat = [1, 1, 1, 1, 1, 1, 1];

  it("integrates weekday weights over a span", () => {
    expect(calendarWeight(MON, new Date(MON.getTime() + 2 * 86400_000), flat)).toBeCloseTo(2, 9);
    expect(calendarWeight(MON, MON, flat)).toBe(0);
    // 周一权重 2、周二权重 1 → 两天合计 3 个加权天
    const w = [1, 2, 1, 1, 1, 1, 1];
    expect(calendarWeight(MON, new Date(MON.getTime() + 2 * 86400_000), w)).toBeCloseTo(3, 9);
    // 半天也要按比例算
    expect(calendarWeight(MON, new Date(MON.getTime() + 43200_000), w)).toBeCloseTo(1, 9);
  });

  it("falls back to flat weights when there is less than a week of history", () => {
    const events = [makeEvent({ ts: MON }), makeEvent({ ts: new Date(MON.getTime() + 86400_000) })];
    // 拿三天数据去推一周的节律只会得到噪声，老实退化成线性
    expect(weekdayWeightsFromEvents(events)).toEqual(flat);
  });

  it("recovers a weekday rhythm from enough history", () => {
    const events = [];
    for (let d = 0; d < 28; d++) {
      const ts = new Date(MON.getTime() + d * 86400_000);
      // 周六(6)/周日(0) 只用工作日的十分之一
      const weekend = ts.getUTCDay() === 0 || ts.getUTCDay() === 6;
      events.push(makeEvent({ ts, inputTokens: weekend ? 1000 : 10000, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }));
    }
    const w = weekdayWeightsFromEvents(events);
    expect(w[1]!).toBeGreaterThan(w[6]!);
    expect(w[0]!).toBeLessThan(0.5);
    // 均值归一到 1
    expect(w.reduce((a, b) => a + b, 0) / 7).toBeCloseTo(1, 6);
  });

  it("projects from consumed-per-weighted-day, not from the instantaneous rate", () => {
    // 41% 花掉了 4 天，还剩 3 天 → 41/4*3 = 30.75 增量
    const now = new Date(MON.getTime() + 4 * 86400_000);
    const p = projectCalendarWindow({
      pctNow: 41,
      now,
      windowStart: MON,
      windowEnd: new Date(MON.getTime() + 7 * 86400_000),
      weights: flat,
      dispersion: { k25: 1, k75: 1 },
    });
    expect(p.projected.mid).toBeCloseTo(71.75, 6);
    // 本窗口打不满 —— 线性外推最近半小时的速率会给出一个假的耗尽时刻
    expect(p.exhaustEta).toBeNull();
  });

  it("finds the exhaust moment on the weighted timeline", () => {
    const now = new Date(MON.getTime() + 4 * 86400_000);
    const p = projectCalendarWindow({
      pctNow: 80,
      now,
      windowStart: MON,
      windowEnd: new Date(MON.getTime() + 7 * 86400_000),
      weights: flat,
      dispersion: { k25: 1, k75: 1 },
    });
    // 80% / 4 天 = 20 %/天 → 还需 1 天打满
    expect(p.exhaustEta!.getTime()).toBeCloseTo(now.getTime() + 86400_000, -3);
  });

  it("borrows only the relative band width from the linear model", () => {
    expect(dispersionFrom(60, { p25: 70, mid: 80, p75: 100 })).toEqual({ k25: 0.5, k75: 2 });
    // 线性中心估计没有前进时不硬造带宽
    expect(dispersionFrom(60, { p25: 60, mid: 60, p75: 60 })).toEqual({ k25: 1, k75: 1 });
  });
});

describe("projected curve (§2.1)", () => {
  const now = new Date("2026-09-21T08:00:00.000Z");
  const end = new Date("2026-09-21T13:00:00.000Z");

  it("starts at the current pct and ends exactly on projected_pct", () => {
    const curve = buildProjectedCurve({
      now,
      windowEnd: end,
      pctNow: 62,
      endpoint: { p25: 75, mid: 87, p75: 99 },
      shape: (t) => (t.getTime() - now.getTime()) / (end.getTime() - now.getTime()),
      points: 6,
    });
    expect(curve).toHaveLength(6);
    expect(curve[0]).toEqual({ ts: now.toISOString(), p25: 62, mid: 62, p75: 62 });
    // 终点必须与 projected_pct 完全一致，否则前端会看到曲线和数字对不上
    expect(curve[5]).toEqual({ ts: end.toISOString(), p25: 75, mid: 87, p75: 99 });
    expect(curve[3]!.p25).toBeLessThanOrEqual(curve[3]!.mid);
    expect(curve[3]!.mid).toBeLessThanOrEqual(curve[3]!.p75);
  });

  it("bends with the shape function instead of going straight", () => {
    const linear = buildProjectedCurve({
      now,
      windowEnd: end,
      pctNow: 0,
      endpoint: { p25: 100, mid: 100, p75: 100 },
      shape: (t) => (t.getTime() - now.getTime()) / (end.getTime() - now.getTime()),
      points: 3,
    });
    const bent = buildProjectedCurve({
      now,
      windowEnd: end,
      pctNow: 0,
      endpoint: { p25: 100, mid: 100, p75: 100 },
      // 前半程几乎不涨（模拟周末），后半程补上
      shape: (t) => ((t.getTime() - now.getTime()) / (end.getTime() - now.getTime())) ** 3,
      points: 3,
    });
    expect(linear[1]!.mid).toBeCloseTo(50, 6);
    expect(bent[1]!.mid).toBeCloseTo(12.5, 6);
    expect(bent[2]!.mid).toBe(100);
  });

  it("clamps to 0..100 and returns nothing for an already-closed window", () => {
    const curve = buildProjectedCurve({
      now,
      windowEnd: end,
      pctNow: 90,
      endpoint: { p25: 95, mid: 130, p75: 200 },
      shape: () => 1,
      points: 3,
    });
    expect(curve.every((p) => p.mid <= 100 && p.p75 <= 100)).toBe(true);
    expect(
      buildProjectedCurve({
        now: end,
        windowEnd: now,
        pctNow: 10,
        endpoint: { p25: 1, mid: 1, p75: 1 },
        shape: () => 1,
        points: 3,
      }),
    ).toEqual([]);
  });
});

describe("calibration scatter points", () => {
  const obs: CalibObservation[] = [
    { deltaPct: 2, tokensByModel: { opus: 20000 }, singleMachine: true },
    { deltaPct: 0, tokensByModel: { opus: 100 }, singleMachine: true },
    { deltaPct: 3, tokensByModel: { opus: 30000 }, singleMachine: false },
    { deltaPct: 1, tokensByModel: { opus: 5000, fable: 10000 }, singleMachine: true },
  ];

  it("keeps exactly the observations the regression used", () => {
    const pts = calibrationPoints(obs, {
      weights: { opus: 1, fable: 0.5 },
      limitWeightedTokens: 1_000_000,
    });
    // Δpct=0 的与多机的都不参与回归，散点里也不能有
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ weighted_tokens: 20000, delta_pct: 2, fitted_pct: 2 });
    // 5000*1 + 10000*0.5 = 10000 → 1%
    expect(pts[1]).toEqual({ weighted_tokens: 10000, delta_pct: 1, fitted_pct: 1 });
  });

  it("caps how many points it stores", () => {
    const many = Array.from({ length: 5000 }, () => obs[0]!);
    expect(calibrationPoints(many, { weights: { opus: 1 }, limitWeightedTokens: 1e6 }, 100)).toHaveLength(100);
  });
});

describe("distribution buckets and series", () => {
  it("buckets by attribution level", () => {
    const buckets = buildDistribution(
      [
        { event: makeEvent({ attributionLevel: "proxy" }), costUsd: null },
        { event: makeEvent({ attributionLevel: "proxy" }), costUsd: null },
        { event: makeEvent({ attributionLevel: "unknown" }), costUsd: null },
      ],
      "attribution",
    );
    expect(buckets.map((b) => [b.key, b.events])).toEqual([
      ["proxy", 2],
      ["unknown", 1],
    ]);
  });

  it("keys by=hour on the RFC3339 hour start, not a 0..23 index", () => {
    expect(distributionKey(makeEvent({ ts: at(0) }), "hour")).toBe("2026-09-21T05:00:00.000Z");
    // 热力图要靠完整时刻分星期几，只留 0..23 序号就分不出来了
    expect(distributionKey(makeEvent({ ts: at(0) }), "hour")).not.toBe("5");
    expect(truncToBucket(at(95), "day")).toBe("2026-09-21T00:00:00.000Z");
  });

  it("omits series when bucket=none and fills it otherwise", () => {
    const rows = [
      { event: makeEvent({ ts: at(0), machineId: "a" }), costUsd: null },
      { event: makeEvent({ ts: at(20), machineId: "a" }), costUsd: null },
      { event: makeEvent({ ts: at(90), machineId: "a" }), costUsd: null },
    ];
    expect(buildDistribution(rows, "machine")[0]!.series).toBeUndefined();

    const hourly = buildDistribution(rows, "machine", "hour")[0]!;
    // 05:30 与 05:50 同一小时，07:00 另起一格
    expect(hourly.series!.map((p) => [p.ts, p.events])).toEqual([
      ["2026-09-21T05:00:00.000Z", 2],
      ["2026-09-21T07:00:00.000Z", 1],
    ]);
    expect(hourly.series!.reduce((s, p) => s + p.events, 0)).toBe(hourly.events);

    const daily = buildDistribution(rows, "machine", "day")[0]!;
    expect(daily.series).toHaveLength(1);
    // SeriesPoint 直接上线格式，所以是 total_tokens；桶对象是内部类型，用 totalTokens
    expect(daily.series![0]!.total_tokens).toBe(hourly.totalTokens);
  });
});

describe("misc", () => {
  it("quotaTokens sums every token class", () => {
    const e = makeEvent({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWrite5mTokens: 8,
      cacheWrite1hTokens: 16,
    });
    expect(quotaTokens(e)).toBe(31);
  });

  it("downsample keeps first and last", () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsample(pts, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out[9]).toBe(999);
  });

  it("renders only the percentage part of the tray title", () => {
    // 倒计时归客户端算：服务端渲染的倒计时在两次轮询之间就过期了
    expect(formatTrayTitlePct(62)).toBe("62%");
    expect(formatTrayTitlePct(61.6)).toBe("62%");
    expect(formatTrayTitlePct(null)).toBe("--%");
  });
});
