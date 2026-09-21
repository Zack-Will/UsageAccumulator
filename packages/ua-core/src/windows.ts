import type { UsageEvent } from "./types.js";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export interface Block {
  startsAt: Date;
  endsAt: Date;
  events: UsageEvent[];
}

function floorToHour(d: Date): Date {
  const x = new Date(d.getTime());
  x.setUTCMinutes(0, 0, 0);
  return x;
}

/**
 * 本地推算窗口切分（借鉴 ccusage 的 blocks 算法）：
 *   - 首个事件所在整点向下取整作为块起点
 *   - 块长 windowMs
 *   - 相邻事件间隔超过 windowMs 时另起新块
 *
 * 注意：这只是**推算**。真实窗口以官方 resets_at 为准，
 * 两者的差值就是「窗口偏移」指标，见 ARCHITECTURE.md §7.5。
 */
export function segmentBlocks(events: UsageEvent[], windowMs = FIVE_HOURS_MS): Block[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let prevTs = 0;

  for (const e of sorted) {
    const t = e.ts.getTime();
    const needNew =
      cur === null || t >= cur.endsAt.getTime() || (prevTs > 0 && t - prevTs > windowMs);
    if (needNew) {
      const startsAt = floorToHour(e.ts);
      cur = { startsAt, endsAt: new Date(startsAt.getTime() + windowMs), events: [] };
      blocks.push(cur);
    }
    cur!.events.push(e);
    prevTs = t;
  }
  return blocks;
}

export interface QuotaSample {
  ts: Date;
  pct: number;
}

export interface Projection {
  ratePctPerMin: number;
  projected: { p25: number; mid: number; p75: number };
  /** null 表示按当前速率本窗口不会耗尽 */
  exhaustEta: Date | null;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

/**
 * 窗口末用量预测。
 *
 * 口径是**百分比**而非 token —— 官方只给百分比，且这样不依赖标定，
 * 第一天就能用（见 ARCHITECTURE.md §7.0 / §7.1）。
 *
 * 给出三条线而非单点：一次 backfill 或长 context 会话就能把线性外推打飞，
 * 单点预测在这种波动下没有意义。
 */
export function projectWindow(args: {
  samples: QuotaSample[];
  now: Date;
  windowEnd: Date;
  /** 速率取样回看窗口，默认 30 分钟 */
  lookbackMs?: number;
  /** EWMA 半衰期，默认 10 分钟 */
  halfLifeMs?: number;
}): Projection {
  const lookbackMs = args.lookbackMs ?? 30 * 60 * 1000;
  const halfLifeMs = args.halfLifeMs ?? 10 * 60 * 1000;
  const nowMs = args.now.getTime();

  const samples = [...args.samples]
    .filter((s) => Number.isFinite(s.pct))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const lastPct = samples.length > 0 ? (samples[samples.length - 1]!.pct ?? 0) : 0;
  const remainingMin = Math.max(0, (args.windowEnd.getTime() - nowMs) / 60000);

  // 相邻采样点之间的速率（%/min），只取回看窗口内、且时间真的前进了的
  const rates: number[] = [];
  let ewma = 0;
  let ewmaInit = false;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dtMin = (b.ts.getTime() - a.ts.getTime()) / 60000;
    if (dtMin <= 0) continue;
    // 百分比归零 = 跨了窗口边界，这段不能用来算速率
    if (b.pct < a.pct) continue;
    if (nowMs - b.ts.getTime() > lookbackMs) continue;
    const r = (b.pct - a.pct) / dtMin;
    rates.push(r);
    if (!ewmaInit) {
      ewma = r;
      ewmaInit = true;
    } else {
      const alpha = 1 - Math.pow(0.5, dtMin / (halfLifeMs / 60000));
      ewma = alpha * r + (1 - alpha) * ewma;
    }
  }

  const sortedRates = [...rates].sort((x, y) => x - y);
  const rMid = ewmaInit ? ewma : 0;
  const rLo = sortedRates.length > 0 ? quantile(sortedRates, 0.25) : 0;
  const rHi = sortedRates.length > 0 ? quantile(sortedRates, 0.75) : 0;

  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const projected = {
    p25: clamp(lastPct + rLo * remainingMin),
    mid: clamp(lastPct + rMid * remainingMin),
    p75: clamp(lastPct + rHi * remainingMin),
  };

  let exhaustEta: Date | null = null;
  if (rMid > 0 && lastPct < 100) {
    const minsToFull = (100 - lastPct) / rMid;
    if (minsToFull <= remainingMin) {
      exhaustEta = new Date(nowMs + minsToFull * 60000);
    }
  }

  return { ratePctPerMin: rMid, projected, exhaustEta };
}

/** 本地推算窗口终点与官方 resets_at 的偏移（分钟，正数=官方更晚）。 */
export function windowOffsetMin(localEnd: Date, officialResetsAt: Date): number {
  return (officialResetsAt.getTime() - localEnd.getTime()) / 60000;
}

/** 跨窗口边界的会话数 / 总会话数，即「会话切断率」。 */
export function sessionCutRate(events: UsageEvent[], boundaries: Date[]): number {
  const bySession = new Map<string, { min: number; max: number }>();
  for (const e of events) {
    const t = e.ts.getTime();
    const cur = bySession.get(e.sessionId);
    if (!cur) bySession.set(e.sessionId, { min: t, max: t });
    else {
      cur.min = Math.min(cur.min, t);
      cur.max = Math.max(cur.max, t);
    }
  }
  if (bySession.size === 0) return 0;
  const bs = boundaries.map((b) => b.getTime());
  let cut = 0;
  for (const span of bySession.values()) {
    if (bs.some((b) => span.min < b && span.max > b)) cut++;
  }
  return cut / bySession.size;
}

/**
 * 多机重叠度：窗口内有 >=2 台机器同时产生用量的时间占比。
 * 每个事件按 bucketMs 归桶，桶内出现 >=2 个 machineId 即算重叠。
 */
export function multiMachineOverlap(
  events: UsageEvent[],
  windowStart: Date,
  windowEnd: Date,
  bucketMs = 60_000,
): number {
  const total = Math.max(1, Math.ceil((windowEnd.getTime() - windowStart.getTime()) / bucketMs));
  const buckets = new Map<number, Set<string>>();
  for (const e of events) {
    const t = e.ts.getTime();
    if (t < windowStart.getTime() || t >= windowEnd.getTime()) continue;
    const idx = Math.floor((t - windowStart.getTime()) / bucketMs);
    let s = buckets.get(idx);
    if (!s) {
      s = new Set();
      buckets.set(idx, s);
    }
    s.add(e.machineId);
  }
  let overlapped = 0;
  for (const s of buckets.values()) if (s.size >= 2) overlapped++;
  return overlapped / total;
}
