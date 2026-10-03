import {
  FIVE_HOURS_MS,
  attributeQuota,
  attributionIsUsable,
  fuseOtherPct,
  increaseIndex,
  limitRatio,
  nonCodeSeries,
  parseProductBreakdown,
  projectWindow,
  type BreakdownSample,
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
import { countsTowardQuota } from "./pricing.js";
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
  /**
   * 「满额约」的历史参考（见 fullCostReference）。只有 five_hour 有；
   * 其他窗口、或最近两周没有本地占比 ≥ 30% 的已结束窗口时为 null。
   */
  full_cost_reference: FullCostReferenceDto | null;
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
   * 7d 窗口有官方拆分时恒为 true：拆分覆盖整周，与采样有没有洞无关。
   */
  usable: boolean;
  /**
   * 官方「按产品」拆分里非 Code 产品（聊天、Cowork 等）的用量，折成本窗口刻度。
   * 7d 直接用；5h 按历史估出的「5h/7d 刻度比」折算。
   * null = 拿不到：team 组织没有拆分、刻度比还估不出来、或其他按模型限定的窗口。
   */
  non_code_pct: number | null;
  /**
   * 非本地用量的最佳估计：
   *   · 7d 有拆分 → 就是 non_code_pct（官方逐产品计量，覆盖整周）；
   *   · 5h 有拆分 → 差额法与拆分合成（@ua/core fuseOtherPct）；
   *   · 没有拆分 → 等于 other_pct_lower_bound。
   * **不再是严格下界**，是更接近真值的估计。
   */
  other_pct: number;
  /**
   * 本地 Claude Code 占掉的百分比 = utilization_pct − other_pct。
   *
   * 「满额约」一类的外推该用它当分母，而不是 utilization_pct：后者把别处的消耗
   * 也算进分母，会把金额系统性压低。
   */
  local_utilization_pct: number;
}

/**
 * 官方「本周按产品」拆分，原样透出给看板（与 claude.ai / Claude Code 的 usage 页同一组数）。
 * 拿不到（team 组织、老响应）时整个字段为 null。
 */
export interface ProductsDto {
  as_of: string | null;
  /** 这份拆分那一刻的 seven_day 利用率 */
  weekly_pct: number;
  rows: {
    key: string;
    label: string;
    /** 占本周已用量的份额（官方整数） */
    share_pct: number;
    /** 占周限额的百分点 = weekly_pct × share_pct / 100 */
    pct: number;
  }[];
}

export interface CurrentWindowsResult {
  profile_id: string;
  windows: CurrentWindowDto[];
  products: ProductsDto | null;
}

/** 估 5h/7d 刻度比回看多久：档位不变时比值稳定，看得越久量化误差越小 */
const RATIO_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 官方拆分 → 各窗口可用的「非 Code 增量」函数，外加给看板的原样拆分。
 * team 组织没有拆分，直接返回空，一切退回纯差额法，也省掉估刻度比的两次查询。
 */
