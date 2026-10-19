/**
 * Codex 账本 → 看板已有的形状。
 *
 * 换算口径（docs/CODEX-API.md）：Codex 的 input 已经**包含** cached_input 与 cache_write_input，
 * output 已经包含 reasoning_output；Claude 侧的 DistributionBucket 则是互斥的几段。
 * 所以「未缓存输入 = input − cached − cache_write」，total 原样搬 —— 两边的 total 都是
 * 输入侧总量 + 输出，明细表、汇总卡、缓存命中率可以直接复用，不必另写一套。
 */
import type { MetricSeries, UsageMetric } from "./derive";
import type {
  CodexAggregate,
  CodexCollector,
  CodexPeriod,
  CodexPeriodRecord,
  CodexQuotaWindow,
  CodexResetCredits,
  CodexUsageBucket,
  DistributionBucket,
} from "./types";

export function codexBucket(key: string, a: CodexAggregate): DistributionBucket {
  const t = a.tokens;
  return {
    key,
    events: a.events,
    input_tokens: Math.max(0, t.input - t.cached_input - t.cache_write_input),
    output_tokens: t.output,
    cache_read_tokens: t.cached_input,
    // Codex 不分 5m / 1h，写入一律放在 5m 这一列；汇总时两列本来就相加
    cache_write_5m_tokens: t.cache_write_input,
    cache_write_1h_tokens: 0,
    total_tokens: t.total,
    cost_usd: a.cost_usd,
    unpriced_events: a.unpriced_events,
  };
}

export const codexBuckets = (buckets: readonly CodexUsageBucket[]): DistributionBucket[] =>
  buckets.map((b) => codexBucket(b.key, b));

/** 300 → "5h"，10080 → "7d"；不整的给分钟。null = 官方没说多长 */
export function durationLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * 卡片标题。primary 不等于 5h —— 时长只看 duration_minutes。
 * 只有一个限额时不写限额名；有多个（例如另有按模型的限额）才前缀它，免得两张「7d 窗口」分不清。
 */
export function codexWindowTitle(w: CodexQuotaWindow, multipleLimits: boolean): string {
  const base = w.label ?? (durationLabel(w.duration_minutes) ? `${durationLabel(w.duration_minutes)} 窗口` : w.slot);
  return multipleLimits ? `${w.limit_id} · ${base}` : base;
}

/** 窗口按时长从短到长；时长未知的排最后 */
export function sortCodexWindows(windows: readonly CodexQuotaWindow[]): CodexQuotaWindow[] {
  const dur = (w: CodexQuotaWindow) => w.duration_minutes ?? Number.POSITIVE_INFINITY;
  return [...windows].sort((a, b) => dur(a) - dur(b) || a.window_id.localeCompare(b.window_id));
}

/** 窗口时间已过去的比例；不知道时长或重置时刻就是 null（不画竖线，不猜） */
export function codexPace(w: CodexQuotaWindow, nowMs: number): number | null {
  const reset = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
  if (!Number.isFinite(reset) || w.duration_minutes === null) return null;
  const span = w.duration_minutes * 60_000;
  return Math.max(0, Math.min(1, (nowMs - (reset - span)) / span));
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** 本地日期 YYYY-MM-DD —— 与请求时传给服务端的 timezone 是同一个时区 */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [from, to) 覆盖到的每个本地零点。按日历推进而不是加 24h：夏令时那天只有 23 或 25 小时 */
export function localDayTicks(fromMs: number, toMs: number): number[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const d = new Date(fromMs);
  d.setHours(0, 0, 0, 0);
  const out: number[] = [];
  while (d.getTime() < toMs && out.length < 400) {
    out.push(d.getTime());
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * by=day 的桶 → 一条按本地日期对齐的序列。
 * 没有桶的日子是 0（那天没有本地记录）；有桶但全部缺价时金额是 null，不是 $0。
 */
export function codexDaySeries(
  buckets: readonly CodexUsageBucket[],
  ticks: readonly number[],
  metric: UsageMetric,
  label: string,
): MetricSeries[] {
  const byDay = new Map(buckets.map((b) => [b.key, b]));
  return [
    {
      key: "codex",
      label,
      values: ticks.map((ms) => {
        const b = byDay.get(localDayKey(ms));
        if (!b) return 0;
        return metric === "tokens" ? b.tokens.total : b.cost_usd;
      }),
    },
  ];
}

export type CollectorTone = "ok" | "warn" | "danger";

/** 登录失效 / 出错是红，只是过期是黄。被拒收的事件会让采集器自己报 error，这里不用另判 */
export function collectorTone(c: CodexCollector): CollectorTone {
  if (c.collector.state !== "ok") return "danger";
  return c.stale ? "warn" : "ok";
}

export const isServerCollector = (c: Pick<CodexCollector, "machine_id">): boolean => c.machine_id === "ua-server";

export function collectorName(c: Pick<CodexCollector, "machine_id" | "hostname">): string {
  if (isServerCollector(c)) return "服务端";
  return c.hostname ?? c.machine_id.slice(0, 8);
}

/** 本期被重置过（期内重置，或本期就是被一次提前重置打开的） */
export const periodWasReset = (p: Pick<CodexPeriod, "resets" | "opened_by_reset">): boolean =>
  p.resets.length > 0 || p.opened_by_reset !== null;

/** 本期累计的写法：断过档就是下界 */
export const fmtCumulative = (p: Pick<CodexPeriod, "cumulative_pct" | "has_gap">): string =>
  `${p.has_gap ? "≥" : ""}${Math.round(p.cumulative_pct)}%`;

/** 7d 期历史只列一天以上的窗口（5h 窗口一天几十期，列出来是噪音） */
export const longPeriods = (periods: readonly CodexPeriodRecord[]): CodexPeriodRecord[] =>
  periods.filter((p) => (p.duration_minutes ?? 0) >= 24 * 60);

/** 可用的重置券里最早到期的那张；没有到期时间或详情读不到就是 null */
export function earliestCreditExpiry(c: CodexResetCredits | null | undefined): number | null {
  const times = (c?.credits ?? [])
    .filter((x) => x.status === "available" && x.expires_at)
    .map((x) => Date.parse(x.expires_at!))
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

export function collectorStateLabel(c: CodexCollector): string {
  if (c.collector.state === "auth") return c.collector.error_code === "codex_server_blocked" ? "被拦截" : "登录失效";
  if (c.collector.state === "error") return c.collector.error_code === "codex_events_rejected" ? "有事件被拒收" : "采集出错";
  return c.stale ? "已过期" : "正常";
}
