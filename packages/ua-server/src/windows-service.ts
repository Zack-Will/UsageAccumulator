import {
  FIVE_HOURS_MS,
  attributeQuota,
  attributionIsUsable,
  localPctUpperBound,
  projectWindow,
  type UsageEvent,
} from "@ua/core";
import {
  SEVEN_DAYS_MS,
  buildProjectedCurve,
  calendarWeight,
  computeWindowMetrics,
  dispersionFrom,
  downsample,
  formatTrayTitlePct,
  inferWindowMs,
  projectCalendarWindow,
  ratioToPct,
  weekdayWeightsFromEvents,
  windowLabel,
  type ProjectedCurvePoint,
  type WindowMetrics,
} from "./aggregate.js";
import type { Store } from "./store.js";

/**
 * 燃尽曲线的一个点。
 *
 * `source` 必须存在且可区分（CONTRACT §2.1）：v1 只有官方快照点，恒为 "official"。
 * 将来若用本地 token 在采样点之间插值，插值点必须标 "interpolated" ——
 * 否则看板会把我们推算出来的曲线当成官方数据展示。
 */
export interface BurnCurvePoint {
  ts: string;
  pct: number;
  source: "official" | "interpolated";
}

/** CONTRACT §2.1 的响应形状（wire 上是 snake_case）。 */
export interface CurrentWindowDto {
  window_kind: string;
  utilization_pct: number;
  resets_at: string | null;
  starts_at: string | null;
  projected_pct: { p25: number; mid: number; p75: number };
  exhaust_eta: string | null;
  rate_pct_per_min: number;
  burn_curve: BurnCurvePoint[];
  /** 最近一次额度快照的采集时刻，不是本次请求时刻 */
  captured_at: string;
  /** 超过 quotaStaleMs 没收到新快照 */
  stale: boolean;
  /**
   * ARCHITECTURE §7.5 的四个重叠度指标；窗口太长时不算，返回 null。
   * 比例字段一律 `_pct` 结尾、值域 0..100（CONTRACT §4）；
   * offset 是分钟数，不是比例，所以没有后缀，可以为负。
   */
  metrics: {
    local_window_offset_min: number | null;
    multi_machine_overlap_pct: number;
    session_cut_rate_pct: number;
    window_waste_pct: number;
    machines: string[];
    events: number;
    tokens: number;
  } | null;
  /** 从 now 到窗口结束的预测曲线；前端不得自行外推（CONTRACT §2.1） */
  projected_curve: ProjectedCurvePoint[];
  /**
   * 这个窗口里有多少额度**不是**本地 Claude Code 吃的
   * —— 网页/App 的聊天窗、手机端、没装探针的机器都算在这里。
   * 判定口径与局限见 @ua/core 的 attribution.ts。
   */
  attribution: AttributionDto;
}

export interface AttributionDto {
  /** 确定属于非本地来源的百分点（**下界**，只会少认不会错认） */
  other_pct_lower_bound: number;
  /** 判不了的百分点：本地当时有活动，或落在滞后护栏内 */
  ambiguous_pct: number;
  /** 窗口开头没采到的百分点（探针那会儿没在跑） */
  unobserved_pct: number;
  quiet_spans: number;
  has_sampling_gap: boolean;
  /**
   * 覆盖是否完整（从窗口第一秒起连续采样、中间没洞）。
   *
   * ★ 这**不是**「能不能用」的开关 —— `other_pct_lower_bound` 在任何覆盖下都是
   * 合法下界：被判定为安静的那些区间确实没有本地活动，这件事不因为别处有洞而改变。
   * 覆盖不全只意味着下界更松（漏掉的那部分没人看见），不意味着它是错的。
   *
   * 它真正回答的是另一个问题：`other_pct_lower_bound = 0` 到底是
   * 「量过了，确实没有」还是「压根没量到」。前者 usable=true。
   */
  usable: boolean;
  /**
   * 本地 Claude Code 占掉的百分比（**上界**）= utilization_pct − other 下界。
   *
   * 「满额约」一类的外推该用它当分母，而不是 utilization_pct：后者把别处的消耗
   * 也算进分母，会把金额系统性压低。用上界当分母，算出来的金额就还是下界，
   * 方向一致，不会反过来高估。
   */
  local_utilization_pct: number;
}

export interface CurrentWindowsResult {
  profile_id: string;
  windows: CurrentWindowDto[];
}

/** 本地窗口偏移只对 5h 量级的窗口有意义（ARCHITECTURE §6.2 的块算法）；7d 不算，太贵也没意义。 */
const OFFSET_MAX_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface WindowsOptions {
  now?: Date;
  quotaStaleMs?: number;
  maxBurnPoints?: number;
}

/**
 * 预测曲线的点数：让它与 burn_curve 的**时间密度**一致（CONTRACT §2.1）。
 * 拿已有 burn_curve 的平均采样间隔去铺满剩余时间；没有足够的历史点就按
 * 官方快照节奏（5 分钟）估。上限仍受 maxBurnPoints 约束。
 */
