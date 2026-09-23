import {
  FIVE_HOURS_MS,
  multiMachineOverlap,
  segmentBlocks,
  sessionCutRate,
  windowOffsetMin,
  type CalibObservation,
  type QuotaSample,
  type UsageEvent,
} from "@ua/core";
import { countsTowardQuota } from "./pricing.js";

/**
 * 聚合逻辑。**全部是纯函数** —— 数据库只负责把行取出来，算法在这里，
 * 于是不起 Postgres 也能完整测到 §7.5 的四个指标。
 */

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 0..1 的比值 → 0..100 的百分比。
 *
 * CONTRACT §4：线格式里凡以 `_pct` 结尾的字段都是 0..100，而 `@ua/core` 的
 * multiMachineOverlap() / sessionCutRate() 返回的是 0..1 的比值。转换只在
 * 序列化那一层做，内部一律保持 core 的口径 —— 两种单位在内部混用迟早会有人乘错。
 */
export function ratioToPct(ratio: number): number {
  return ratio * 100;
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/**
 * window_kind → 窗口长度。
 * window_kind 是自由字符串（官方字段名未实测确认，ARCHITECTURE §2.2），
 * 所以这里靠模式匹配而不是枚举；认不出来的按 5h 处理并由调用方标注。
 */
export function inferWindowMs(kind: string): number {
  const k = kind.toLowerCase();
  if (k.includes("seven") || k.includes("7d") || k.includes("week")) return SEVEN_DAYS_MS;
  if (k.includes("five") || k.includes("5h") || k.includes("hour")) return FIVE_HOURS_MS;
  return FIVE_HOURS_MS;
}

/** 菜单栏用的短标签。认不出的 window_kind 原样透出，不要猜。 */
export function windowLabel(kind: string): string {
  const k = kind.toLowerCase();
  if (k === "five_hour") return "5h";
  if (k === "seven_day") return "7d";
  if (k.startsWith("seven_day_")) {
    const suffix = kind.slice("seven_day_".length).replace(/_/g, " ");
    return `7d ${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}`;
  }
  return kind;
}

/**
 * 窗口浪费度（ARCHITECTURE §7.5）：`(limit - used_at_window_end) / limit`。
 * 百分比口径下 limit 恒为 100，所以就是 100 - pct。不依赖标定，第一天就能用。
 */
export function windowWastePct(utilizationPctAtEnd: number): number {
  return Math.min(100, Math.max(0, 100 - utilizationPctAtEnd));
}

/** 参与限额统计的事件：排除 `<synthetic>`（实测 43 条合成标记）。 */
export function quotaEvents(events: UsageEvent[]): UsageEvent[] {
  return events.filter((e) => countsTowardQuota(e.model));
}

/** 一条事件计入限额的 token 总量。cache_read 也算 —— 官方口径未知，宁可全计。 */
export function quotaTokens(e: UsageEvent): number {
  return (
    e.inputTokens +
    e.outputTokens +
    e.cacheReadTokens +
    e.cacheWrite5mTokens +
    e.cacheWrite1hTokens
  );
}

export interface WindowMetrics {
  /** 官方 resets_at − 本地推算窗口终点，分钟；没有本地块时 null */
  localWindowOffsetMin: number | null;
  /** 窗口内 ≥2 台机器同时产生用量的时间占比，0..1 */
  multiMachineOverlap: number;
  /** 跨窗口边界的会话数 / 总会话数，0..1 */
  sessionCutRate: number;
  /** 窗口浪费度，0..100 */
  windowWastePct: number;
  machines: string[];
  events: number;
  tokens: number;
}

/**
 * §7.5 的四个指标一次算齐。
 * 传入的 events 应已限定在 [windowStart, windowEnd) 附近；本函数自己排除合成事件。
 */
export function computeWindowMetrics(args: {
  events: UsageEvent[];
  windowStart: Date;
  windowEnd: Date;
  utilizationPct: number;
  /** 本地推算的窗口长度，默认按官方窗口长度 */
  localWindowMs?: number;
}): WindowMetrics {
  const events = quotaEvents(args.events);
  const windowMs = args.localWindowMs ?? args.windowEnd.getTime() - args.windowStart.getTime();

  // 本地推算窗口：取覆盖 windowStart 的那个块，拿它的终点与官方 resets_at 比
  const blocks = segmentBlocks(events, windowMs);
  let offset: number | null = null;
  const candidate =
    [...blocks].reverse().find((b) => b.startsAt.getTime() <= args.windowEnd.getTime()) ?? null;
  if (candidate) offset = windowOffsetMin(candidate.endsAt, args.windowEnd);

  const inWindow = events.filter(
    (e) => e.ts >= args.windowStart && e.ts < args.windowEnd,
  );

  return {
    localWindowOffsetMin: offset,
    multiMachineOverlap: multiMachineOverlap(events, args.windowStart, args.windowEnd),
    // 边界取窗口起止两条竖线：跨过任一条的会话都算被切断
    sessionCutRate: sessionCutRate(events, [args.windowStart, args.windowEnd]),
    windowWastePct: windowWastePct(args.utilizationPct),
    machines: [...new Set(inWindow.map((e) => e.machineId))].sort(),
    events: inWindow.length,
    tokens: inWindow.reduce((s, e) => s + quotaTokens(e), 0),
  };
}

export interface TimelineSpan {
  from: Date;
  to: Date;
  events: number;
  tokens: number;
}

export interface TimelineLane {
  machineId: string;
  spans: TimelineSpan[];
  events: number;
  tokens: number;
}

/**
 * 甘特图泳道：每台机器一条，把相邻事件按 gapMs 合并成活跃区间。
 * 多机重叠与会话切断在这张图上是肉眼可见的（ARCHITECTURE §7.5）。
 */
export function buildTimelineLanes(events: UsageEvent[], gapMs = 5 * 60_000): TimelineLane[] {
  const byMachine = new Map<string, UsageEvent[]>();
  for (const e of quotaEvents(events)) {
    const list = byMachine.get(e.machineId);
    if (list) list.push(e);
    else byMachine.set(e.machineId, [e]);
  }

  const lanes: TimelineLane[] = [];
  for (const [machineId, list] of [...byMachine.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    list.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const spans: TimelineSpan[] = [];
    let cur: TimelineSpan | null = null;
    for (const e of list) {
      const t = e.ts.getTime();
      if (cur && t - cur.to.getTime() <= gapMs) {
        cur.to = e.ts;
        cur.events++;
        cur.tokens += quotaTokens(e);
      } else {
        cur = { from: e.ts, to: e.ts, events: 1, tokens: quotaTokens(e) };
        spans.push(cur);
      }
    }
    lanes.push({
      machineId,
      spans,
      events: list.length,
      tokens: list.reduce((s, e) => s + quotaTokens(e), 0),
    });
  }
  return lanes;
}

export type DistributionBy = "machine" | "model" | "project" | "hour" | "attribution" | "session";
/** series 的时间粒度；none = 不带 series */
export type SeriesBucket = "none" | "hour" | "day";

/** 归一到小时/天起点的 RFC3339（UTC）。 */
export function truncToBucket(ts: Date, bucket: "hour" | "day"): string {
  const d = new Date(ts.getTime());
  if (bucket === "hour") d.setUTCMinutes(0, 0, 0);
  else d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function distributionKey(e: UsageEvent, by: DistributionBy): string {
  switch (by) {
    case "machine":
      return e.machineId;
    case "model":
      return e.model;
    case "project":
      return e.projectSlug ?? "(unknown)";
    // 一个会话 = 一个 JSONL 文件 = 桌面端侧边栏里的一条对话
    case "session":
      return e.sessionId || "(unknown)";
    // 归属可信度（ARCHITECTURE §4.2 / §12 的 M5 验收项：归属可信度必须可见）
    case "attribution":
      return e.attributionLevel;
    // ★ key 是**小时起点的 RFC3339 时刻**，不是 0..23 的序号 ——
    //   热力图要拿它分星期几，丢掉日期就再也分不出来了（CONTRACT §2.1a）
    case "hour":
      return truncToBucket(e.ts, "hour");
  }
}

export interface SeriesPoint {
  ts: string;
  total_tokens: number;
  events: number;
  /** 与 bucket 同一套语义：null = 该时间点没有任何有报价的模型，不是 0 美元。 */
  cost_usd: number | null;
  /** 缺价的事件数；> 0 表示这一点的成本不完整。 */
  unpriced_events: number;
}

export interface DistributionBucket {
  key: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  totalTokens: number;
  /** 有报价部分的成本；unpricedEvents > 0 时它是不完整的 */
  costUsd: number | null;
  unpricedEvents: number;
  /** 仅在 bucket=hour|day 时出现：桶内随时间的展开，供「机器 × 24 小时堆叠柱」这类二维图 */
  series?: SeriesPoint[];
}

/**
 * 分布聚合（ARCHITECTURE §7.4）。
 * cost 只累加有报价的事件；缺价的条数单独报出去，让前端显示「成本不完整」
 * 而不是把缺价当成 0。
 *
 * bucket 非 none 时，每个桶额外带一条按时间展开的 series —— 否则前端只能从
 * timeline 的 spans 反推二维分布，那条路很脆。
 */
export function buildDistribution(
  events: { event: UsageEvent; costUsd: number | null }[],
  by: DistributionBy,
  bucket: SeriesBucket = "none",
): DistributionBucket[] {
  const map = new Map<string, DistributionBucket>();
  const series = new Map<string, Map<string, SeriesPoint>>();

  for (const { event, costUsd } of events) {
    if (!countsTowardQuota(event.model)) continue;
    const key = distributionKey(event, by);
    let b = map.get(key);
    if (!b) {
      b = {
        key,
        events: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 0,
        costUsd: null,
        unpricedEvents: 0,
      };
      map.set(key, b);
    }
    b.events++;
    b.inputTokens += event.inputTokens;
    b.outputTokens += event.outputTokens;
    b.cacheReadTokens += event.cacheReadTokens;
    b.cacheWrite5mTokens += event.cacheWrite5mTokens;
    b.cacheWrite1hTokens += event.cacheWrite1hTokens;
    b.totalTokens += quotaTokens(event);
    if (costUsd === null) b.unpricedEvents++;
    else b.costUsd = (b.costUsd ?? 0) + costUsd;

    if (bucket !== "none") {
      let inner = series.get(key);
      if (!inner) {
        inner = new Map();
        series.set(key, inner);
      }
      const ts = truncToBucket(event.ts, bucket);
      const p = inner.get(ts);
      if (p) {
        p.total_tokens += quotaTokens(event);
        p.events++;
        // 与桶同一套口径：缺价只计数，绝不当成 0 美元累加
        if (costUsd === null) p.unpriced_events++;
        else p.cost_usd = (p.cost_usd ?? 0) + costUsd;
      } else {
        inner.set(ts, {
          ts,
          total_tokens: quotaTokens(event),
          events: 1,
          cost_usd: costUsd,
          unpriced_events: costUsd === null ? 1 : 0,
        });
      }
    }
  }

  if (bucket !== "none") {
    for (const [key, b] of map) {
      b.series = [...(series.get(key)?.values() ?? [])].sort((x, y) => x.ts.localeCompare(y.ts));
    }
  }

  return [...map.values()].sort((a, b) =>
    by === "hour" ? a.key.localeCompare(b.key) : b.totalTokens - a.totalTokens,
  );
}

/**
 * 把「官方百分比采样 + 本地 token」配成标定观测（ARCHITECTURE §7.0）。
 *
 * 工程约束（不做会解出垃圾）：
 *  - 剔除 Δpct <= 0 的区间（窗口空闲，或跨了窗口边界导致 pct 归零）
 *  - 只有单机独占的区间才标 singleMachine=true，多机并发时本地可能收不全
 *  - 排除 `<synthetic>`，它不消耗限额
 */
export function buildObservations(
  samples: QuotaSample[],
  events: UsageEvent[],
  opts: { maxGapMs?: number } = {},
): CalibObservation[] {
  const maxGapMs = opts.maxGapMs ?? 30 * 60_000;
  const sorted = [...samples]
    .filter((s) => Number.isFinite(s.pct))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const evs = quotaEvents(events).sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const out: CalibObservation[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    const dt = b.ts.getTime() - a.ts.getTime();
    if (dt <= 0 || dt > maxGapMs) continue;
    const deltaPct = b.pct - a.pct;
    if (deltaPct <= 0) continue; // 空闲区间或窗口边界

    const slice = evs.filter((e) => e.ts >= a.ts && e.ts < b.ts);
    if (slice.length === 0) continue;

    const tokensByModel: Record<string, number> = {};
    const machines = new Set<string>();
    for (const e of slice) {
      tokensByModel[e.model] = (tokensByModel[e.model] ?? 0) + quotaTokens(e);
      machines.add(e.machineId);
    }
    out.push({ deltaPct, tokensByModel, singleMachine: machines.size <= 1 });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7d 窗口的日历模式预测（ARCHITECTURE §7.2）
//
// 7 天窗口里周末和工作日的用量差异巨大，线性外推会系统性高估。
// 所以 7d 不按「%/分钟」外推，而是按「星期几的相对强度」把剩余时间加权。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从历史事件里解出各星期几的相对用量强度，均值归一到 1。
 *
 * 数据不够就返回全 1 —— 那样日历模式退化成线性，和 §7.1 一致。
 * 拿三天数据去推一周的节律只会得到噪声，宁可老实退化。
 */
export function weekdayWeightsFromEvents(
  events: UsageEvent[],
  opts: { minDistinctDays?: number } = {},
): number[] {
  const minDays = opts.minDistinctDays ?? 7;
  const flat = [1, 1, 1, 1, 1, 1, 1];

  const perDay = new Map<string, { weekday: number; tokens: number }>();
  for (const e of quotaEvents(events)) {
    const key = truncToBucket(e.ts, "day");
    const cur = perDay.get(key);
    if (cur) cur.tokens += quotaTokens(e);
    else perDay.set(key, { weekday: e.ts.getUTCDay(), tokens: quotaTokens(e) });
  }
  if (perDay.size < minDays) return flat;

  const sum = new Array<number>(7).fill(0);
  const count = new Array<number>(7).fill(0);
  for (const { weekday, tokens } of perDay.values()) {
    sum[weekday] = (sum[weekday] ?? 0) + tokens;
    count[weekday] = (count[weekday] ?? 0) + 1;
  }

  // 没有观测到的星期几先记 NaN，稍后用总体均值补上，不要当成 0
  const avg = sum.map((s, i) => ((count[i] ?? 0) > 0 ? s / (count[i] ?? 1) : NaN));
  const seen = avg.filter((x) => Number.isFinite(x));
  if (seen.length === 0) return flat;
  const overall = seen.reduce((a, b) => a + b, 0) / seen.length;
  if (overall <= 0) return flat;

  // 夹在 [0.1, 5]：某一天有个超长会话不该把整条预测带飞
  return avg.map((x) => Math.min(5, Math.max(0.1, (Number.isFinite(x) ? x : overall) / overall)));
}

/** 按星期几权重对 [from, to) 积分，单位是「加权天」。 */
export function calendarWeight(from: Date, to: Date, weights: number[]): number {
  if (to.getTime() <= from.getTime()) return 0;
  let total = 0;
  let cursor = from.getTime();
  const end = to.getTime();
  // 守卫：7d 窗口最多 8 段，给足余量就够，绝不允许无限循环
  for (let guard = 0; cursor < end && guard < 4000; guard++) {
    const d = new Date(cursor);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const chunkEnd = Math.min(dayStart + DAY_MS, end);
    total += ((chunkEnd - cursor) / DAY_MS) * (weights[new Date(dayStart).getUTCDay()] ?? 1);
    cursor = chunkEnd;
  }
  return total;
}

/** 在 [now, windowEnd] 上反解出累计加权天数达到 target 的那个时刻。 */
function solveTimeForWeight(
  now: Date,
  windowEnd: Date,
  weights: number[],
  target: number,
): Date | null {
  if (target <= 0) return now;
  if (calendarWeight(now, windowEnd, weights) < target) return null;
  let lo = now.getTime();
  let hi = windowEnd.getTime();
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (calendarWeight(now, new Date(mid), weights) < target) lo = mid;
    else hi = mid;
  }
  return new Date(Math.round(hi));
}

export interface CalendarProjection {
  projected: { p25: number; mid: number; p75: number };
  exhaustEta: Date | null;
  /** 等效平均速率（%/min），仅供显示；日历模式下瞬时速率本来就不是常数 */
  ratePctPerMin: number;
}

/**
 * 日历模式预测。
 *
 * 中心估计不用观测到的瞬时速率，而是「窗口内已消耗的百分比 / 已过去的加权天数」，
 * 再乘以剩余的加权天数 —— 这样周末的低强度会被自动折算进去。
 *
 * 离散度（p25/p75）沿用线性模型算出来的相对带宽：官方只给百分比，没有别的
 * 不确定性来源，拿线性模型的三分位做相对带宽是能拿到的最好的东西。
 */
export function projectCalendarWindow(args: {
  pctNow: number;
  now: Date;
  windowStart: Date;
  windowEnd: Date;
  weights: number[];
  dispersion: { k25: number; k75: number };
}): CalendarProjection {
  const { pctNow, now, windowStart, windowEnd, weights, dispersion } = args;
  const elapsedWeight = calendarWeight(windowStart, now, weights);
  const remainingWeight = calendarWeight(now, windowEnd, weights);
  const remainingMin = Math.max(0, (windowEnd.getTime() - now.getTime()) / 60000);

  if (elapsedWeight <= 0 || remainingWeight <= 0) {
    return {
      projected: { p25: clampPct(pctNow), mid: clampPct(pctNow), p75: clampPct(pctNow) },
      exhaustEta: null,
      ratePctPerMin: 0,
    };
  }

  const ratePerWeight = pctNow / elapsedWeight;
  const inc = ratePerWeight * remainingWeight;
  const projected = {
    p25: clampPct(pctNow + dispersion.k25 * inc),
    mid: clampPct(pctNow + inc),
    p75: clampPct(pctNow + dispersion.k75 * inc),
  };

  let exhaustEta: Date | null = null;
  if (ratePerWeight > 0 && pctNow < 100) {
    exhaustEta = solveTimeForWeight(now, windowEnd, weights, (100 - pctNow) / ratePerWeight);
  }

  return {
    projected,
    exhaustEta,
    ratePctPerMin: remainingMin > 0 ? (projected.mid - pctNow) / remainingMin : 0,
  };
}

/**
 * 从线性模型的三分位里抽出**相对带宽**，好套用到日历模式的中心估计上。
 * 线性中心估计没有前进时退化为无带宽（三条线重合），不硬造一个宽度出来。
 */
export function dispersionFrom(
  pctNow: number,
  linear: { p25: number; mid: number; p75: number },
): { k25: number; k75: number } {
  const midInc = linear.mid - pctNow;
  if (!(midInc > 0)) return { k25: 1, k75: 1 };
  return {
    k25: Math.max(0, (linear.p25 - pctNow) / midInc),
    k75: Math.max(0, (linear.p75 - pctNow) / midInc),
  };
}

export interface ProjectedCurvePoint {
  ts: string;
  p25: number;
  mid: number;
  p75: number;
}

/**
 * 预测曲线：从 now 到窗口结束（CONTRACT §2.1）。
 *
 * **必须由服务端算**，前端不得拿 projected_pct 的终点自行线性外推 ——
 * 7d 走日历模式，线性外推会系统性偏离。
 *
 * shape(t) 是归一化形状函数：shape(now)=0、shape(windowEnd)=1。
 * 5h 传线性，7d 传日历权重的累计占比。终点恒等于 endpoint，
 * 所以 projected_curve 的最后一个点与 projected_pct 永远一致。
 */
export function buildProjectedCurve(args: {
  now: Date;
  windowEnd: Date;
  pctNow: number;
  endpoint: { p25: number; mid: number; p75: number };
  shape: (t: Date) => number;
  points: number;
}): ProjectedCurvePoint[] {
  const { now, windowEnd, pctNow, endpoint, shape } = args;
  const spanMs = windowEnd.getTime() - now.getTime();
  if (spanMs <= 0) return [];
  const n = Math.max(2, Math.min(args.points, 2000));

  const out: ProjectedCurvePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(now.getTime() + Math.round((spanMs * i) / (n - 1)));
    const s = i === n - 1 ? 1 : Math.min(1, Math.max(0, shape(t)));
    out.push({
      ts: t.toISOString(),
      p25: clampPct(pctNow + (endpoint.p25 - pctNow) * s),
      mid: clampPct(pctNow + (endpoint.mid - pctNow) * s),
      p75: clampPct(pctNow + (endpoint.p75 - pctNow) * s),
    });
  }
  return out;
}

export interface CalibrationPoint {
  weighted_tokens: number;
  delta_pct: number;
  fitted_pct: number;
}

/**
 * 逐观测点，供看板画「拟合散点」（CONTRACT §2.1a）。
 * 没有它，「观测点 47 个」只是个数字，看不出拟合好不好。
 *
 * 过滤条件与 @ua/core 的 calibrate() 保持一致（单机独占 + Δpct > 0）——
 * 散点必须是**实际参与回归的那些点**，混进被丢弃的点就看不出真实残差了。
 */
export function calibrationPoints(
  observations: CalibObservation[],
  fit: { weights: Record<string, number>; limitWeightedTokens: number },
  max = 1000,
): CalibrationPoint[] {
  const clean = observations.filter(
    (o) => o.singleMachine && Number.isFinite(o.deltaPct) && o.deltaPct > 0,
  );
  const points = clean.map((o) => {
    let weighted = 0;
    for (const [model, tokens] of Object.entries(o.tokensByModel)) {
      weighted += (fit.weights[model] ?? 0) * tokens;
    }
    return {
      weighted_tokens: weighted,
      delta_pct: o.deltaPct,
      fitted_pct:
        fit.limitWeightedTokens > 0 ? (weighted / fit.limitWeightedTokens) * 100 : 0,
    };
  });
  return downsample(points, max);
}

/** 燃尽曲线降采样，避免一条曲线塞几千个点。保留首尾。 */
export function downsample<T>(points: T[], max: number): T[] {
  // max = 2 是合法请求（首尾两点）；以前写成 max <= 2 会原样返回全部点，传 2 等于没传
  if (points.length <= max || max < 2) return points;
  const step = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/**
 * 菜单栏标题的**百分比部分**，仅此而已（CONTRACT §2.2）。
 *
 * 倒计时刻意不在服务端渲染：菜单栏每 30~60s 才轮询一次，服务端算好的
 * "1:48" 到客户端手里已经过期，托盘上挂一个慢一分钟的数字比不显示更糟。
 * 客户端拿 exhaust_eta 自己算、自己每分钟刷新。
 */
export function formatTrayTitlePct(pct: number | null): string {
  return pct === null ? "--%" : `${Math.round(pct)}%`;
}

/**
 * Claude 桌面端的「临时工作区」：不选项目文件夹直接开对话时，桌面端自己建一个
 * `…/Claude/scratch-workspaces/<org>/<user>/scratch-2026-09-22-105cae` 目录。
 * 目录名最后一段是随机后缀，拿它当项目名毫无意义（看板上以前就显示「105cae」）。
 * 这类项目一个目录对应一个会话，名字应该取会话标题。
 */
export function isScratchWorkspace(projectSlug: string | null | undefined): boolean {
  return !!projectSlug && projectSlug.includes("-scratch-workspaces-");
}
