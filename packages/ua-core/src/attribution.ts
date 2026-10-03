import type { QuotaSample } from "./windows.js";

/**
 * 「这段额度不是本地 Claude Code 吃掉的」—— 非本地来源用量的归因。
 *
 * 背景：官方的 5h/7d 额度计的是**整个账号**的消耗，网页/App 的聊天窗、手机端、
 * 没装探针的机器全都算在里面；而本地事件流只看得见 `~/.claude/projects` 里的
 * Claude Code 会话。两者口径不一致，会让两类结论系统性出错：
 *   · 「满额约 $X」= 已花 ÷ 已用百分比 —— 分母里混进了别处的消耗，结果偏小；
 *   · 周限外推 / 耗尽 ETA —— 速率模型以为额度是本地事件推动的，实际不是。
 *
 * ★ 本模块给的是**下界**，不是精确拆分。理由是数据本身不支持精确拆分：
 *
 *   1. 官方 utilization 是**整数百分比**（实测原始响应就是 `"utilization": 52`，
 *      不是我们取整取掉的）。一个 5h 窗口总共只有 100 个台阶，7d 窗口一周也只有
 *      100 个台阶 —— 单个 5 分钟区间的 Δ 基本非 0 即 1，量化误差和信号同量级。
 *   2. 本地事件时间戳与官方计量之间有**分钟级偏移**，按 5 分钟区间逐段判定会把
 *      这类滞后误判成「别处的消耗」。
 *
 *      2026-09-22 实测 24 个正增量区间，「距上一条本地事件」的分布是清晰的双峰：
 *        · 21 个落在 0–3 分钟      —— 自己的用量，官方表几乎同步
 *        ·  2 个落在 13 / 16 分钟  —— 会话收尾，仍然多半是自己的
 *        ·  2 个落在 140 / 399 分钟 —— 两个多小时、六个多小时都没碰过 Claude Code，
 *                                     却各涨了 4 个点：这才是别处的消耗
 *      默认护栏取 30 分钟，正好落在两簇之间：把 13/16 分钟那两个划进「判不了」，
 *      只认 140/399 那种。宁可少认，不可错认。
 *
 * 所以判定规则收紧成：**区间内没有本地事件，且区间结束前 `quietLeadMs` 内也没有**。
 * 护栏之外的上升一律归入 `ambiguousPct`，不往任何一边算。
 * 这样得到的 `otherPctLowerBound` 只会低估、不会高估 —— 拿它去修正分母，
 * 得到的「满额约」仍然是个下界，只是比原来（默认别处消耗为 0）紧得多。
 */

/** 只需要时间戳；调用方传什么事件结构都行。 */
export interface AttributionEvent {
  ts: Date;
}

export interface AttributionOptions {
  /**
   * 判定「安静」所需的前置无事件时长。默认 30 分钟：要盖过本地事件与官方计量
   * 之间的滞后，短于滞后就会把自己的用量误判成别处的。
   */
  quietLeadMs?: number;
  /**
   * 相邻快照间隔超过它就不算数（探针停摆、机器休眠）。默认 30 分钟。
   * 这种洞里既可能有本地用量也可能有别处的，判不了。
   */
  maxGapMs?: number;
  /**
   * 官方按产品拆分出的非 Code 用量在 (from, to] 内涨了多少，**已折成本窗口的刻度**
   * （见 products.ts 的 increaseIndex / limitRatio）。给了它，差额法「判不了」的区间
   * 就能拆出一部分：本地有活动的同时在聊天，只看时间戳是分不开的。
   */
  nonCode?: (from: Date, to: Date) => number;
}

export interface AttributionResult {
  /** 窗口内观测到的额度上升合计（pct）；只累加正增量，窗口重置的下跌不计 */
  observedPct: number;
  /**
   * 第一个采样点之前就已经累积掉的部分。
   *
   * ★ 探针不是从窗口第一秒就在采的（新装、重启、今天那种三小时停摆），
   * 这段没人看着，谁吃的都不知道。必须单列出来：把它默默算进
   * 「本地的」会让修正后的分母偏大、满额约偏小 —— 错的方向还正好是「看起来更保守」，
   * 不显眼但一样是错的。
   */
  unobservedPct: number;
  /** 其中确定不是本地 Claude Code 的部分 —— **下界** */
  otherPctLowerBound: number;
  /** 判不了的部分（本地有活动、落在护栏内、或采样有洞） */
  ambiguousPct: number;
  /** 判不了的那些区间里，按官方拆分属于非 Code 的部分（逐区间以该区间的上升为上限）；没给 nonCode 时恒为 0 */
  nonCodeInAmbiguousPct: number;
  /** 支撑下界的安静区间数（有上升且确定无本地活动）*/
  quietSpans: number;
  /** 评估过的相邻采样对总数；为 0 说明这个窗口压根没采到东西 */
  spans: number;
  /** 采样出现过超过 maxGapMs 的洞：这段时间的归因整体不可信 */
  hasSamplingGap: boolean;
}

