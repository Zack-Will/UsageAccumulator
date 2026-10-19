/**
 * Codex 额度历史 → 窗口期（period）与段（segment）。纯函数。
 *
 * 为什么要专门处理：OpenAI 经常发「重置额度」券、偶尔还统一重置，used_percent 会在计划的
 * resets_at 之前掉回 0。照搬 Claude 那套（相邻快照取速率）会出三类错：
 *   · 51% → 0% 被当成负速率，或被当成跨了窗口，预测与燃尽曲线一起错；
 *   · 「这一期到底用了多少」只剩重置后的那一截，重置前用掉的 51% 凭空消失；
 *   · 重置把 resets_at 往后推了 7 天时，一个 7d 期被当成两个期的一部分。
 *
 * 规则：
 *   · **期**：计划的 resets_at 已过 → 新的一期（scheduled）；
 *     used 掉下去且 resets_at 跟着变了 → 官方提前重置开了新的一期（reset 打开的期）。
 *   · **段**：同一期内 used 掉下去、resets_at 不变 → 期内重置，开新段。
 *   · 掉下去要 ≥ 2 个点才算重置：探针与服务端两边的时钟差几秒，排序后可能出现 1 个点的回退。
 *   · 本期累计 = 各段峰值之和。重置都是清零（券的语义就是把窗口重置），所以每段从 0 起算；
 *     用峰值而不是逐点增量，整数抖动不会被重复计入。
 *   · 相邻样本间隔超过 30 分钟：中间可能藏着一次「重置 + 又用了一些」，累计只是下界，标 has_gap。
 */
import { projectWindow, type CodexQuotaWindow, type QuotaSample } from "@ua/core";

export const CODEX_RESET_MIN_DROP_PCT = 2;
const RESET_TOLERANCE_MS = 2 * 60_000;
const GAP_MS = 30 * 60_000;

export interface CodexQuotaHistoryPoint {
  captured_at: string;
  windows: CodexQuotaWindow[];
}

export interface CodexResetEvent {
  /** 重置发生在这两次观测之间 */
  after: string;
  at: string;
  from_pct: number;
  to_pct: number;
  /** in_period：同一期内清零；new_period：重置同时把 resets_at 推走，开了新的一期 */
  kind: "in_period" | "new_period";
}

export interface CodexPeriod {
  window_id: string;
  limit_id: string;
  slot: "primary" | "secondary";
  label: string | null;
  duration_minutes: number | null;
  /** 本期开始：被提前重置打开的取重置时刻，否则取 resets_at − 时长；都不知道为 null */
  starts_at: string | null;
  /** 计划重置时刻（本期内看到的最后一个 resets_at） */
  scheduled_end: string | null;
  /** 实际结束：null = 进行中 */
  ended_at: string | null;
  end_reason: "scheduled" | "reset" | null;
  opened_by_reset: CodexResetEvent | null;
  /** 期内的重置（不含打开本期的那一次） */
  resets: CodexResetEvent[];
  first_sample_at: string;
  last_sample_at: string;
  /** 本期累计：各段峰值之和 */
  cumulative_pct: number;
  /** 最后一次观测的 used */
  final_pct: number;
  has_gap: boolean;
  samples: Array<{ ts: string; pct: number; segment: number }>;
}

const ms = (s: string | null): number => (s ? Date.parse(s) : Number.NaN);

function openPeriod(w: CodexQuotaWindow, at: string, openedBy: CodexResetEvent | null): CodexPeriod {
  const reset = ms(w.resets_at);
  const scheduledStart =
    Number.isFinite(reset) && w.duration_minutes ? new Date(reset - w.duration_minutes * 60_000).toISOString() : null;
  return {
    window_id: w.window_id,
    limit_id: w.limit_id,
    slot: w.slot,
    label: w.label,
    duration_minutes: w.duration_minutes,
    starts_at: openedBy ? openedBy.at : scheduledStart,
    scheduled_end: w.resets_at,
    ended_at: null,
    end_reason: null,
    opened_by_reset: openedBy,
    resets: [],
    first_sample_at: at,
    last_sample_at: at,
    cumulative_pct: 0,
    final_pct: w.used_percent,
    has_gap: false,
    samples: [],
  };
}

