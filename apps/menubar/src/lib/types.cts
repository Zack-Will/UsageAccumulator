/**
 * 契约类型：字段名以 docs/CONTRACT.md §2.2 `GET /v1/summary` 为准。
 * 菜单栏 app 只消费这一个端点，不调用任何重端点。
 */

/** CONTRACT.md §2.2 windows[] */
export interface SummaryWindow {
  /** 稳定 key（five_hour / seven_day / ...），用于排序，不做枚举约束 */
  window_kind: string;
  /** "5h" | "7d" | "7d Fable" —— 仅供展示 */
  label: string;
  /** 已用百分比，0..100（契约 §4：不是 0..1） */
  pct: number;
  /** 窗口结束时的预计百分比，可能 > 100 */
  projected_pct: number;
  /** RFC3339 UTC */
  resets_at: string;
  /** 本窗口的耗尽时刻；null = 本窗口打不满 */
  exhaust_eta: string | null;
}

/** CONTRACT.md §2.2 soonest_exhaust */
export interface SoonestExhaust {
  window_kind: string;
  /** RFC3339 UTC */
  eta: string;
}

/** CONTRACT.md §2.2 响应体 */
export interface Summary {
  /** 服务端回显的 profile，用来发现「配错 id 拿到别的 profile 数字」 */
  profile_id: string;
  /** ★ 只含百分比部分，如 "62%"。倒计时由客户端本地算，见 tray-title.cts */
  tray_title_pct: string;
  windows: SummaryWindow[];
  /** 最先耗尽的窗口；null = 没有窗口会打满 */
  soonest_exhaust: SoonestExhaust | null;
  /** 额度快照的采集时刻（不是本次请求时刻）；陈旧时长必须由它算 */
  captured_at: string | null;
  /** true = 超过 15 分钟没有新快照 */
  stale: boolean;
  rate_pct_per_min: number;
  dashboard_url: string;
}

/**
 * 错误码。前 5 个来自契约 §2 的 `error.code`，后面几个是本地才会发生的情况。
 * UI 据此区分「凭证失效」与「服务端挂了」，不看 HTTP 状态码。
 */
export type UaErrorCode =
  | "bad_request"
  | "unauthorized"
  | "machine_revoked"
  | "rate_limited"
  | "internal"
  | "config"
  | "network"
  | "timeout"
  | "bad_response"
  | "unknown";

/** 凭证类错误要单独成一态：用户必须去设置里动手，重试没用。 */
export function isAuthCode(code: UaErrorCode | null): boolean {
  return code === "unauthorized" || code === "machine_revoked";
}

/**
 * 托盘/面板的显示状态。
 * loading = 还没拿到过任何一次成功响应；
 * stale   = 服务端自报 stale:true（快照过期）；
 * auth    = 凭证失效 / 机器被吊销，重试无用；
 * offline = 其余拉取失败（网络、限流、服务端故障）；
 * unconfigured = 还没填 server url。
 */
export type PanelStatus = "loading" | "ok" | "stale" | "auth" | "offline" | "unconfigured";

/** 暴露给渲染层的设置快照 —— 注意这里**没有** token 字段，只有 hasToken。 */
export interface SettingsView {
  serverUrl: string;
  profileId: string;
  pollSeconds: number;
  launchAtLogin: boolean;
  hasToken: boolean;
}

/** 主进程 → 渲染层的唯一一份状态。 */
export interface PanelState {
  status: PanelStatus;
  /** 最后一次成功拿到的摘要；offline 时仍然保留，由 status/snapshotAgeSeconds 表达其新鲜度 */
  summary: Summary | null;
  /** 额度快照采集至今的秒数，由 captured_at 算出；null = 服务端没给或无数据。
   *  注意这衡量的是额度新鲜度，不是网络新鲜度，两者不能混。 */
  snapshotAgeSeconds: number | null;
  /** 服务端回显的 profile_id 与本地配置不一致 —— 必须显式提示，不能静默 */
  profileMismatch: boolean;
  /** 简短失败原因（已脱敏，绝不含 token） */
  error: string | null;
  errorCode: UaErrorCode | null;
  theme: "dark" | "light";
  settings: SettingsView;
}

/** 渲染层 → 主进程的设置提交体。token 为 undefined 表示「不改动」。 */
export interface SettingsPatch {
  serverUrl?: string;
  profileId?: string;
  pollSeconds?: number;
  launchAtLogin?: boolean;
  token?: string;
}

export const IPC = {
  /** main → renderer 推送 PanelState */
  state: "ua:state",
  /** renderer → main，invoke，返回当前 PanelState */
  getState: "ua:get-state",
  refresh: "ua:refresh",
  openDashboard: "ua:open-dashboard",
  saveSettings: "ua:save-settings",
  clearToken: "ua:clear-token",
  hidePanel: "ua:hide-panel",
  quit: "ua:quit",
} as const;
