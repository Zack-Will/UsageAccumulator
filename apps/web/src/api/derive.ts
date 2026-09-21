/**
 * 契约形状 → 图表需要的形状。
 *
 * 只做几何与聚合，不发明任何服务端字段：重叠度指标、预测曲线、分桶时间序列
 * 现在全部由服务端给，这里不再有任何「反推」。
 */
import type { DistributionBucket, Machine, Timeline, TimelineLane, TimelineSpan } from "./types";

const MIN = 60_000;

// ── 机器名 ──────────────────────────────────────────────────────────────────
/**
 * 机器名册，**只管显示，不参与取色**。
 *
 * 取色一律按 CONTRACT §2.1a 的 `key`（by=machine 时就是 machine_id），
 * 因为 machine_id 是稳定 id，而 label 是展示文案 —— 主机改个名，按 label 取色就会满图换颜色。
 * 这里的用处只有一个：bucket.label 缺省时，拿 /v1/machines 补一个比 UUID 好看的名字。
 */
export interface MachineIndex {
  /** machine_id → 展示名；名册里没有就原样返回 */
  label(machineId: string): string;
}

export function machineIndex(machines: Machine[]): MachineIndex {
  const byId = new Map(machines.map((m) => [m.machine_id, m]));
  return { label: (id) => byId.get(id)?.label ?? id };
}

/** 展示名：bucket.label 优先，缺省时退到调用方给的兜底，再退到 key 本身。 */
export function bucketLabel(
  b: DistributionBucket,
  fallback?: (key: string) => string,
): string {
  return b.label ?? fallback?.(b.key) ?? b.key;
}

// ── 甘特图色块 ──────────────────────────────────────────────────────────────
export interface GanttSegment {
  laneIndex: number;
  machineId: string;
  startMs: number;
  endMs: number;
  tokens: number;
  events: number;
  /** 0..1，用于色块深浅。按全图最大 token 速率归一。 */
  intensity: number;
  /** 承接自上一窗口：span 跨过窗口边界，边界之后的那一截。 */
  carriedOver: boolean;
}

/**
 * 把 span 在窗口边界处切开。
 * 「承接自上一窗口被切断」在契约里没有显式字段，但它等价于
 * 「一个 span 跨过了 window_boundaries 里的某个时刻」—— 切开后靠右的子段就是被承接的那截。
 * 完全可从现有数据推得，不需要服务端加字段。
 */
function splitAtBoundaries(span: TimelineSpan, boundaries: number[]): Array<[number, number, boolean]> {
  const from = Date.parse(span.from);
  const to = Date.parse(span.to);
  const inner = boundaries.filter((b) => b > from && b < to).sort((a, b) => a - b);
  const out: Array<[number, number, boolean]> = [];
  let cursor = from;
  for (const b of inner) {
    out.push([cursor, b, cursor !== from]);
    cursor = b;
  }
  out.push([cursor, to, cursor !== from]);
  return out;
}

export function ganttSegments(timeline: Timeline): GanttSegment[] {
  const boundaries = timeline.window_boundaries.map((b) => Date.parse(b));
  const raw: GanttSegment[] = [];
  let maxRate = 0;

  timeline.lanes.forEach((lane, laneIndex) => {
    for (const span of lane.spans) {
      for (const [s, e, carried] of splitAtBoundaries(span, boundaries)) {
        const spanMs = Math.max(MIN, Date.parse(span.to) - Date.parse(span.from));
        const share = (e - s) / spanMs;
        const tokens = span.tokens * share;
        const rate = tokens / Math.max(MIN, e - s);
        if (rate > maxRate) maxRate = rate;
        raw.push({
          laneIndex,
          machineId: lane.machine_id,
          startMs: s,
          endMs: e,
          tokens,
          events: Math.round(span.events * share),
          intensity: rate,
          carriedOver: carried,
        });
      }
    }
  });

  const denom = maxRate || 1;
  return raw.map((r) => ({ ...r, intensity: Math.min(1, r.intensity / denom) }));
}

// ── 多机重叠区 ──────────────────────────────────────────────────────────────
export interface GanttOverlap {
  startMs: number;
  endMs: number;
  loLane: number;
  hiLane: number;
}

/**
 * 重叠区是纯几何：服务端给了每条泳道的 spans 就能画出来。
 * 指标本身（multi_machine_overlap_pct）直接取服务端的 metrics，这里只负责画。
 */
