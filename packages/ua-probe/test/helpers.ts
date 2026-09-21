import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseConfig, type ProbeConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

export function tmpDir(prefix = "ua-probe-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export const silentLog = createLogger("silent");

/** 一行真实形状的 assistant JSONL（字段取自 CONTRACT §1.1 的映射表）。 */
export function assistantLine(over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-21T03:00:00.000Z",
    requestId: "req_1",
    sessionId: "sess-1",
    gitBranch: "main",
    entrypoint: "cli",
    isSidechain: false,
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      usage: {
        input_tokens: 2,
        output_tokens: 726,
        cache_read_input_tokens: 38256,
        cache_creation_input_tokens: 31626,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 31626 },
        output_tokens_details: { thinking_tokens: 295 },
        service_tier: "standard",
        ...usage,
      },
    },
    ...over,
  });
}

export function makeConfig(over: {
  stateDb?: string;
  scanRoot?: string;
  ccSwitchDb?: string;
  claudeSettings?: string;
  baseUrlProfiles?: Record<string, string>;
  providerProfiles?: Record<string, string>;
  accountProfiles?: Record<string, string>;
  hashProjectPaths?: boolean;
} = {}): ProbeConfig {
  const toml = `
machine_id = "machine-test"
default_profile_id = "claude-official"
scan_roots = ${JSON.stringify([over.scanRoot ?? "/nonexistent"])}
state_db = ${JSON.stringify(over.stateDb ?? ":memory:")}
hash_project_paths = ${over.hashProjectPaths ? "true" : "false"}
project_hash_secret = "test-secret"

[server]
url = "https://ua.example.com"
machine_token = "tok"

[attribution]
cc_switch_db = ${JSON.stringify(over.ccSwitchDb ?? "/nonexistent/cc.db")}
claude_settings = ${JSON.stringify(over.claudeSettings ?? "/nonexistent/settings.json")}
official_profile_id = "claude-official"

[attribution.base_url_profiles]
${Object.entries(over.baseUrlProfiles ?? {})
  .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
  .join("\n")}

[attribution.provider_profiles]
${Object.entries(over.providerProfiles ?? {})
  .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
  .join("\n")}

[attribution.account_profiles]
${Object.entries(over.accountProfiles ?? {})
  .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
  .join("\n")}
`;
  return parseConfig(toml, "/tmp/test-config.toml");
}

/** 造一个形状与本机 ~/.cc-switch/cc-switch.db 一致的假库。 */
export function makeCcSwitchDb(
  path: string,
  rows: { requestId: string; providerId: string; dataSource: string; sessionId?: string }[],
  providers: { id: string; appType: string; name: string; isCurrent: boolean; baseUrl?: string }[] = [],
): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, model TEXT NOT NULL,
      session_id TEXT, data_source TEXT NOT NULL DEFAULT 'proxy', created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE providers (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
      is_current BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY (id, app_type)
    );
  `);
  const ins = db.prepare(
    "INSERT INTO proxy_request_logs (request_id, provider_id, app_type, model, session_id, data_source) VALUES (?, ?, 'claude', 'claude-opus-5', ?, ?)",
  );
  for (const r of rows) ins.run(r.requestId, r.providerId, r.sessionId ?? "sess-1", r.dataSource);
  const insP = db.prepare("INSERT INTO providers (id, app_type, name, settings_config, is_current) VALUES (?, ?, ?, ?, ?)");
  for (const p of providers) {
    const cfg = p.baseUrl ? JSON.stringify({ env: { ANTHROPIC_BASE_URL: p.baseUrl } }) : "{}";
    insP.run(p.id, p.appType, p.name, cfg, p.isCurrent ? 1 : 0);
  }
  db.close();
}