/** 段峰值之和：每段从清零起算 */
function cumulative(samples: CodexPeriod["samples"]): number {
  const peaks = new Map<number, number>();
  for (const s of samples) peaks.set(s.segment, Math.max(peaks.get(s.segment) ?? 0, s.pct));
  return [...peaks.values()].reduce((a, b) => a + b, 0);
}

/** 按 window_id 切期；返回值按时间先后，最后一个是当前（或最近）一期 */
export function codexPeriods(history: readonly CodexQuotaHistoryPoint[]): Map<string, CodexPeriod[]> {
  const sorted = [...history].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  const out = new Map<string, CodexPeriod[]>();
  const prev = new Map<string, { at: string; w: CodexQuotaWindow }>();
  for (const point of sorted) {
    for (const w of point.windows) {
      const periods = out.get(w.window_id) ?? [];
      out.set(w.window_id, periods);
      const last = prev.get(w.window_id);
      let current = periods.at(-1);
      if (!last || !current) {
        current = openPeriod(w, point.captured_at, null);
        periods.push(current);
      } else {
        const t = ms(point.captured_at);
        const aReset = ms(last.w.resets_at);
        const bReset = ms(w.resets_at);
        const dropped = last.w.used_percent - w.used_percent >= CODEX_RESET_MIN_DROP_PCT;
        const moved = Number.isFinite(aReset) && Number.isFinite(bReset) && Math.abs(bReset - aReset) > RESET_TOLERANCE_MS;
        const event = (kind: CodexResetEvent["kind"]): CodexResetEvent => ({
          after: last.at, at: point.captured_at, from_pct: last.w.used_percent, to_pct: w.used_percent, kind,
        });
        if (Number.isFinite(aReset) && t >= aReset - RESET_TOLERANCE_MS) {
          current.ended_at = last.w.resets_at;
          current.end_reason = "scheduled";
          current = openPeriod(w, point.captured_at, null);
          periods.push(current);
        } else if (dropped && moved) {
          const e = event("new_period");
          current.ended_at = point.captured_at;
          current.end_reason = "reset";
          current = openPeriod(w, point.captured_at, e);
          periods.push(current);
        } else {
          if (t - ms(last.at) > GAP_MS) current.has_gap = true;
          if (dropped) current.resets.push(event("in_period"));
          // 没掉、只是 resets_at 挪了（空闲窗口的重置时刻会漂）：同一期，计划终点跟着更新
          if (w.resets_at) current.scheduled_end = w.resets_at;
        }
      }
      current.samples.push({ ts: point.captured_at, pct: w.used_percent, segment: current.resets.length });
      current.last_sample_at = point.captured_at;
      current.final_pct = w.used_percent;
      current.cumulative_pct = cumulative(current.samples);
      prev.set(w.window_id, { at: point.captured_at, w });
    }
  }
  return out;
}

export interface CodexWindowAnalysis {
  window_id: string;
  /** 当前段（最近一次重置之后）的速率与预测；不跨重置 */
  rate_pct_per_min: number;
  projected_pct: { p25: number; mid: number; p75: number };
  exhaust_eta: string | null;
  period: CodexPeriod;
}

/**
 * 当前一期的分析：预测只用当前段的样本 —— 重置之前的速率与现在无关，
 * 而 51% → 0% 这一步若进了速率样本，会把预测拉成负数。
 */
export function analyzeCodexWindow(period: CodexPeriod, now: Date): CodexWindowAnalysis {
  const segment = period.resets.length;
  const samples: QuotaSample[] = period.samples
    .filter((s) => s.segment === segment)
    .map((s) => ({ ts: new Date(s.ts), pct: s.pct }));
  const end = ms(period.scheduled_end);
  if (period.ended_at || !Number.isFinite(end) || end <= now.getTime()) {
    const pct = period.final_pct;
    return { window_id: period.window_id, rate_pct_per_min: 0, projected_pct: { p25: pct, mid: pct, p75: pct }, exhaust_eta: null, period };
  }
  const p = projectWindow({ samples, now, windowEnd: new Date(end) });
  return {
    window_id: period.window_id,
    rate_pct_per_min: p.ratePctPerMin,
    projected_pct: p.projected,
    exhaust_eta: p.exhaustEta ? p.exhaustEta.toISOString() : null,
    period,
  };
}
