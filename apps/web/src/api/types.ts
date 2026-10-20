/**
 * API 类型定义，逐字对应 docs/CONTRACT.md §2 / §2.1 / §2.1a / §4。
 * 字段名不得改动；本目录不改契约。
 */

/**
 * CONTRACT §4：百分比是 0..100 的 f64，**凡是比例/百分比字段名字一律以 `_pct` 结尾**。
 * 不带后缀的数值字段一律不是百分比。
 */
export type Pct = number;
/** CONTRACT §4：RFC3339，UTC，带 Z。 */
export type Rfc3339 = string;

/** CONTRACT §1.1 */
export type AttributionLevel = "proxy" | "timeline" | "fallback" | "unknown";

/** CONTRACT §1.3：window_kind 是自由字符串，不做枚举约束。 */
export type WindowKind = string;

// ── /v1/profiles ────────────────────────────────────────────────────────────
/** CONTRACT §2：注意键是 `id`，不是 `profile_id`。 */
export interface Profile {
  id: string;
  kind: "oauth" | "api_key";
  label: string;
  account_uuid: string | null;
  base_url: string | null;
  plan: string | null;
  /** 绑定的 claude.ai 组织 */
  org_uuid: string | null;
  /** 最近有用量的那个；没有明确选择时默认跟它走 */
  active: boolean;
}

export interface ProfilesResponse {
  profiles: Profile[];
}

// ── /v1/machines ────────────────────────────────────────────────────────────
/** CONTRACT §2。label 取自 enroll 的 hostname。 */
export interface Machine {
  machine_id: string;
  label: string;
  hostname: string;
  os: string;
  last_seen_at: Rfc3339;
  revoked: boolean;
}

export interface MachinesResponse {
  machines: Machine[];
}

// ── /v1/windows/current（CONTRACT §2.1） ───────────────────────────────────
/**
 * burn_curve 的点必须可区分来源：v1 恒为 official；
 * 出现 interpolated 时看板画虚线段，不能把推算曲线当官方数据。
 */
export type BurnSource = "official" | "interpolated";

export interface BurnPoint {
  ts: Rfc3339;
  pct: Pct;
  source: BurnSource;
  /** 第几段：官方提前重置（重置卡）后加一，画图时段与段之间断开。旧服务端不给 */
  segment?: number;
}

/** 窗口内的官方提前重置：所有窗口同时清零，resets_at 不变 */
export interface WindowReset {
  /** 重置发生在这两次观测之间 */
  after: Rfc3339;
  at: Rfc3339;
  from_pct: Pct;
  to_pct: Pct;
}

export interface ProjectedPct {
  p25: Pct;
  mid: Pct;
  p75: Pct;
}

/**
 * 预测曲线，从 now 到窗口结束。
 * **由服务端计算，前端不得自行外推** —— 5h 是线性速率外推（ARCHITECTURE §7.1），
 * 但 7d 用的是「按星期几的日历模式」（§7.2），线性外推会系统性偏离。
 */
export interface ProjectedCurvePoint {
  ts: Rfc3339;
  p25: Pct;
  mid: Pct;
  p75: Pct;
}

/** ARCHITECTURE §7.5 的四个重叠度指标，由服务端算好，前端不自算。 */
export interface OverlapMetrics {
  /** 分钟，可为负。不是百分比，所以没有 _pct 后缀。 */
  local_window_offset_min: number;
  /** 0..100 */
  multi_machine_overlap_pct: Pct;
  /** 0..100 */
  session_cut_rate_pct: Pct;
  /** 0..100 */
  window_waste_pct: Pct;
}