export const EMPTY_ATTRIBUTION: AttributionResult = {
  observedPct: 0,
  unobservedPct: 0,
  spans: 0,
  otherPctLowerBound: 0,
  ambiguousPct: 0,
  nonCodeInAmbiguousPct: 0,
  quietSpans: 0,
  hasSamplingGap: false,
};

/**
 * 纯函数。samples 与 events 都可以是乱序的，内部会排。
 *
 * events 只用到 `ts`，调用方负责先筛掉不计额度的（`<synthetic>`、非 Anthropic 模型）
 * —— 那个口径在服务端的 pricing.ts 里，core 不该知道。
 */
export function attributeQuota(
  samples: QuotaSample[],
  events: AttributionEvent[],
  opts: AttributionOptions = {},
): AttributionResult {
  const quietLeadMs = opts.quietLeadMs ?? 30 * 60_000;
  const maxGapMs = opts.maxGapMs ?? 30 * 60_000;

  const s = samples
    .filter((x) => Number.isFinite(x.pct))
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const evTimes = events
    .map((e) => e.ts.getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const out: AttributionResult = { ...EMPTY_ATTRIBUTION };
  if (s.length === 0) return out;
  // 窗口开头到第一个采样点之间的消耗：看不见，只能承认看不见
  out.unobservedPct = s[0]!.pct > 0 ? s[0]!.pct : 0;
  if (s.length < 2) return out;

  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const dt = b.ts.getTime() - a.ts.getTime();
    if (dt <= 0) continue;
    if (dt > maxGapMs) {
      out.hasSamplingGap = true;
      continue;
    }
    out.spans += 1;
    const delta = b.pct - a.pct;
    if (delta <= 0) continue; // 空闲，或窗口重置造成的下跌

    out.observedPct += delta;

    // 护栏：从区间结束往回看 quietLeadMs，只要有任何一条本地事件就不算安静。
    // 这同时覆盖了「区间内有事件」和「区间前刚有一波事件（滞后）」两种情况。
    const guardFrom = b.ts.getTime() - quietLeadMs;
    if (hasEventInRange(evTimes, guardFrom, b.ts.getTime())) {
      out.ambiguousPct += delta;
      if (opts.nonCode) out.nonCodeInAmbiguousPct += Math.min(delta, Math.max(0, opts.nonCode(a.ts, b.ts)));
    } else {
      out.otherPctLowerBound += delta;
      out.quietSpans += 1;
    }
  }
  return out;
}

/** 有序数组上的半开区间 [from, to) 存在性检查，二分。 */
function hasEventInRange(sorted: number[], from: number, to: number): boolean {
  if (sorted.length === 0 || from >= to) return false;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]! < to;
}

/**
 * 归因能不能拿来修正分母。
 *
 * ★ 判据是**覆盖完整**，不是「测到了别处的消耗」：
 * 只有从窗口第一秒起连续采样、中间没有洞，窗口里的每一个百分点才都有归属
 * （要么安静、要么判不了）。这时 `otherPctLowerBound = 0` 才真的等于「没有别处的消耗」。
 *
 * 反过来，覆盖不全时哪怕结果是 0 也必须显示「未知」——
 * 「没测到」和「测到了没有」是两件事，用 0 冒充前者会让人以为分母是干净的。
 */
export function attributionIsUsable(r: AttributionResult): boolean {
  return r.spans > 0 && !r.hasSamplingGap && r.unobservedPct <= 0;
}

/**
 * 本地 Claude Code 实际占掉的百分比（上界）。
 *
 * = 观测总量 − 确定属于别处的部分。因为减掉的是**下界**，结果是本地占比的**上界**，
 * 拿它当分母算出的「满额约」就还是个下界 —— 方向一致，不会反过来高估。
 */
export function localPctUpperBound(observedPct: number, r: AttributionResult): number {
  const v = observedPct - r.otherPctLowerBound;
  return v > 0 ? v : 0;
}

/**
 * 两条路径合成「非本地」的估计（百分点，本窗口刻度）。
 *
 *   · 差额法：安静区间里的上升 —— 什么来源都算（聊天、没装探针的机器），但只看得见安静时段；
 *   · 官方拆分：非 Code 产品的用量 —— 任何时段都看得见，但看不见别的机器上的 Code。
 *
 * 两者在「安静时段的聊天」上重叠，所以不能直接相加。取
 *     max( 拆分总量,  差额法下界 + 拆分在「判不了」区间里的那部分 )
 * 前一项补上差额法看不见的（边写代码边聊天、窗口开头没采到的），
 * 后一项补上拆分看不见的（安静时段里别的机器在跑 Code）。
 *
 * nonCodePct 为 null（team 组织没有拆分、5h 刻度比还估不出来）时就是纯差额法。
 * ★ 拆分是整数份额折出来的估计，所以合成后**不再是严格下界**，只是更接近真值。
 */
export function fuseOtherPct(r: AttributionResult, nonCodePct: number | null, utilizationPct: number): number {
  const v = nonCodePct === null ? r.otherPctLowerBound : Math.max(nonCodePct, r.otherPctLowerBound + r.nonCodeInAmbiguousPct);
  return Math.max(0, Math.min(utilizationPct, v));
}
