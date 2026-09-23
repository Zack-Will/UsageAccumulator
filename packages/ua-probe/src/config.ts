import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { DEFAULT_CONFIG_PATH, DEFAULT_CREDENTIAL_FILE, DEFAULT_STATE_PATH, expandHome } from "./paths.js";

/**
 * 探针配置：`~/.config/ua-probe/config.toml`（契约 §4）。
 *
 * scan_roots 刻意做成数组且可配置 —— 见 ARCHITECTURE §14：
 * 套壳客户端可能改写 CLAUDE_CONFIG_DIR 或把会话写到非标准路径，
 * 硬编码 ~/.claude/projects 会在 v2 变成迁移债。
 */

const serverSchema = z.object({
  url: z.string().url(),
  machine_token: z.string().default(""),
  /** 单次上报的最大条数 */
  batch_size: z.number().int().positive().max(10_000).default(1000),
  /** 指数退避：1s 起，封顶 5min（ARCHITECTURE §5.2） */
  retry_base_ms: z.number().int().positive().default(1000),
  retry_max_ms: z.number().int().positive().default(300_000),
  request_timeout_ms: z.number().int().positive().default(30_000),
});

const queueSchema = z.object({
  /** 超过这个条数丢最旧的并告警 */
  max_rows: z.number().int().positive().default(1_000_000),
  /** 正常模式下的上报间隔 */
  flush_interval_ms: z.number().int().positive().default(5_000),
});

const backfillSchema = z.object({
  batch_size: z.number().int().positive().default(1000),
  /** 每批之间的间隔，避免首次接入把服务端打满 */
  interval_ms: z.number().int().nonnegative().default(200),
});

const watchSchema = z.object({
  /** FSEvents 在网络盘 / 容器挂载下会静默失效，保留兜底轮询 */
  poll_interval_ms: z.number().int().positive().default(60_000),
  /** 文件事件聚合窗口 */
  debounce_ms: z.number().int().nonnegative().default(500),
});

const attributionSchema = z.object({
  enabled: z.boolean().default(true),
  /** cc-switch 的库，**只读打开，绝不写入**（ARCHITECTURE §10） */
  cc_switch_db: z.string().default(join(homedir(), ".cc-switch", "cc-switch.db")),
  /** L2 的真相源：live settings.json 优先于 cc-switch 的 is_current（§14 补充修正） */
  claude_settings: z.string().default(join(homedir(), ".claude", "settings.json")),
  /** cc-switch providers.is_current → profile_id 的映射（仅辅助） */
  provider_profiles: z.record(z.string()).default({}),
  /** settings.json 的 env.ANTHROPIC_BASE_URL → profile_id */
  base_url_profiles: z.record(z.string()).default({}),
  /** JSONL 行上的 ownerAccountUuid → profile_id（L3） */
  account_profiles: z.record(z.string()).default({}),
  /** 未配置 env.ANTHROPIC_BASE_URL 时认为跑的是官方 OAuth，归到这个 profile */
  official_profile_id: z.string().default(""),
  /** cc-switch DB 的轮询间隔（WAL 轮询） */
  poll_interval_ms: z.number().int().positive().default(15_000),
});

const quotaSchema = z.object({
  /** 只在指定的一台机器上开启 */
  enabled: z.boolean().default(false),
  profile_id: z.string().default(""),
  source: z.string().default("claude_web"),
  base_url: z.string().url().default("https://claude.ai"),
  interval_secs: z.number().int().positive().default(300),
  jitter_secs: z.number().int().nonnegative().default(60),
  /** keychain（macOS `security`）或 file（Linux 0600） */
  credential: z.enum(["keychain", "file", "env"]).default("keychain"),
  keychain_service: z.string().default("ua-probe"),
  keychain_account: z.string().default("claude-session-key"),
  credential_file: z.string().default(DEFAULT_CREDENTIAL_FILE),
  credential_env: z.string().default("UA_PROBE_CLAUDE_SESSION_KEY"),
  /** 401 后的退避阶梯（秒），**不重试到被风控** */
  auth_backoff_secs: z.array(z.number().int().positive()).default([900, 3600, 21_600]),
  /** macOS 上用 osascript 弹窗提示重新登录 */
  notify_on_auth_error: z.boolean().default(true),
});

const configSchema = z.object({
  machine_id: z.string().default(""),
  app_type: z.enum(["claude", "codex", "gemini"]).default("claude"),
  default_profile_id: z.string().default("claude-official"),
  /** ★ 数组且可配置，不硬编码 ~/.claude/projects */
  scan_roots: z.array(z.string()).default([join(homedir(), ".claude", "projects")]),
  state_db: z.string().default(DEFAULT_STATE_PATH),
  /** 隐私：上报 HMAC 后的 slug，看板显示别名（ARCHITECTURE §9） */
  hash_project_paths: z.boolean().default(false),
  project_hash_secret: z.string().default(""),
  /**
   * 上报会话标题（桌面端侧边栏里那个名字），看板用它标出「这是哪条会话」。
   * ★ hash_project_paths = true 时**一律不报**，不看这个开关：连项目路径都要藏的机器，
   *   标题（它概括的是对话内容）更不该出去。见 shareSessionTitles()。
   */
  share_session_titles: z.boolean().default(true),
  log_level: z.string().default("info"),
  server: serverSchema,
  queue: queueSchema.default({}),
  backfill: backfillSchema.default({}),
  watch: watchSchema.default({}),
  attribution: attributionSchema.default({}),
  quota: quotaSchema.default({}),
});