export interface WindowState {
  window_kind: WindowKind;
  utilization_pct: Pct;
  /**
   * ★ 可以是 null：5h 窗口到期后、下一条消息之前，官方不给重置时刻 —— 窗口处于空闲。
   * 以前这里标成必有字符串，于是没人处理 null，空闲窗口的卡片拿 from=null 去查花费。
   */
  resets_at: Rfc3339 | null;
  /** 与 resets_at 同生同灭：没有重置时刻就推不出起点。 */
  starts_at: Rfc3339 | null;
  projected_pct: ProjectedPct;
  /** null 表示本窗口不会耗尽（ARCHITECTURE §7.3）。 */
  exhaust_eta: Rfc3339 | null;
  rate_pct_per_min: number;
  burn_curve: BurnPoint[];
  /** 本期累计 = 各段峰值之和；没重置过时等于 utilization_pct。旧服务端不给 */
  cumulative_pct?: Pct;
  resets?: WindowReset[];
  projected_curve: ProjectedCurvePoint[];
  /** 最近一次额度快照的采集时刻。 */
  captured_at: Rfc3339;
  /** 超过 15 分钟没有新快照。 */
  stale: boolean;
  metrics: OverlapMetrics;
  attribution: Attribution;
  /**
   * 「满额约」的历史参考（只有 five_hour）：最近若干个本地占比 ≥ 30% 的已结束窗口里，
   * 「已花 ÷ 本地占比」的中位数。当前窗口用量太小、外推不可信时用它。
   * 旧服务端不带 → 缺省按 null。
   */
  full_cost_reference?: FullCostReference | null;
  /**
   * 额度当量倍率：模型家族 → 倍率，没列出的按 1。7d 上 Fable 按 2 倍计（服务端 quotaWeights 有标定依据）。
   * 「满额约」= Σ(各模型费用 × 倍率) ÷ 本地占比；「已用」仍是原价。旧服务端不带 → 全按 1。
   */
  quota_weights?: Record<string, number>;
}

export interface FullCostReference {
  usd: number;
  /** 参与的窗口数 */
  windows: number;
  /** > 0：这些窗口里有事件的最终输出量没写进 JSONL，usd 偏低 */
  partial_output_events: number;
}

/**
 * 这个窗口里有多少额度不是本地 Claude Code 吃的（网页/App 聊天、手机端、
 * 没装探针的机器）。口径与局限见服务端 @ua/core 的 attribution.ts。
 */
export interface Attribution {
  /** 确定属于非本地来源的百分点，是**下界**：只会少认，不会错认 */
  other_pct_lower_bound: Pct;
  /** 判不了的百分点（本地当时有活动，或落在滞后护栏内） */
  ambiguous_pct: Pct;
  /** 窗口开头没采到的百分点 */
  unobserved_pct: Pct;
  quiet_spans: number;
  has_sampling_gap: boolean;
  /**
   * 覆盖是否完整。不是「能不能用」的开关 —— 下界在任何覆盖下都合法，
   * 它只回答「other=0 是量过了确实没有，还是压根没量到」。
   */
  usable: boolean;
  /**
   * 官方「按产品」拆分里非 Code 产品（聊天、Cowork 等）的用量，折成本窗口刻度。
   * null = 拿不到（team 组织没有拆分、5h 刻度比还估不出来、按模型限定的窗口）。
   */
  non_code_pct: Pct | null;
  /** 非本地用量的最佳估计（7d 以官方拆分为准，5h 差额法与拆分合成，都没有时 = 下界） */
  other_pct: Pct;
  /** 本地占掉的百分比 = utilization_pct − other_pct */
  local_utilization_pct: Pct;
}

/** 官方「本周按产品」拆分，与 claude.ai 的 usage 页同一组数 */
export interface Products {
  as_of: Rfc3339 | null;
  /** 这份拆分那一刻的 7d 利用率 */
  weekly_pct: Pct;
  rows: {
    key: string;
    label: string;
    /** 占本周已用量的份额（官方整数） */
    share_pct: Pct;
    /** 占周限额的百分点 */
    pct: Pct;
  }[];
}

export interface WindowsCurrent {
  profile_id: string;
  windows: WindowState[];
  /** team 组织没有拆分 → null。老服务端没有这个字段 → undefined */
  products?: Products | null;
}

// ── /v1/timeline（CONTRACT §2.1a） ─────────────────────────────────────────
export interface TimelineSpan {
  from: Rfc3339;
  to: Rfc3339;
  events: number;
  tokens: number;
}

export interface TimelineLane {
  machine_id: string;
  /** 可读名，取自 enroll 的 hostname。 */
  machine_label: string;
  events: number;
  tokens: number;
  spans: TimelineSpan[];
}

