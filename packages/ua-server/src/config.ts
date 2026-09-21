import { z } from "zod";

/**
 * 服务端配置全部来自环境变量。
 * 凭证类只从环境读，绝不落盘、绝不写日志（ARCHITECTURE §9）。
 */
const schema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().positive().default(8080),
  databaseUrl: z.string().default(""),
  /** 看板 / 菜单栏用的单一 Bearer token（ARCHITECTURE §9，v1 不做用户体系） */
  dashboardToken: z.string().default(""),
  /** 探针 enroll 用的一次性口令，换取长期 machine token */
  enrollToken: z.string().default(""),
  /** 定价表快照路径。代码里不写死任何价格。 */
  pricingFile: z.string().default("deploy/pricing.json"),
  dashboardUrl: z.string().default(""),
  /** 超过这个时长没收到额度快照就把 summary 标 stale（CONTRACT §2.2） */
  quotaStaleMs: z.coerce.number().int().positive().default(15 * 60_000),
  /** 标定任务周期；0 表示关闭 */
  calibrationIntervalMs: z.coerce.number().int().nonnegative().default(30 * 60_000),
  /** 物化视图刷新周期；0 表示关闭（ARCHITECTURE §6.2 建议每分钟） */
  refreshIntervalMs: z.coerce.number().int().nonnegative().default(60_000),
  /** SSE window_update 推送周期 */
  streamIntervalMs: z.coerce.number().int().positive().default(15_000),
  /** SSE ping 心跳周期。反代的空闲超时各家不同，留成可配 */
  streamHeartbeatMs: z.coerce.number().int().positive().default(25_000),
  /** 单批 ingest 的最大字节数（解压前） */
  maxIngestBytes: z.coerce.number().int().positive().default(32 * 1024 * 1024),
  /** 看板构建产物目录；为空则不托管静态文件（纯 API 模式） */
  webDir: z.string().default(""),
  logLevel: z.string().default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse({
    host: env["UA_HOST"],
    port: env["PORT"] ?? env["UA_PORT"],
    databaseUrl: env["DATABASE_URL"],
    dashboardToken: env["UA_DASHBOARD_TOKEN"],
    enrollToken: env["UA_ENROLL_TOKEN"],
    pricingFile: env["UA_PRICING_FILE"],
    dashboardUrl: env["UA_DASHBOARD_URL"],
    quotaStaleMs: env["UA_QUOTA_STALE_MS"],
    calibrationIntervalMs: env["UA_CALIBRATION_INTERVAL_MS"],
    refreshIntervalMs: env["UA_REFRESH_INTERVAL_MS"],
    streamIntervalMs: env["UA_STREAM_INTERVAL_MS"],
    streamHeartbeatMs: env["UA_STREAM_HEARTBEAT_MS"],
    maxIngestBytes: env["UA_MAX_INGEST_BYTES"],
    webDir: env["UA_WEB_DIR"],
    logLevel: env["UA_LOG_LEVEL"] ?? env["LOG_LEVEL"],
  });
}
