import type { QuotaSample } from "./windows.js";

/**
 * 官方的「本周按产品」拆分（`seven_day_breakdown`），以及拿它补差额法的短板。
 *
 * claude.ai 的 `/api/organizations/{id}/usage` 与 Claude Code 的 `/api/oauth/usage`
 * 都带这个字段（2026-09-29 实测；线上库从 2026-09-21 第一条快照起就有，raw 原样入库）：
 *
 *     "seven_day_breakdown": {
 *       "as_of": "…", "window_started_at": "…",
 *       "rows": [{ "key": "claude_code", "display_name": "Claude Code", "percent": 97 },
 *                { "key": "chat",        "display_name": "Chats",       "percent": 3 }, …]
 *     }
 *
 * ★ 三个口径陷阱：
 *   1. percent 是占**本周已用量**的份额，不是占限额 —— 占限额 = seven_day × percent / 100。
 *   2. 只有 7d 窗口有拆分，5h 没有。5h 要靠「5h 百分点 / 7d 百分点」的刻度比折过去（limitRatio）。
 *   3. percent 是整数，而且是对真实用量取整：同一段时间 chat 真实累计只增不减，
 *      份额却会 4→3→4→3 地抖（Code 在涨、chat 没动时份额被稀释）。所以累计量要做
 *      单调拟合（PAVA）后才能相减，直接相减会得到负的 chat。
 *
 * team 组织的响应里这个字段是 null（2026-09-29 实测），此时一切退回纯差额法。
 */

export interface ProductShare {
  key: string;
  label: string;
  /** 占本周已用量的份额，0..100 整数 */
  sharePct: number;
}

export interface ProductBreakdown {
  asOf: Date | null;
  /** 这份拆分所属的 7d 窗口起点；用来切分周，别拿它当窗口起点展示 */
  windowStartedAt: Date | null;
  rows: ProductShare[];
}

/** 唯一算「本地能看见」的产品。其余（chat / cowork / other / 以后新增的）一律是非 Code */
export const CODE_PRODUCT_KEY = "claude_code";

function date(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 接受整份 usage 响应，也接受已经取出来的 `seven_day_breakdown` 对象。
 * 拿不到（team 组织为 null、老响应没有这个字段、rows 为空）返回 null，不返回全 0。
 */
export function parseProductBreakdown(raw: unknown): ProductBreakdown | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let doc = raw as Record<string, unknown>;
  if ("seven_day_breakdown" in doc) {
    const inner = doc["seven_day_breakdown"];
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
    doc = inner as Record<string, unknown>;
  }
  const rawRows = doc["rows"];
  if (!Array.isArray(rawRows)) return null;
  const rows: ProductShare[] = [];
  for (const item of rawRows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const key = r["key"];
    const pct = r["percent"];
    if (typeof key !== "string" || !key) continue;
    if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
    const label = typeof r["display_name"] === "string" && r["display_name"] ? (r["display_name"] as string) : key;
    rows.push({ key, label, sharePct: pct });
  }
  if (rows.length === 0) return null;
  return { asOf: date(doc["as_of"]), windowStartedAt: date(doc["window_started_at"]), rows };
}

/** 非 Code 的份额；拆分里没有 claude_code 这一行就不知道，返回 null */
export function nonCodeShare(b: ProductBreakdown): number | null {
  const code = b.rows.find((r) => r.key === CODE_PRODUCT_KEY);
  if (!code) return null;
  return Math.max(0, Math.min(100, 100 - code.sharePct));
}

export interface BreakdownSample {
  ts: Date;
  /** 同一次快照里 seven_day 的 utilization（0..100） */
  weeklyPct: number;
  breakdown: ProductBreakdown;
}

/** 单调拟合后的非 Code 累计量（周刻度百分点）。groupStart 相同的点属于同一个 7d 窗口 */
export interface NonCodePoint {
  ts: Date;
  pct: number;
  groupStart: Date | null;
}

/** Pool-Adjacent-Violators：最小二乘意义下最接近 y 的非降序列 */
export function isotonic(y: number[]): number[] {
  const blocks: { v: number; n: number }[] = [];
  for (const v of y) {
    blocks.push({ v, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2]!.v > blocks[blocks.length - 1]!.v) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      blocks.push({ v: (a.v * a.n + b.v * b.n) / (a.n + b.n), n: a.n + b.n });
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.v);
  return out;
}

/** window_started_at 每次响应差几百毫秒；按 10 分钟取整来认「同一周」 */
const GROUP_ROUND_MS = 10 * 60_000;

/**
 * 非 Code 累计量 = weekly × (100 − code 份额) / 100，逐周做单调拟合。
 *
 * 周的切分优先看 window_started_at；拿不到时退回「weekly 下跌 = 换周」。
 */