export async function loadNonCode(store: Store, profileId: string, now: Date) {
  // 回看与刻度比同长：历史满额参考要对过去两周的 5h 窗口逐个做同一套归因
  const rows = await store.quotaBreakdowns(profileId, new Date(now.getTime() - RATIO_LOOKBACK_MS - FIVE_HOURS_MS));
  const samples: BreakdownSample[] = [];
  for (const r of rows) {
    const b = parseProductBreakdown(r.breakdown);
    if (b) samples.push({ ts: r.ts, weeklyPct: r.weeklyPct, breakdown: b });
  }
  const last = samples[samples.length - 1];
  if (!last) return { scaleOf: () => null, quantumOf: () => null, quantumAt: () => null, increase: null, products: null };

  const series = nonCodeSeries(samples);
  const increase = series.length > 0 ? increaseIndex(series) : null;
  const since = new Date(now.getTime() - RATIO_LOOKBACK_MS);
  const ratio = limitRatio(
    await store.quotaSamples(profileId, "five_hour", since),
    await store.quotaSamples(profileId, "seven_day", since),
  );
  // 拆分只针对「全部模型」的周限额；按模型限定的窗口（7d Fable）与它不是一个分母
  const scaleOf = (kind: string): number | null =>
    kind === "seven_day" ? 1 : kind === "five_hour" && ratio ? ratio.ratio : null;
  /**
   * 份额跳一格（1%）折成本窗口的点数 = 当前 7d 已用 × 1% × 刻度比。
   * 份额是「占本周已用」的整数百分比，周越往后一格越大：7d 用到 36% 时一格 ≈ 3.4 个 5h 点。
   */
  const quantumOf = (kind: string): number | null => {
    const scale = scaleOf(kind);
    return scale === null ? null : (last.weeklyPct / 100) * scale;
  };
  /** 同上，但按 t 那一刻的 7d 已用量算（回看历史窗口用）；t 之前没有拆分时为 null */
  const quantumAt = (kind: string, t: Date): number | null => {
    const scale = scaleOf(kind);
    let at: BreakdownSample | undefined;
    for (const x of samples) {
      if (x.ts > t) break;
      at = x;
    }
    return scale === null || !at ? null : (at.weeklyPct / 100) * scale;
  };

  const products: ProductsDto = {
    as_of: (last.breakdown.asOf ?? last.ts).toISOString(),
    weekly_pct: last.weeklyPct,
    rows: last.breakdown.rows.map((r) => ({
      key: r.key,
      label: r.label,
      share_pct: r.sharePct,
      pct: (last.weeklyPct * r.sharePct) / 100,
    })),
  };
  return { scaleOf, quantumOf, quantumAt, increase, products };
}

/**
 * 「满额约」的历史参考（只给 5h）：最近若干个已结束窗口里，本地 Code 吃掉的每个百分点值多少钱。
 *
 * 为什么要它：当前窗口用量小时，「已花 ÷ 本地占比」的分母只有几个点，整数取整（±0.5）
 * 加上归属判不清的一两个点，外推误差动辄 ±20% 以上 —— 2026-10-03 一个 7% 的窗口外推出 $302，
 * 而这个订阅 5h 满额通常在 $100 上下。分母够大的窗口（本地 ≥ 30%）取整误差 < 2%，
 * 拿它们的中位数当参考，比在小分母上硬外推可靠得多。
 *
 * ★ 它随负载类型变：子代理为主的窗口每块钱吃额度更快（实测 5h/7d 刻度比 12 vs 主线 8.5），
 *   所以只取最近几个窗口，跟着用法走。子代理输出缺失（output_final = false）会让已花偏小，
 *   一并报出 partial_output_events，让前端知道它可能偏低。
 */
export interface FullCostReferenceDto {
  /** 中位数：每个窗口「已花 ÷ 本地占比」 */
  usd: number;
  /** 参与的窗口数 */
  windows: number;
  /** 这些窗口里最终用量没写进 JSONL 的事件数；> 0 时 usd 偏低 */
  partial_output_events: number;
}

/** 窗口结束时本地占比至少这么多才拿来当参考：取整误差 ±0.5 点在 30 点里 < 2% */
export const REFERENCE_MIN_LOCAL_PCT = 30;
/** 只取最近这么多个合格窗口：负载类型变了，参考值要跟得上 */
const REFERENCE_MAX_WINDOWS = 8;
const REFERENCE_CACHE_MS = 10 * 60_000;
const referenceCache = new WeakMap<Store, Map<string, { at: number; value: FullCostReferenceDto | null }>>();

type NonCode = Awaited<ReturnType<typeof loadNonCode>>;