export interface Timeline {
  profile_id: string;
  from: Rfc3339;
  to: Rfc3339;
  window_boundaries: Rfc3339[];
  lanes: TimelineLane[];
  metrics: OverlapMetrics;
}

// ── /v1/distribution（CONTRACT §2.1a） ─────────────────────────────────────
export type DistributionBy = "machine" | "model" | "project" | "hour" | "attribution" | "session";

/** `bucket` 缺省 none；hour|day 时每个 bucket 额外带 series[]。 */
export type BucketGranularity = "none" | "hour" | "day";

export interface BucketSeriesPoint {
  ts: Rfc3339;
  total_tokens: number;
  events: number;
  /** null = 该时间点没有任何有报价的模型。不是 0 美元，两者必须分开显示。 */
  cost_usd: number | null;
  unpriced_events: number;
}

export interface DistributionBucket {
  /**
   * 稳定的可读标识，**跨端点一致**（CONTRACT §2.1a）。
   * 分类色板一律按 key 登记，不得按 label —— label 是展示文案，主机改名就会变，
   * 拿它取色会让颜色跟着跳。
   *   by=machine     → machine_id（与 /v1/timeline 的 lanes[].machine_id 同源）
   *   by=model       → 模型名
   *   by=project     → project_slug（可能已 HMAC 化）
   *   by=hour        → 小时起点的 RFC3339 时刻（UTC），不是 0..23 序号
   *   by=attribution → attribution_level
   */
  key: string;
  /** 展示文案，可缺省；缺省时前端显示 key。只用于显示，绝不用于取色。 */
  label?: string;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  total_tokens: number;
  /** null = 该桶无任何有报价的模型。必须与「成本为 0」区分显示。 */
  cost_usd: number | null;
  /** >0 = 成本不完整，前端必须给视觉提示。 */
  unpriced_events: number;
  /**
   * >0 = 有事件的最终用量没写进 JSONL，output_tokens 与 cost_usd 都是下界。
   * 旧服务端不带这个字段 —— 缺省按 0 处理。
   */
  partial_output_events?: number;
  /** 仅在 bucket=hour|day 时出现。 */
  series?: BucketSeriesPoint[];
  /** 仅 by=session：这个会话在哪个项目目录（可能已 HMAC 化；临时工作区也在这里） */
  project_slug?: string | null;
  /** 仅 by=session：这个会话在哪台机器 */
  machine_label?: string;
  /** 仅 by=session：桌面端恢复会话产生的分叉合并了几个 session id */
  session_count?: number;
}

export interface Distribution {
  profile_id: string;
  by: DistributionBy;
  from: Rfc3339;
  to: Rfc3339;
  buckets: DistributionBucket[];
}

// ── /v1/calibration（CONTRACT §2.1a） ──────────────────────────────────────
/**
 * 逐观测点，供「拟合散点」图使用。
 * ARCHITECTURE §7.0 的回归是 delta_pct/100 = weighted_tokens / L，
 * 所以 x 取 weighted_tokens、y 取 delta_pct，fitted_pct 是模型对该点的预测。
 */
export interface CalibrationPoint {
  weighted_tokens: number;
  delta_pct: Pct;
  fitted_pct: Pct;
}

export interface CalibrationEntry {
  window_kind: WindowKind;
  computed_at: Rfc3339;
  limit_weighted_tokens: number;
  base_model: string;
  /** model → 权重，基准模型为 1。 */
  weights: Record<string, number>;
  /** 0..1 的相对残差（不是百分比字段，无 _pct 后缀）。 */
  residual: number;
  observations: number;
  converged: boolean;
  points: CalibrationPoint[];
}

export interface Calibration {
  profile_id: string;
  /** 空数组 = 观测点不够 → 显示「标定中」，退回百分比口径。 */
  calibrations: CalibrationEntry[];
}

// ── /v1/stream（SSE，CONTRACT §2） ─────────────────────────────────────────
export interface StreamEventBatch {
  profile_id: string;
  count: number;
  last_ts: Rfc3339;
}

