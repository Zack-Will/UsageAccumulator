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
  resets_at: Rfc3339;
  starts_at: Rfc3339;
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
}

export interface WindowsCurrent {
  profile_id: string;
  windows: WindowState[];
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
export type DistributionBy = "machine" | "model" | "project" | "hour" | "attribution";

/** `bucket` 缺省 none；hour|day 时每个 bucket 额外带 series[]。 */
export type BucketGranularity = "none" | "hour" | "day";

export interface BucketSeriesPoint {
  ts: Rfc3339;
  total_tokens: number;
  events: number;
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

export interface UaApi {
  readonly kind: "mock" | "live";
  profiles(signal?: AbortSignal): Promise<Profile[]>;
  machines(signal?: AbortSignal): Promise<Machine[]>;
  windowsCurrent(profileId: string, signal?: AbortSignal): Promise<WindowsCurrent>;
  timeline(p: TimeRangeParams, signal?: AbortSignal): Promise<Timeline>;
  distribution(p: DistributionParams, signal?: AbortSignal): Promise<Distribution>;
  calibration(profileId: string, signal?: AbortSignal): Promise<Calibration>;
  /** 返回 unsubscribe。连接状态通过 onStatus 上报，供顶栏「同步状态」使用。 */
  stream(
    profileId: string,
    handlers: {
      onEvent: (e: StreamEvent) => void;
      onStatus: (s: StreamStatus) => void;
    },
  ): () => void;
}