function projectedPointCount(
  burnCurve: { ts: string }[],
  now: Date,
  windowEnd: Date,
  maxPoints: number,
): number {
  const spanMs = windowEnd.getTime() - now.getTime();
  if (spanMs <= 0) return 2;
  let dtMs = 5 * 60_000;
  if (burnCurve.length >= 2) {
    const first = new Date(burnCurve[0]!.ts).getTime();
    const last = new Date(burnCurve[burnCurve.length - 1]!.ts).getTime();
    if (last > first) dtMs = (last - first) / (burnCurve.length - 1);
  }
  return Math.max(2, Math.min(maxPoints, Math.round(spanMs / Math.max(1, dtMs)) + 1));
}

export async function computeCurrentWindows(
  store: Store,
  profileId: string,
  opts: WindowsOptions = {},
): Promise<CurrentWindowsResult> {
  const now = opts.now ?? new Date();
  const staleMs = opts.quotaStaleMs ?? 15 * 60_000;
  const maxBurnPoints = opts.maxBurnPoints ?? 240;

  const latest = await store.latestQuotaWindows(profileId);
  const windows: CurrentWindowDto[] = [];

  for (const w of latest) {
    const windowMs = inferWindowMs(w.windowKind);
    const windowEnd = w.resetsAt ?? new Date(now.getTime() + windowMs);
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const samples = await store.quotaSamples(profileId, w.windowKind, windowStart);
    // 线性模型（§7.1）：5h 直接用它；7d 只借它的三分位当相对带宽
    const linear = projectWindow({ samples, now, windowEnd });

    let metrics: WindowMetrics | null = null;
    if (windowMs <= OFFSET_MAX_WINDOW_MS) {
      // 多取一个窗口长度的历史，块算法才能把跨边界的那个块切出来
      const rows = await store.eventsInRange(
        profileId,
        new Date(windowStart.getTime() - windowMs),
        now > windowEnd ? now : windowEnd,
      );
      const events: UsageEvent[] = rows.map((r) => r.event);
      metrics = computeWindowMetrics({
        events,
        windowStart,
        windowEnd,
        utilizationPct: w.utilizationPct,
        localWindowMs: FIVE_HOURS_MS,
      });
    }

    // ── 预测：5h 线性（§7.1），7d 日历模式（§7.2）
    //    7 天窗口里周末和工作日差异巨大，线性外推会系统性高估，所以必须分开处理。
    const isLongWindow = windowMs >= SEVEN_DAYS_MS;
    let projected = linear.projected;
    let exhaustEta = linear.exhaustEta;
    let ratePctPerMin = linear.ratePctPerMin;
    let shape: (t: Date) => number = (t) =>
      (t.getTime() - now.getTime()) / Math.max(1, windowEnd.getTime() - now.getTime());

    if (isLongWindow) {
      // 星期几节律从本地事件里解；不足一周的数据会退化成全 1，即等价线性
      const historyFrom = new Date(windowStart.getTime() - 4 * SEVEN_DAYS_MS);
      const history = await store.eventsInRange(profileId, historyFrom, now);
      const weights = weekdayWeightsFromEvents(history.map((r) => r.event));
      const calendar = projectCalendarWindow({
        pctNow: w.utilizationPct,
        now,
        windowStart,
        windowEnd,
        weights,
        dispersion: dispersionFrom(w.utilizationPct, linear.projected),
      });
      projected = calendar.projected;
      exhaustEta = calendar.exhaustEta;
      ratePctPerMin = calendar.ratePctPerMin;
      const remainingWeight = calendarWeight(now, windowEnd, weights);
      shape =
        remainingWeight > 0
          ? (t) => calendarWeight(now, t, weights) / remainingWeight
          : () => 0;
    }

    // 归因：这个窗口里哪些上升发生在「本地确定没动静」的时候
    const evTs = await store.quotaEventTimestamps(profileId, windowStart, now);
    const attr = attributeQuota(samples, evTs.map((ts) => ({ ts })));
    const usable = attributionIsUsable(attr);

    const burnCurve = downsample(samples, maxBurnPoints).map((s) => ({
      ts: s.ts.toISOString(),
      pct: s.pct,
      // v1 全是官方快照点；插值尚未实现，一旦实现必须标 "interpolated"
      source: "official" as const,
    }));

    windows.push({
      window_kind: w.windowKind,
      utilization_pct: w.utilizationPct,
      resets_at: w.resetsAt ? w.resetsAt.toISOString() : null,
      starts_at: w.resetsAt ? windowStart.toISOString() : null,
      projected_pct: projected,
      exhaust_eta: exhaustEta ? exhaustEta.toISOString() : null,
      rate_pct_per_min: ratePctPerMin,
      burn_curve: burnCurve,
      captured_at: w.capturedAt.toISOString(),
      stale: now.getTime() - w.capturedAt.getTime() > staleMs,
      metrics: metrics
        ? {
            local_window_offset_min: metrics.localWindowOffsetMin,
            // core 返回 0..1 的比值，线格式是 0..100（CONTRACT §4）
            multi_machine_overlap_pct: ratioToPct(metrics.multiMachineOverlap),
            session_cut_rate_pct: ratioToPct(metrics.sessionCutRate),
            window_waste_pct: metrics.windowWastePct,
            machines: metrics.machines,
            events: metrics.events,
            tokens: metrics.tokens,
          }
        : null,
      attribution: {
        other_pct_lower_bound: attr.otherPctLowerBound,
        ambiguous_pct: attr.ambiguousPct,
        unobserved_pct: attr.unobservedPct,
        quiet_spans: attr.quietSpans,
        has_sampling_gap: attr.hasSamplingGap,
        usable,
        local_utilization_pct: localPctUpperBound(w.utilizationPct, attr),
      },
      projected_curve: buildProjectedCurve({
        now,
        windowEnd,
        pctNow: w.utilizationPct,
        endpoint: projected,
        shape,
        points: projectedPointCount(burnCurve, now, windowEnd, maxBurnPoints),
      }),
    });
  }

  return { profile_id: profileId, windows };
}