export type StreamEvent =
  | { type: "window_update"; data: WindowsCurrent }
  | { type: "event_batch"; data: StreamEventBatch }
  | { type: "ping"; data: Record<string, never> };

export type StreamStatus = "connecting" | "open" | "closed";

// ── 数据源接口 ──────────────────────────────────────────────────────────────
export interface TimeRangeParams {
  profile_id: string;
  from: Rfc3339;
  to: Rfc3339;
}

export interface DistributionParams extends TimeRangeParams {
  by: DistributionBy;
  bucket?: BucketGranularity;
}

/** GET /v1/quota/history 的一条样本。 */
export interface QuotaSample {
  ts: Rfc3339;
  utilization_pct: Pct;
}

export interface QuotaHistory {
  profile_id: string;
  window_kind: WindowKind;
  from: Rfc3339;
  to: Rfc3339;
  samples: QuotaSample[];
}

export interface QuotaHistoryParams extends TimeRangeParams {
  window_kind: string;
}

// ── claude.ai 会话：服务端直接抓额度用（CONTRACT §2.4）──────────────────────
/**
 * none 未登录 · pending 存了还没抓过 · ok 正常 · auth 会话失效 · blocked 被 Cloudflare 拦
 * · error 暂时失败（下一轮自动重试）· disabled 服务端没开采集（额度只能靠探针代抓）
 */
export type QuotaSessionState = "none" | "pending" | "ok" | "auth" | "blocked" | "org" | "error" | "disabled";

/** 会话能看到的一个 claude.ai 组织 */
export interface QuotaOrg {
  uuid: string;
  name: string;
  plan: string | null;
  /** 已绑在哪个 profile 上 */
  bound_to: string | null;
}

/** 只有状态，没有 sessionKey —— 服务端任何接口都不回显它。 */
export interface QuotaSessionStatus {
  profile_id: string;
  state: QuotaSessionState;
  last_ok_at: Rfc3339 | null;
  last_attempt_at: Rfc3339 | null;
  next_attempt_at: Rfc3339 | null;
  error: string | null;
  org_uuid: string | null;
  /** null = 还没问过 claude.ai */
  orgs: QuotaOrg[] | null;
}

// ── /v1/codex（docs/CODEX-API.md）─────────────────────────────────────────
/**
 * Codex 是独立账本：不挂在 Claude 的 profile 下，额度、本地用量、官方汇总三份数据互不相加。
 */
export interface CodexAccount {
  account_id: string;
  email: string;
  plan_type: string | null;
  first_seen_at: Rfc3339;
  last_seen_at: Rfc3339;
}

export interface CodexQuotaWindow {
  window_id: string;
  limit_id: string;
  /** primary 不等于 5h，时长看 duration_minutes */
  slot: "primary" | "secondary";
  label: string | null;
  used_percent: Pct;
  duration_minutes: number | null;
  resets_at: Rfc3339 | null;
}

export interface CodexQuotaLimit {
  limit_id: string;
  plan_type: string | null;
  credits: { has_credits: boolean; unlimited: boolean; balance: string | null } | null;
  /** 非空 = 官方说这个限额已经撞上了 */
  limit_reached: string | null;
}

export interface CodexResetCredits {
  available_count: number;
  /** null = 只知道数量，详情没读到 */
  credits: Array<{ reset_type: string; status: string; granted_at: Rfc3339; expires_at: Rfc3339 | null; title: string | null }> | null;
}

export interface CodexQuotaSnapshot {
  captured_at: Rfc3339;
  windows: CodexQuotaWindow[];
  limits: CodexQuotaLimit[];
  /** 只有服务端自采的快照带；缺省 = 不知道，不是「没有」 */
  reset_credits?: CodexResetCredits | null;
}

/** 官方提前重置：发生在 after 与 at 两次观测之间 */
export interface CodexResetEvent {
  after: Rfc3339;
  at: Rfc3339;
  from_pct: Pct;
  to_pct: Pct;
  /** in_period：同一期内清零；new_period：重置同时推走了 resets_at，开了新的一期 */
  kind: "in_period" | "new_period";
}

