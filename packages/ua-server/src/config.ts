import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * 服务端配置全部来自环境变量。
 * 凭证类只从环境读、绝不写日志（ARCHITECTURE §9）。唯一例外是 claude.ai 会话：
 * 它要能在看板上更新，所以存在 claudeSessionDir 下的 0600 文件里，同样不进日志、不进数据库。
 */
const schema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().positive().default(8080),
  databaseUrl: z.string().default(""),
  /**
   * 看板 / 菜单栏用的单一 Bearer token（ARCHITECTURE §9，v1 不做用户体系）。
   * 菜单栏与脚本仍然走它；浏览器改走密码 + 会话 Cookie。
   */
  dashboardToken: z.string().default(""),
  /**
   * 看板登录密码。设了它浏览器就能用密码登录，换设备不必再去翻 .env 里的随机串。
   * 空 = 不开放密码登录，只剩 token 那条路。
   */
  dashboardPassword: z.string().default(""),
  /** 会话 Cookie 有效期 */
  sessionTtlMs: z.coerce.number().int().positive().default(30 * 24 * 60 * 60_000),
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
  /**
   * 服务端直接抓 claude.ai 额度（ARCHITECTURE §5.3）。默认开；
   * 关掉就只收探针代抓上报的快照（旧路径）。
   */
  quotaSampling: z
    .string()
    .default("true")
    .transform((v) => !/^(0|false|no|off)$/i.test(v.trim())),
  /** claude.ai 会话的保管目录（一个 profile 一个 0600 文件，见 quota-vault.ts）。不进数据库 */
  claudeSessionDir: z.string().default(join(homedir(), ".config", "ua-server", "claude-sessions")),
  claudeBaseUrl: z.string().url().default("https://claude.ai"),
  /** 采样间隔与抖动，和探针一致 */
  quotaIntervalMs: z.coerce.number().int().positive().default(300_000),
  quotaJitterMs: z.coerce.number().int().nonnegative().default(60_000),
  logLevel: z.string().default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse({
    host: env["UA_HOST"],
    port: env["PORT"] ?? env["UA_PORT"],
    databaseUrl: env["DATABASE_URL"],
    dashboardToken: env["UA_DASHBOARD_TOKEN"],
    dashboardPassword: env["UA_DASHBOARD_PASSWORD"],
    sessionTtlMs: env["UA_SESSION_TTL_MS"],
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
    quotaSampling: env["UA_QUOTA_SAMPLING"],
    claudeSessionDir: env["UA_CLAUDE_SESSION_DIR"],
    claudeBaseUrl: env["UA_CLAUDE_BASE_URL"],
    quotaIntervalMs: env["UA_QUOTA_INTERVAL_MS"],
    quotaJitterMs: env["UA_QUOTA_JITTER_MS"],
    logLevel: env["UA_LOG_LEVEL"] ?? env["LOG_LEVEL"],
  });
}