export type RawConfig = z.infer<typeof configSchema>;

export interface ProbeConfig extends RawConfig {
  /** 展开 ~ 之后的绝对路径 */
  resolvedScanRoots: string[];
  resolvedStateDb: string;
  configPath: string;
}

export class ConfigError extends Error {}

export function parseConfig(text: string, configPath = DEFAULT_CONFIG_PATH): ProbeConfig {
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch (err) {
    throw new ConfigError(`config.toml 解析失败: ${(err as Error).message}`);
  }
  const parsed = configSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new ConfigError(`config.toml 校验失败:\n  ${issues.join("\n  ")}`);
  }
  const cfg = parsed.data;
  if (cfg.hash_project_paths && !cfg.project_hash_secret) {
    throw new ConfigError("hash_project_paths = true 时必须提供 project_hash_secret");
  }
  if (cfg.quota.enabled && !cfg.quota.profile_id) {
    throw new ConfigError("quota.enabled = true 时必须提供 quota.profile_id");
  }
  return {
    ...cfg,
    resolvedScanRoots: cfg.scan_roots.map(expandHome),
    resolvedStateDb: expandHome(cfg.state_db),
    configPath,
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): ProbeConfig {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new ConfigError(`找不到配置 ${configPath}，先跑 \`ua-probe install\``);
    }
    throw new ConfigError(`读取配置失败 ${configPath}: ${e.message}`);
  }
  return parseConfig(text, configPath);
}

/** install 子命令生成的配置模板。machine_token 留空时由 enroll 填。 */
export function renderConfigToml(v: {
  machineId: string;
  serverUrl: string;
  machineToken: string;
  defaultProfileId: string;
  scanRoots: string[];
  quotaEnabled: boolean;
}): string {
  const roots = v.scanRoots.map((r) => `  ${JSON.stringify(r)},`).join("\n");
  return `# ua-probe 配置 —— 见 docs/CONTRACT.md §4
machine_id         = ${JSON.stringify(v.machineId)}
app_type           = "claude"
default_profile_id = ${JSON.stringify(v.defaultProfileId)}
state_db           = ${JSON.stringify(DEFAULT_STATE_PATH)}   # 游标 + 缓冲队列（node:sqlite）
log_level          = "info"

# ★ 可配置的多根目录：套壳客户端可能把会话写到非标准路径（ARCHITECTURE §14）
scan_roots = [
${roots}
]

# 隐私：true 时上报 HMAC 后的 project_slug
hash_project_paths  = false
project_hash_secret = ""

# 上报会话标题（桌面端侧边栏里的名字），看板据此标出是哪条会话；只报标题，不报对话内容。
# hash_project_paths = true 时无论这里怎么写都不报。
share_session_titles = true

[server]
url           = ${JSON.stringify(v.serverUrl)}
machine_token = ${JSON.stringify(v.machineToken)}
batch_size    = 1000

[queue]
max_rows          = 1000000
flush_interval_ms = 5000

[backfill]
batch_size  = 1000
interval_ms = 200

[watch]
poll_interval_ms = 60000   # FSEvents 在网络盘/容器挂载下会静默失效，兜底轮询

[attribution]
enabled         = true
cc_switch_db    = ${JSON.stringify(join(homedir(), ".cc-switch", "cc-switch.db"))}   # 只读
claude_settings = ${JSON.stringify(join(homedir(), ".claude", "settings.json"))}     # L2 真相源
official_profile_id = ${JSON.stringify(v.defaultProfileId)}

# settings.json 的 env.ANTHROPIC_BASE_URL → profile_id
[attribution.base_url_profiles]
# "https://api.anyrouter.top" = "gw-anyrouter"

# cc-switch providers.id → profile_id（仅辅助，is_current 可能与 live 配置不同步）
[attribution.provider_profiles]

# JSONL 行上的 ownerAccountUuid → profile_id（L3 兜底）
[attribution.account_profiles]

[quota]
enabled       = ${v.quotaEnabled}
profile_id    = ${JSON.stringify(v.defaultProfileId)}
interval_secs = 300
jitter_secs   = 60
credential    = ${JSON.stringify(process.platform === "darwin" ? "keychain" : "file")}
# 凭证只存本机，绝不上报服务端
`;
}

/** 这台机器要不要上报会话标题：开关打开，且没有要求隐藏项目路径。 */
export function shareSessionTitles(cfg: Pick<ProbeConfig, "share_session_titles" | "hash_project_paths">): boolean {
  return cfg.share_session_titles && !cfg.hash_project_paths;
}