/** 一个窗口期（docs/CODEX-API.md「Official resets, periods and segments」） */
export interface CodexPeriod {
  window_id: string;
  limit_id: string;
  slot: "primary" | "secondary";
  label: string | null;
  duration_minutes: number | null;
  starts_at: Rfc3339 | null;
  scheduled_end: Rfc3339 | null;
  /** null = 进行中 */
  ended_at: Rfc3339 | null;
  end_reason: "scheduled" | "reset" | null;
  opened_by_reset: CodexResetEvent | null;
  resets: CodexResetEvent[];
  first_sample_at: Rfc3339;
  last_sample_at: Rfc3339;
  /** 本期实际用掉的：各段峰值之和，含重置前的部分 */
  cumulative_pct: Pct;
  final_pct: Pct;
  /** 采样断档：累计只是下界 */
  has_gap: boolean;
}

export interface CodexWindowAnalysis {
  window_id: string;
  /** 只用当前段（最近一次重置之后）的样本 */
  rate_pct_per_min: number;
  projected_pct: { p25: Pct; mid: Pct; p75: Pct };
  exhaust_eta: Rfc3339 | null;
  period: CodexPeriod & { samples: Array<{ ts: Rfc3339; pct: Pct; segment: number }> };
  /** 本期（从期开头或第一次观测起）的本地用量 */
  local_usage?: CodexAggregate;
  local_usage_from?: Rfc3339;
  /** 这一期打满值多少钱；null = 没有可外推的花费 */
  full_cost?: CodexFullCost | null;
}

export interface CodexFullCost {
  usd: number;
  /** current：本期外推；reference：本期累计太小，用往期中位数 */
  basis: "current" | "reference";
  reference_periods: number | null;
  /** 期内有缺价事件：花费少算，满额值是下界 */
  lower_bound: boolean;
}

export interface CodexPeriodRecord extends CodexPeriod {
  local_usage: CodexAggregate;
  local_usage_from: Rfc3339;
  local_usage_to: Rfc3339;
  /** 本期花费 ÷ 本期累计；旧服务端没有 */
  full_cost_usd?: number | null;
}

export interface CodexPeriods {
  account_id: string;
  weeks: number;
  periods: CodexPeriodRecord[];
  /** window_id → 往期满额值中位数 */
  full_cost_references?: Record<string, { usd: number; periods: number } | null>;
}

/** 服务端专用的那份 ChatGPT 登录。任何接口都不回显 token */
export type CodexSessionState = "none" | "pending" | "ok" | "auth" | "blocked" | "account" | "error" | "disabled";

export interface CodexSessionStatus {
  state: CodexSessionState;
  last_ok_at: Rfc3339 | null;
  last_attempt_at: Rfc3339 | null;
  next_attempt_at: Rfc3339 | null;
  error: string | null;
  email: string | null;
  plan_type: string | null;
  refreshed_at: Rfc3339 | null;
  /** 进行中 / 刚失败的网页登录（只有看板身份看得到）；旧服务端没有这个字段 */
  device?: CodexDeviceLogin | null;
}

/** 网页登录：在任意浏览器打开 verification_url，登录 ChatGPT，输入 user_code */
export interface CodexDeviceLogin {
  state: "waiting" | "failed" | "expired";
  verification_url: string;
  user_code: string;
  expires_at: Rfc3339;
  error: string | null;
}

export interface CodexCollectorStatus {
  captured_at: Rfc3339;
  state: "ok" | "auth" | "error";
  error_code: string | null;
  backfill_from: Rfc3339;
  scanned_files: number;
  parse_warnings: number;
}

export interface CodexCollector {
  account_id: string;
  machine_id: string;
  hostname?: string | null;
  collector: CodexCollectorStatus;
  received_at: Rfc3339;
  age_seconds: number | null;
  stale: boolean;
  conflicting_observations: number;
  /** 被扣留、可能带用量的记录；只有它影响完整性 */
  parse_warnings_total: number;
}

export interface CodexQuotaResponse {
  account_id: string;
  /** null = 从没采到过；windows 为空 = 最近一次采到了、但官方没给任何窗口。两者不同 */
  snapshot: CodexQuotaSnapshot | null;
  age_seconds: number | null;
  stale: boolean;
  /** 当前快照里每个窗口所在的一期；旧服务端没有这个字段 */
  analysis?: CodexWindowAnalysis[];
}

