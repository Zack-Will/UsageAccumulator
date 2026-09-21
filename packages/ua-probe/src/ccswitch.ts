import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface ProxyLogRow {
  requestId: string;
  providerId: string;
  sessionId: string | null;
  dataSource: string;
}

export interface ProviderRow {
  id: string;
  appType: string;
  name: string;
  isCurrent: boolean;
  baseUrl: string | null;
}

/** cc-switch 的 provider_id 占位符 —— 它自己也没做归属判定（ARCHITECTURE §2.1）。 */
export function isPlaceholderProvider(id: string): boolean {
  return !id || id.startsWith("_");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * 只读访问 `~/.cc-switch/cc-switch.db`。
 *
 * **绝不写入**（ARCHITECTURE §10：单向只读依赖）。以 readOnly 模式打开，
 * 连 SQLite 层面都不给写的机会。文件不存在 / 表不存在 / WAL 拿不到 shm 时
 * 一律降级成"查不到"，不抛到调用方 —— L1 本来就是可选的。
 */
export class CcSwitchReader {
  private conn: DatabaseSync | null = null;
  private proxyTableOk = false;
  private providersTableOk = false;
  readonly openError: string | null = null;

  constructor(readonly path: string) {
    if (!existsSync(path)) {
      this.openError = "cc-switch.db 不存在";
      return;
    }
    try {
      // readOnly: true —— 这是"绝不写入"的硬保证，不是约定
      this.conn = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
      this.proxyTableOk = this.hasTable("proxy_request_logs");
      this.providersTableOk = this.hasTable("providers");
    } catch (err) {
      this.conn = null;
      this.openError = (err as Error).message;
    }
  }

  get available(): boolean {
    return this.conn !== null;
  }

  /** 只读连接本体，仅供诊断与测试；任何写操作都会被 SQLite 拒绝。 */
  get connection(): DatabaseSync | null {
    return this.conn;
  }

  get hasProxyLogs(): boolean {
    return this.proxyTableOk;
  }

  private hasTable(name: string): boolean {
    if (!this.conn) return false;
    try {
      const row = this.conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
      return row !== undefined;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    this.conn = null;
  }

  /**
   * L1：按 request_id 查代理日志。
   * 本机实测 data_source 只有 session_log / codex_session，provider_id 全是 `_session` 占位符
   * （代理未启用）—— 所以这里把占位符和非 proxy 来源都当成"查不到"，让调用方降级到 L2。
   */
  lookupProxy(requestId: string): ProxyLogRow | null {
    if (!this.conn || !this.proxyTableOk || !requestId) return null;
    try {
      const row = this.conn
        .prepare("SELECT request_id, provider_id, session_id, data_source FROM proxy_request_logs WHERE request_id = ?")
        .get(requestId);
      if (!row) return null;
      const providerId = str(row["provider_id"]);
      const dataSource = str(row["data_source"]) || "proxy";
      if (dataSource !== "proxy") return null;
      if (isPlaceholderProvider(providerId)) return null;
      const sid = row["session_id"];
      return {
        requestId: str(row["request_id"]),
        providerId,
        sessionId: sid == null ? null : str(sid),
        dataSource,
      };
    } catch {
      return null;
    }
  }

  /** 代理是否真的在产数据。全是占位符 → L1 等于不存在，启动时就该告诉用户。 */
  proxyLogStats(): { total: number; realProxy: number } {
    if (!this.conn || !this.proxyTableOk) return { total: 0, realProxy: 0 };
    try {
      const row = this.conn
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN COALESCE(data_source,'proxy') = 'proxy'
                            AND provider_id NOT LIKE '\\_%' ESCAPE '\\' THEN 1 ELSE 0 END) AS real_proxy
             FROM proxy_request_logs`,
        )
        .get();
      return { total: Number(row?.["total"] ?? 0), realProxy: Number(row?.["real_proxy"] ?? 0) };
    } catch {
      return { total: 0, realProxy: 0 };
    }
  }

  /**
   * L2 的**辅助**信号。注意：实测 providers.is_current 可能与 live 配置不同步
   * （本机 is_current 指向 Anyrouter，但 ~/.claude/settings.json 没有 env 段，
   * 实际跑的是官方 OAuth）。所以这只作参考，真相以 settings.json 为准。
   */
  currentProvider(appType = "claude"): ProviderRow | null {
    if (!this.conn || !this.providersTableOk) return null;
    try {
      const row = this.conn
        .prepare("SELECT id, app_type, name, is_current, settings_config FROM providers WHERE app_type = ? AND is_current = 1 LIMIT 1")
        .get(appType);
      if (!row) return null;
      let baseUrl: string | null = null;
      try {
        const cfg = JSON.parse(str(row["settings_config"])) as Record<string, unknown>;
        const env = cfg["env"] as Record<string, unknown> | undefined;
        const u = env?.["ANTHROPIC_BASE_URL"];
        if (typeof u === "string") baseUrl = u;
      } catch {
        /* settings_config 不是 JSON：忽略 */
      }
      return {
        id: str(row["id"]),
        appType: str(row["app_type"]),
        name: str(row["name"]),
        isCurrent: true,
        baseUrl,
      };
    } catch {
      return null;
    }
  }
}