export function ganttOverlaps(lanes: TimelineLane[], minMs = 5 * MIN): GanttOverlap[] {
  const out: GanttOverlap[] = [];
  for (let i = 0; i < lanes.length; i++) {
    for (let j = i + 1; j < lanes.length; j++) {
      const a = lanes[i];
      const b = lanes[j];
      if (!a || !b) continue;
      for (const sa of a.spans) {
        const as = Date.parse(sa.from);
        const ae = Date.parse(sa.to);
        for (const sb of b.spans) {
          const s = Math.max(as, Date.parse(sb.from));
          const e = Math.min(ae, Date.parse(sb.to));
          if (e - s >= minMs) out.push({ startMs: s, endMs: e, loLane: i, hiLane: j });
        }
      }
    }
  }
  return out;
}

// ── 二维分桶 → 堆叠柱 ───────────────────────────────────────────────────────
export interface StackSeries {
  key: string;
  label: string;
  points: Array<{ ts: number; tokens: number }>;
}

/**
 * `bucket=hour|day` 时每个 bucket 自带 series[]，直接铺成堆叠柱。
 * 各桶的时间刻度取并集，缺失刻度补 0，保证 stack 对齐。
 * series.key 原样保留 bucket.key（取色用），label 只用于显示。
 */
export function stackFromBuckets(
  buckets: DistributionBucket[],
  labelOf: (b: DistributionBucket) => string,
): StackSeries[] {
  const ticks = [
    ...new Set(buckets.flatMap((b) => (b.series ?? []).map((p) => Date.parse(p.ts)))),
  ].sort((a, b) => a - b);

  return buckets.map((b) => {
    const at = new Map((b.series ?? []).map((p) => [Date.parse(p.ts), p.total_tokens]));
    return {
      key: b.key,
      label: labelOf(b),
      points: ticks.map((ts) => ({ ts, tokens: at.get(ts) ?? 0 })),
    };
  });
}

// ── by=hour 桶 → 热力图 / 缓存趋势 ─────────────────────────────────────────
/** by=hour 的 bucket.key 是小时起点的 RFC3339 时刻（UTC）。 */
function parseHourKey(key: string): number | null {
  const ms = Date.parse(key);
  return Number.isNaN(ms) ? null : ms;
}

export interface HourCell {
  /** 0 = 周一 … 6 = 周日（本地时区呈现） */
  dow: number;
  hour: number;
  tokens: number;
}

export function hourCells(buckets: DistributionBucket[]): HourCell[] {
  const grid = new Map<string, number>();
  for (const b of buckets) {
    const ms = parseHourKey(b.key);
    if (ms === null) continue;
    const d = new Date(ms);
    const dow = (d.getDay() + 6) % 7;
    const k = `${dow}:${d.getHours()}`;
    grid.set(k, (grid.get(k) ?? 0) + b.total_tokens);
  }
  const cells: HourCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({ dow, hour, tokens: grid.get(`${dow}:${hour}`) ?? 0 });
    }
  }
  return cells;
}

export interface CachePoint {
  ts: number;
  cacheReadPct: number;
}

/** cache_read 占比（ARCHITECTURE §7.4）：cache_read_tokens / total_tokens。 */
export function cacheTrend(buckets: DistributionBucket[]): CachePoint[] {
  return buckets
    .map((b) => {
      const ms = parseHourKey(b.key);
      if (ms === null || b.total_tokens <= 0) return null;
      return { ts: ms, cacheReadPct: (b.cache_read_tokens / b.total_tokens) * 100 };
    })
    .filter((x): x is CachePoint => x !== null)
    .sort((a, b) => a.ts - b.ts);
}

// ── 成本汇总：必须区分「为 0」与「未知」 ──────────────────────────────────
export interface CostSummary {
  /** 所有桶都没有报价时为 null。 */
  usd: number | null;
  /** 有多少事件缺价 —— >0 时数字旁必须带标记。 */
  unpricedEvents: number;
  totalEvents: number;
}

export function costSummary(buckets: DistributionBucket[]): CostSummary {
  let usd: number | null = null;
  let unpriced = 0;
  let events = 0;
  for (const b of buckets) {
    if (b.cost_usd !== null) usd = (usd ?? 0) + b.cost_usd;
    unpriced += b.unpriced_events;
    events += b.events;
  }
  return { usd, unpricedEvents: unpriced, totalEvents: events };
}

// ── 占比 ────────────────────────────────────────────────────────────────────
export function sharePct(buckets: DistributionBucket[], b: DistributionBucket): number {
  const total = buckets.reduce((a, x) => a + x.total_tokens, 0);
  return total > 0 ? (b.total_tokens / total) * 100 : 0;
}

/**
 * 项目 slug → 可读名，**仅作 bucket.label 缺省时的兜底**。
 * CONTRACT §1.1 允许 project_slug 被 HMAC 化，那种情况下截断显示。
 */
export function projectLabel(slug: string): string {
  if (/^[0-9a-f]{16,}$/i.test(slug)) return slug.slice(0, 10);
  const tail = slug.split("-").filter(Boolean).slice(-1)[0];
  return tail ?? slug;
}
