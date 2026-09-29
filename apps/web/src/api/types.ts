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
  projected_curve: ProjectedCurvePoint[];
  /** 最近一次额度快照的采集时刻。 */
  captured_at: Rfc3339;
  /** 超过 15 分钟没有新快照。 */
  stale: boolean;
  metrics: OverlapMetrics;
  attribution: Attribution;
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
  /** 返回 unsubscribe。连接状态通过 onStatus 上报，供顶栏「同步状态」使用。 */
  stream(
    profileId: string,
    handlers: {
      onEvent: (e: StreamEvent) => void;
      onStatus: (s: StreamStatus) => void;
    },
  ): () => void;
}