export interface SummaryWindowDto {
  /** 稳定 key：客户端用它排序、记忆折叠状态，不要拿 label 当 key */
  window_kind: string;
  /** 展示文案，仅供显示 */
  label: string;
  pct: number;
  projected_pct: number;
  resets_at: string | null;
  /** 本窗口的耗尽时刻；null = 按当前速率本窗口打不满 */
  exhaust_eta: string | null;
}

export interface SummaryDto {
  /** 回显：配错 profile_id 时不能静默返回默认 profile 的数字 */
  profile_id: string;
  /**
   * ★ 只含百分比部分（CONTRACT §2.2）。
   * 倒计时由客户端从 exhaust_eta / resets_at 本地算并自行每分钟刷新 ——
   * 服务端渲染的倒计时在两次轮询之间就过期了（30~60s 误差），
   * 托盘上挂一个慢一分钟的数字比不显示更糟。
   */
  tray_title_pct: string;
  windows: SummaryWindowDto[];
  soonest_exhaust: { window_kind: string; eta: string } | null;
  /** 额度快照的采集时刻，不是本次请求时刻；无快照时 null */
  captured_at: string | null;
  stale: boolean;
  rate_pct_per_min: number;
  dashboard_url: string;
}

/**
 * CONTRACT §2.2 —— 菜单栏专用，保持极简。
 * 纯函数（只吃 computeCurrentWindows 的结果），好测。
 */
export function buildSummary(
  current: CurrentWindowsResult,
  opts: { dashboardUrl?: string } = {},
): SummaryDto {
  // 稳定排序：按窗口长度升序，同长度按 window_kind 字典序。客户端据此排列，不会跳动。
  const sorted = [...current.windows].sort((a, b) => {
    const d = inferWindowMs(a.window_kind) - inferWindowMs(b.window_kind);
    return d !== 0 ? d : a.window_kind.localeCompare(b.window_kind);
  });

  // 最早耗尽的窗口 = 最吃紧的那个
  const exhausting = sorted
    .filter((w): w is CurrentWindowDto & { exhaust_eta: string } => w.exhaust_eta !== null)
    .sort((a, b) => a.exhaust_eta.localeCompare(b.exhaust_eta));
  const soonest = exhausting[0] ?? null;

  // 托盘只显示一个数字：优先给会先撞墙的那个窗口；没有窗口会耗尽时退回最短的窗口
  const primary = soonest ?? sorted[0] ?? null;

  // captured_at 取**最旧**的那个，与 stale（任一窗口过期即 true）保持同一口径：
  // 客户端要说「数据 23 分钟前」，说的该是最不新鲜的那份。
  const capturedAts = current.windows.map((w) => w.captured_at).sort();
  const oldestCapturedAt = capturedAts[0] ?? null;

  return {
    profile_id: current.profile_id,
    tray_title_pct: formatTrayTitlePct(primary ? primary.utilization_pct : null),
    windows: sorted.map((w) => ({
      window_kind: w.window_kind,
      label: windowLabel(w.window_kind),
      pct: w.utilization_pct,
      projected_pct: w.projected_pct.mid,
      resets_at: w.resets_at,
      exhaust_eta: w.exhaust_eta,
    })),
    soonest_exhaust: soonest
      ? { window_kind: soonest.window_kind, eta: soonest.exhaust_eta }
      : null,
    captured_at: oldestCapturedAt,
    stale: current.windows.length === 0 || current.windows.some((w) => w.stale),
    rate_pct_per_min: primary ? primary.rate_pct_per_min : 0,
    dashboard_url: opts.dashboardUrl ?? "",
  };
}
