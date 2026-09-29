import type { Profile, QuotaSample, QuotaSnapshot, UsageEvent } from "@ua/core";
import type { CalibrationPoint } from "./aggregate.js";

/**
 * 数据访问层接口。
 *
 * 刻意只放「取行 / 写行」，不放算法 —— 聚合全在 aggregate.ts 的纯函数里。
 * 于是测试可以换成内存实现，不需要真的起一个 Postgres。
 */

export interface EventRow {
  event: UsageEvent;
  /** null = 该模型没有报价，不是 0 */
  costUsd: number | null;
}

export interface LatestQuotaWindow {
  windowKind: string;
  utilizationPct: number;
  resetsAt: Date | null;
  capturedAt: Date;
}

export interface QuotaBreakdownRow {
  ts: Date;
  /** 同一次快照里 seven_day 的 utilization_pct */
  weeklyPct: number;
  /** `raw.seven_day_breakdown` 原文 */
  breakdown: unknown;
}

export interface CalibrationRecord {
  profileId: string;
  windowKind: string;
  computedAt: Date;
  limitWeightedTokens: number;
  baseModel: string;
  weights: Record<string, number>;
  residual: number;
  observations: number;
  converged: boolean;
  /** 逐观测点，供看板画拟合散点 */
  points: CalibrationPoint[];
}

export interface MachineRecord {
  id: string;
  hostname: string | null;
  os: string | null;
  lastSeenAt: Date | null;
  /** 非 null = 已吊销。查询层照样返回，好让鉴权区分 unauthorized 与 machine_revoked */
  revokedAt: Date | null;
}

export interface Store {
  ping(): Promise<boolean>;

  listProfiles(): Promise<Profile[]>;
  /** ingest 时为没见过的 profile 落一条占位行，写入路径绝不能因为陌生 profile 失败 */
  ensureProfiles(ids: string[]): Promise<void>;
  /**
   * 把 profile 绑到一个 claude.ai 组织，顺带写上组织名与档位。
   * 该组织已绑在别的 profile 上时返回那个 profile 的 id、不做任何改动；成功返回 null。
   */
  bindProfileOrg(profileId: string, org: { uuid: string; label: string; plan: string | null }): Promise<string | null>;
  /** 每个 profile 最近一条事件的时间；没有事件的 profile 不出现 */
  latestEventAt(): Promise<Map<string, Date>>;

  /** ON CONFLICT DO NOTHING 批量 upsert，返回**新插入**的条数 */
  insertEvents(rows: EventRow[]): Promise<number>;

  /** machineId = 采集机器（CONTRACT §1.3），仅供追溯，可为空 */
  insertQuotaSnapshot(s: QuotaSnapshot, machineId?: string | null): Promise<void>;
  latestQuotaWindows(profileId: string): Promise<LatestQuotaWindow[]>;
  quotaSamples(profileId: string, windowKind: string, since: Date, until?: Date): Promise<QuotaSample[]>;
  /**
   * seven_day 的利用率 + 同一次快照里官方的「按产品」拆分原文（`raw.seven_day_breakdown`）。
   * 拆分为 null 的快照（team 组织、老响应）不返回。解析归调用方（@ua/core products.ts）。
   */
  quotaBreakdowns(profileId: string, since: Date): Promise<QuotaBreakdownRow[]>;

  eventsInRange(profileId: string, from: Date, to: Date): Promise<EventRow[]>;

  /**
   * 只取计额度事件的时间戳。
   *
   * 归因（attributeQuota）只关心「这段时间本地有没有动静」，不需要 token 和费用；
   * 7d 窗口里 eventsInRange 会拉回上万行完整事件，而这里一列就够。
   */
  quotaEventTimestamps(profileId: string, from: Date, to: Date): Promise<Date[]>;

  /**
   * 会话标题（Claude 桌面端侧边栏里那个名字）。整批 upsert，返回实际写入 / 改动的条数。
   * 标题会被改名，所以一律「后到的覆盖先到的」。
   */
  upsertSessionTitles(machineId: string, rows: { sessionId: string; title: string }[]): Promise<number>;
  /** 按 session_id 批量取标题；没有标题的会话不出现在返回里。 */
  sessionTitles(sessionIds: string[]): Promise<Map<string, string>>;

  latestCalibration(profileId: string, windowKind?: string): Promise<CalibrationRecord[]>;
  insertCalibration(rec: CalibrationRecord): Promise<void>;

  createMachine(m: {
    id: string;
    provisionalMachineId: string | null;
    hostname: string;
    os: string;
    tokenSha256: string;
  }): Promise<void>;
  /** 吊销的机器也要返回（带 revokedAt），否则无法回 machine_revoked */
  findMachineByTokenSha256(hash: string): Promise<MachineRecord | null>;
  /** 看板用：机器清单 + 可读名。吊销的也列出来，带 revoked 标记 */
  listMachines(): Promise<MachineRecord[]>;
  touchMachine(id: string): Promise<void>;

  /** 刷新 usage_hourly 物化视图（ARCHITECTURE §6.2） */
  refreshHourly(): Promise<void>;

  close(): Promise<void>;
}