export function nonCodeSeries(samples: BreakdownSample[]): NonCodePoint[] {
  const pts = samples
    .map((s) => ({ s, share: nonCodeShare(s.breakdown) }))
    .filter((x): x is { s: BreakdownSample; share: number } => x.share !== null && Number.isFinite(x.s.weeklyPct))
    .sort((a, b) => a.s.ts.getTime() - b.s.ts.getTime());

  const out: NonCodePoint[] = [];
  let group: { s: BreakdownSample; share: number }[] = [];
  let groupKey: number | null = null;
  const flush = () => {
    if (group.length === 0) return;
    const fit = isotonic(group.map((g) => (g.s.weeklyPct * g.share) / 100));
    group.forEach((g, i) => out.push({ ts: g.s.ts, pct: fit[i]!, groupStart: g.s.breakdown.windowStartedAt }));
    group = [];
  };
  for (const p of pts) {
    const ws = p.s.breakdown.windowStartedAt;
    const key = ws ? Math.round(ws.getTime() / GROUP_ROUND_MS) : null;
    const last = group[group.length - 1];
    const newWeek =
      last !== undefined &&
      (key !== null && groupKey !== null ? key !== groupKey : p.s.weeklyPct < last.s.weeklyPct);
    if (newWeek) flush();
    group.push(p);
    if (key !== null) groupKey = key;
  }
  flush();
  return out;
}

/**
 * 非 Code 累计量在 (from, to] 内涨了多少（与 series 同一刻度）。
 *
 * 换周时累计量归零重来，那一段的增量就是新周的值本身。
 * `from` 之前没有点时：如果第一周是在 from 之后才开始的，起点就是 0（整周都看得见）；
 * 否则起点取第一个点 —— 那之前涨的没人看见，不能算进这段。
 */
export function increaseBetween(series: NonCodePoint[], from: Date, to: Date): number {
  return increaseIndex(series)(from, to);
}

/**
 * increaseBetween 的批量版：前缀和 + 二分，一次建好反复查。
 * 7d 窗口要对两千来个采样区间逐个问，逐次从头扫就是平方级。
 */
export function increaseIndex(series: NonCodePoint[]): (from: Date, to: Date) => number {
  const ts = series.map((p) => p.ts.getTime());
  const cum: number[] = [];
  let acc = 0;
  const weekOf = (p: NonCodePoint) => (p.groupStart ? Math.round(p.groupStart.getTime() / GROUP_ROUND_MS) : null);
  series.forEach((p, i) => {
    if (i > 0) {
      const q = series[i - 1]!;
      const a = weekOf(q);
      const b = weekOf(p);
      // 换周：新周的累计量从 0 起算，整个值都是增量（不能只看有没有下跌 —— 断档跨周时可能不跌）
      const newWeek = a !== null && b !== null ? a !== b : p.pct < q.pct;
      acc += newWeek ? p.pct : p.pct - q.pct;
    }
    cum.push(acc);
  });
  /** 最后一个 ts ≤ t 的下标；没有为 -1 */
  const lastAtOrBefore = (t: number): number => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  return (from, to) => {
    const t0 = from.getTime();
    const t1 = to.getTime();
    if (series.length === 0 || t1 <= t0) return 0;
    const j = lastAtOrBefore(t1);
    if (j < 0) return 0;
    const i = lastAtOrBefore(t0);
    if (i >= 0) return cum[j]! - cum[i]!;
    const first = series[0]!;
    const seenFromStart = first.groupStart !== null && first.groupStart.getTime() >= t0 - GROUP_ROUND_MS;
    return cum[j]! + (seenFromStart ? first.pct : 0);
  };
}

export interface LimitRatio {
  /** 1 个长窗口百分点 ≈ ratio 个短窗口百分点（= 长窗口限额 / 短窗口限额） */
  ratio: number;
  /** 撑起这个估计的长窗口总增量；整数百分比的量化误差约 ±1 / 段 */
  longPct: number;
  segments: number;
}

/**
 * 从同一批快照里估「5h 百分点 / 7d 百分点」。
 *
 * 两个窗口计的是同一份用量，只是分母（限额）不同，所以同一段时间的增量之比就是限额之比。
 * 按「两边都没重置、没断档」切段，每段首尾相减（整数量化误差不随采样次数累积），
 * 再跨段求和。长窗口总增量不到 minLongPct 就不给 —— 7d 涨 2 个点时 ±1 的量化误差是 50%。
 */
export function limitRatio(
  short: QuotaSample[],
  long: QuotaSample[],
  opts: { maxGapMs?: number; minLongPct?: number } = {},
): LimitRatio | null {
  const maxGapMs = opts.maxGapMs ?? 30 * 60_000;
  const minLongPct = opts.minLongPct ?? 5;

  const longAt = new Map<number, number>();
  for (const s of long) if (Number.isFinite(s.pct)) longAt.set(s.ts.getTime(), s.pct);
  const paired = short
    .filter((s) => Number.isFinite(s.pct) && longAt.has(s.ts.getTime()))
    .map((s) => ({ t: s.ts.getTime(), a: s.pct, b: longAt.get(s.ts.getTime())! }))
    .sort((x, y) => x.t - y.t);
  if (paired.length < 2) return null;

  let dShort = 0;
  let dLong = 0;
  let segments = 0;
  let start = paired[0]!;
  let prev = start;
  const close = () => {
    const ds = prev.a - start.a;
    const dl = prev.b - start.b;
    if (ds > 0 || dl > 0) segments++;
    dShort += ds;
    dLong += dl;
  };
  for (const p of paired.slice(1)) {
    if (p.a < prev.a || p.b < prev.b || p.t - prev.t > maxGapMs) {
      close();
      start = p;
    }
    prev = p;
  }
  close();

  if (dLong < minLongPct || dShort <= 0) return null;
  return { ratio: dShort / dLong, longPct: dLong, segments };
}