export type CodexUsageBy = "day" | "model" | "machine" | "project" | "session";

export interface CodexAggregate {
  events: number;
  /** cached_input / cache_write_input 是 input 的子集，reasoning_output 是 output 的子集 —— 不得再加进 total */
  tokens: { input: number; cached_input: number; cache_write_input: number; output: number; reasoning_output: number; total: number };
  /** 有报价部分的小计；一个都没报价时 null（不是 $0） */
  cost_usd: number | null;
  pricing_complete: boolean;
  usage_complete: boolean;
  usage_coverage_status: "no_data" | "incomplete" | "no_known_gaps";
  incomplete_events: number;
  priced_events: number;
  unpriced_events: number;
}

export interface CodexUsageBucket extends CodexAggregate {
  /** by=day 时是用量所在时区的 YYYY-MM-DD */
  key: string;
}

export interface CodexUsage {
  account_id: string;
  from: Rfc3339;
  to: Rfc3339;
  by: CodexUsageBy;
  timezone: string;
  totals: CodexAggregate;
  buckets: CodexUsageBucket[];
}

export interface CodexUsageParams {
  account_id: string;
  from: Rfc3339;
  to: Rfc3339;
  by: CodexUsageBy;
  /** IANA 时区；看板传浏览器所在时区，按天的桶才和本地日期对得上 */
  timezone: string;
}

export interface UaApi {
  readonly kind: "mock" | "live";
  profiles(signal?: AbortSignal): Promise<Profile[]>;
  machines(signal?: AbortSignal): Promise<Machine[]>;
  windowsCurrent(profileId: string, signal?: AbortSignal): Promise<WindowsCurrent>;
  timeline(p: TimeRangeParams, signal?: AbortSignal): Promise<Timeline>;
  distribution(p: DistributionParams, signal?: AbortSignal): Promise<Distribution>;
  calibration(profileId: string, signal?: AbortSignal): Promise<Calibration>;
  quotaHistory(p: QuotaHistoryParams, signal?: AbortSignal): Promise<QuotaHistory>;
  quotaSession(profileId: string, signal?: AbortSignal): Promise<QuotaSessionStatus>;
  /** 服务端先拿它去问 claude.ai，认了才保存；不认就抛 ApiError，message 可以直接给人看。 */
  saveQuotaSession(profileId: string, change: { sessionKey?: string; orgUuid?: string }): Promise<QuotaSessionStatus>;
  clearQuotaSession(profileId: string): Promise<QuotaSessionStatus>;
  /** 空数组 = 这台服务端还没接入 Codex */
  codexAccounts(signal?: AbortSignal): Promise<CodexAccount[]>;
  codexQuota(accountId: string, signal?: AbortSignal): Promise<CodexQuotaResponse>;
  codexUsage(p: CodexUsageParams, signal?: AbortSignal): Promise<CodexUsage>;
  codexCollectors(accountId: string, signal?: AbortSignal): Promise<CodexCollector[]>;
  codexPeriods(p: { account_id: string; weeks: number; timezone: string }, signal?: AbortSignal): Promise<CodexPeriods>;
  codexSession(signal?: AbortSignal): Promise<CodexSessionStatus>;
  /** 服务端先校验再保存；不认就抛 ApiError，message 可以直接给人看 */
  saveCodexSession(credential: string): Promise<CodexSessionStatus>;
  clearCodexSession(): Promise<CodexSessionStatus>;
  /** 发起网页登录；之后用 codexSession() 轮询 device 的进展 */
  startCodexDeviceLogin(): Promise<CodexSessionStatus>;
  cancelCodexDeviceLogin(): Promise<CodexSessionStatus>;
  /** 返回 unsubscribe。连接状态通过 onStatus 上报，供顶栏「同步状态」使用。 */
  stream(
    profileId: string,
    handlers: {
      onEvent: (e: StreamEvent) => void;
      onStatus: (s: StreamStatus) => void;
    },
  ): () => void;
}
