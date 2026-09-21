/** 契约见 docs/CONTRACT.md §1 —— 改动此处必须同步改契约。 */

export type AppType = "claude" | "codex" | "gemini";

/** 归属可信度：proxy 最高，unknown 最低。看板必须把这个显示出来。 */
export type AttributionLevel = "proxy" | "timeline" | "fallback" | "unknown";

export interface UsageEvent {
  messageId: string;
  requestId: string;
  /** requestId 缺失时由 semanticId() 生成，用于兜底去重 */
  semanticId: string;
  machineId: string;
  appType: AppType;
  profileId: string;
  attributionLevel: AttributionLevel;
  /** UTC */
  ts: Date;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  /** ★ 5m 与 1h 必须分开：单价不同，合并会系统性算错钱 */
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  sessionId: string;
  projectSlug: string | null;
  gitBranch: string | null;
  entrypoint: string | null;
  serviceTier: string | null;
  isSidechain: boolean;
  backfill: boolean;
}

export interface QuotaWindow {
  /** 自由字符串，不做枚举 —— 官方字段名尚未实测确认，见 ARCHITECTURE.md §2.2 */
  windowKind: string;
  /** 0..100，不是 0..1 */
  utilizationPct: number;
  resetsAt: Date | null;
}

export interface QuotaSnapshot {
  profileId: string;
  capturedAt: Date;
  windows: QuotaWindow[];
  /** 官方响应原文，原样保留以便字段改名后回溯重算 */
  raw: unknown;
}

export interface Profile {
  id: string;
  kind: "oauth" | "api_key";
  label: string;
  accountUuid: string | null;
  baseUrl: string | null;
  plan: string | null;
}