export async function fullCostReference(
  store: Store,
  profileId: string,
  now: Date,
  nonCode: NonCode,
  opts: { lookbackMs?: number; cache?: boolean } = {},
): Promise<FullCostReferenceDto | null> {
  const useCache = opts.cache ?? true;
  let perStore = referenceCache.get(store);
  if (!perStore) {
    perStore = new Map();
    referenceCache.set(store, perStore);
  }
  const hit = perStore.get(profileId);
  if (useCache && hit && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < REFERENCE_CACHE_MS) return hit.value;

  const kind = "five_hour";
  const since = new Date(now.getTime() - (opts.lookbackMs ?? RATIO_LOOKBACK_MS));
  const resets = (await store.quotaWindowResets(profileId, kind, since, now)).filter(
    (r) => r <= now && r.getTime() - FIVE_HOURS_MS >= since.getTime(),
  );
  let value: FullCostReferenceDto | null = null;
  if (resets.length > 0) {
    const allSamples = await store.quotaSamples(profileId, kind, since, now);
    const rows = await store.eventsInRange(profileId, since, now);
    const scale = nonCode.scaleOf(kind);
    const nonCodeIn =
      scale !== null && nonCode.increase ? (f: Date, t: Date) => scale * nonCode.increase!(f, t) : null;

    const picks: { usd: number; partial: number }[] = [];
    for (const end of resets) {
      const start = new Date(end.getTime() - FIVE_HOURS_MS);
      const samples = allSamples.filter((x) => x.ts >= start && x.ts < end);
      if (samples.length === 0) continue;
      let spend = 0;
      let priced = 0;
      let partial = 0;
      const evTs: { ts: Date }[] = [];
      for (const r of rows) {
        const e = r.event;
        if (e.ts < start || e.ts >= end || !countsTowardQuota(e.model)) continue;
        evTs.push({ ts: e.ts });
        if (r.costUsd !== null) {
          spend += r.costUsd;
          priced++;
        }
        if (e.outputFinal === false) partial++;
      }
      if (priced === 0 || spend <= 0) continue;
      const util = samples[samples.length - 1]!.pct;
      const attr = attributeQuota(samples, evTs, nonCodeIn ? { nonCode: nonCodeIn, windowStart: start } : {});
      const other = fuseOtherPct(attr, nonCodeIn ? nonCode.quantumAt(kind, end) : null, util);
      const local = util - other;
      if (local < REFERENCE_MIN_LOCAL_PCT) continue;
      picks.push({ usd: spend / (local / 100), partial });
    }
    const recent = picks.slice(-REFERENCE_MAX_WINDOWS);
    if (recent.length > 0) {
      const sorted = recent.map((p) => p.usd).sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      value = {
        usd: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
        windows: recent.length,
        partial_output_events: recent.reduce((a, p) => a + p.partial, 0),
      };
    }
  }
  perStore.set(profileId, { at: now.getTime(), value });
  return value;
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
  const nonCode = await loadNonCode(store, profileId, now);
  const hasFiveHour = latest.some((w) => w.windowKind === "five_hour");
  const reference = hasFiveHour ? await fullCostReference(store, profileId, now, nonCode) : null;

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
    // 官方拆分补上差额法「判不了」的那部分（边写代码边聊天）
    const scale = nonCode.scaleOf(w.windowKind);
    const increase = nonCode.increase;
    const nonCodeIn = scale !== null && increase ? (f: Date, t: Date) => scale * increase(f, t) : null;
    const attr = attributeQuota(
      samples,
      evTs.map((ts) => ({ ts })),
      nonCodeIn ? { nonCode: nonCodeIn, windowStart } : {},
    );
    const nonCodePct = nonCodeIn ? nonCodeIn(windowStart, now) : null;
    // ★ 7d 有拆分时直接以拆分为准，不再叠差额法：7d 一格就是 1 个整点，真实用量停在 3.97 时
    //   安静时段里 0.05 点的聊天就能把计数推过整数线，差额法会把整整 1 点记到别处。
    //   2026-09-29 线上：差额法 1 点、拆分 0.3 点。拆分覆盖整周且是官方逐产品计量，更可信；
    //   代价是看不见「没装探针的机器上的 Code」—— 目前两台机器都装了探针。
    const otherPct =
      scale === 1 && nonCodePct !== null
        ? Math.max(0, Math.min(w.utilizationPct, nonCodePct))
        : fuseOtherPct(attr, nonCodeIn ? nonCode.quantumOf(w.windowKind) : null, w.utilizationPct);
    const usable = attributionIsUsable(attr) || (scale === 1 && nonCodePct !== null);

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
        non_code_pct: nonCodePct,
        other_pct: otherPct,
        local_utilization_pct: Math.max(0, w.utilizationPct - otherPct),
      },
      full_cost_reference: w.windowKind === "five_hour" ? reference : null,
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

  return { profile_id: profileId, windows, products: nonCode.products };
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
