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

// ── 时间刻度补零 ────────────────────────────────────────────────────────────
/**
 * 区间内**每一个**桶的起点（毫秒），与服务端 truncToBucket 同一口径（UTC 取整）。
 *
 * ★ 服务端只回有数据的桶。以前直接拿「有数据的桶」当类目轴，
 * 空着的小时就被整段挤掉了：17:00、19:00、21:00、22:00、11:00 等距排开，
 * 夜里十几个小时的空白看起来和相邻两小时一样宽 —— 轴在说谎。
 * 补齐之后，空档就是空档。
 *
 * 天桶按 UTC 零点取整（服务端如此），本地显示时是早上 8 点起算的一天；
 * 这里跟随服务端，保证补出来的刻度能和数据对上。
 */
export function bucketTicks(fromMs: number, toMs: number, bucket: "hour" | "day"): number[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const step = bucket === "hour" ? 3_600_000 : 86_400_000;
  const start = Math.floor(fromMs / step) * step;
  const out: number[] = [];
  // 上限防呆：30d 按天是 31 个，24h 按小时是 25 个；超过 2000 说明参数错了
  for (let ts = start; ts < toMs && out.length < 2000; ts += step) out.push(ts);
  return out;
}

export type UsageMetric = "cost" | "tokens";

export interface MetricSeries {
  key: string;
  label: string;
  /** 与 ticks 一一对应。cost 口径下 null = 该桶有事件但全部缺价（不是 $0） */
  values: Array<number | null>;
}

/**
 * by=machine（或任意维度）+ bucket 的分桶 → 按给定刻度对齐的堆叠序列。
 *
 * 空桶的值：tokens 口径是 0；cost 口径也是 0 —— 那一小时**没有任何事件**，
 * 确实一分钱没花。这和「有事件但缺价」（null）是两回事，不能混。
 */
export function alignedSeries(
  buckets: DistributionBucket[],
  ticks: number[],
  metric: UsageMetric,
  labelOf: (b: DistributionBucket) => string,
): MetricSeries[] {
  return buckets.map((b) => {
    const at = new Map((b.series ?? []).map((p) => [Date.parse(p.ts), p]));
    return {
      key: b.key,
      label: labelOf(b),
      values: ticks.map((ts) => {
        const p = at.get(ts);
        if (!p) return 0;
        return metric === "tokens" ? p.total_tokens : p.cost_usd;
      }),
    };
  });
}

// ── 区间合计 ────────────────────────────────────────────────────────────────
export interface UsageTotals {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  events: number;
  cost: CostSummary;
  /** 缓存命中率 0..100；没有任何输入侧 token 时为 null（不是 0%） */
  cacheHitPct: number | null;
  /**
   * 平均每次调用带进模型的上下文 = 输入侧总量（未缓存 + 缓存读 + 缓存写）÷ 调用次数。
   * 这是额度消耗的主因：Claude Code 每次调用都把整段会话重新送一遍，
   * 会话越长这个数越大 —— 比单独一个「调用次数」有信息量得多。
   */
  avgContext: number | null;
  /** 平均每次调用折算多少钱。只按有报价的调用平均；全部缺价时 null（不是 $0） */
  avgCostPerCall: number | null;
}

/**
 * 缓存命中率 = 缓存读 ÷ **输入侧**总量（输入 + 缓存读 + 缓存写）。
 *
 * 以前除的是 total_tokens，把输出也算进了分母。输出从来不走缓存，
 * 放进分母只会让命中率随「这一轮写了多少字」上下飘，和缓存本身无关。
 */
export function cacheHitPct(input: number, cacheRead: number, cacheWrite: number): number | null {
  const denom = input + cacheRead + cacheWrite;
  return denom > 0 ? (cacheRead / denom) * 100 : null;
}

export function usageTotals(buckets: DistributionBucket[]): UsageTotals {
  let totalTokens = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let events = 0;
  for (const b of buckets) {
    totalTokens += b.total_tokens;
    input += b.input_tokens;
    output += b.output_tokens;
    cacheRead += b.cache_read_tokens;
    cacheWrite += b.cache_write_5m_tokens + b.cache_write_1h_tokens;
    events += b.events;
  }
  const cost = costSummary(buckets);
  const priced = events - cost.unpricedEvents;
  return {
    totalTokens,
    input,
    output,
    cacheRead,
    cacheWrite,
    events,
    cost,
    cacheHitPct: cacheHitPct(input, cacheRead, cacheWrite),
    avgContext: events > 0 ? (input + cacheRead + cacheWrite) / events : null,
    avgCostPerCall: cost.usd !== null && priced > 0 ? cost.usd / priced : null,
  };
}

export function bucketCacheHitPct(b: DistributionBucket): number | null {
  return cacheHitPct(
    b.input_tokens,
    b.cache_read_tokens,
    b.cache_write_5m_tokens + b.cache_write_1h_tokens,
  );
}

/**
 * 表格排序：有报价的按金额降序，缺价的沉底再按 token 降序。
 * 金额才是这张表要回答的问题（「钱花在哪个模型上」），token 只是旁证。
 */
export function byCostThenTokens(a: DistributionBucket, b: DistributionBucket): number {
  if (a.cost_usd !== null && b.cost_usd !== null && a.cost_usd !== b.cost_usd) {
    return b.cost_usd - a.cost_usd;
  }
  if (a.cost_usd === null && b.cost_usd !== null) return 1;
  if (a.cost_usd !== null && b.cost_usd === null) return -1;
  return b.total_tokens - a.total_tokens;
}

// ── 模型显示名 ──────────────────────────────────────────────────────────────
const FAMILY = ["opus", "sonnet", "haiku", "fable", "mythos"];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * `claude-opus-5-5` → `Opus 5.5`，`claude-sonnet-4-5-20250929` → `Sonnet 4.5`，
 * `claude-3-7-sonnet-20250219` → `Sonnet 3.7`。
 *
 * 只管显示；取色、过滤一律用原始 model 字符串。认不出的原样返回，
 * 不猜 —— 猜错一个名字比显示原始 id 更误导。
 */
export function modelDisplayName(model: string): string {
  const m = model
    .trim()
    .toLowerCase()
    .replace(/^claude[-.]/, "")
    .replace(/\[[^\]]*\]$/, "") // 网关后缀：opus-5[1m]
    .replace(/@.*$/, "") // Vertex 快照：opus-4-5@20251101
    .replace(/-\d{8}$/, ""); // 日期快照

  const modern = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(m);
  if (modern && FAMILY.includes(modern[1]!)) {
    return `${cap(modern[1]!)} ${modern[2]}${modern[3] ? `.${modern[3]}` : ""}`;
  }
  const legacy = /^(\d+)(?:-(\d+))?-([a-z]+)$/.exec(m);
  if (legacy && FAMILY.includes(legacy[3]!)) {
    return `${cap(legacy[3]!)} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ""}`;
  }
  return model;
}
