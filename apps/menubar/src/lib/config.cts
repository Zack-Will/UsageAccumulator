/**
 * 本地配置：存在 app.getPath("userData")/config.json，0600。
 * token 只在主进程内存与这个文件里出现，**不进日志、不发给渲染层**。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { log, errText } from "./log.cjs";
import type { SettingsView, SettingsPatch } from "./types.cjs";

export interface Config {
  serverUrl: string;
  token: string;
  profileId: string;
  /** 轮询间隔，秒。默认 45，钳在 [30, 600] */
  pollSeconds: number;
  launchAtLogin: boolean;
}

export const DEFAULT_CONFIG: Config = {
  serverUrl: "",
  token: "",
  profileId: "claude-official",
  pollSeconds: 45,
  launchAtLogin: false,
};

export const POLL_MIN_SECONDS = 30;
export const POLL_MAX_SECONDS = 600;

function clampPoll(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : DEFAULT_CONFIG.pollSeconds;
  return Math.min(POLL_MAX_SECONDS, Math.max(POLL_MIN_SECONDS, n));
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v.trim() : fallback;
}

/** 规范化 server url：去掉尾部 `/` 和误粘上的 `/v1`。 */
export function normalizeServerUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  return s.replace(/\/v1$/, "");
}

export class ConfigStore {
  private readonly file: string;
  private data: Config;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "config.json");
    this.data = this.read();
  }

  private read(): Config {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return {
        serverUrl: normalizeServerUrl(str(raw["serverUrl"], DEFAULT_CONFIG.serverUrl)),
        token: typeof raw["token"] === "string" ? raw["token"] : DEFAULT_CONFIG.token,
        profileId: str(raw["profileId"], DEFAULT_CONFIG.profileId) || DEFAULT_CONFIG.profileId,
        pollSeconds: clampPoll(raw["pollSeconds"]),
        launchAtLogin: raw["launchAtLogin"] === true,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // 注意：这里只打印错误类型，绝不打印文件内容
        log.warn(`config unreadable, falling back to defaults: ${errText(err)}`);
      }
      return { ...DEFAULT_CONFIG };
    }
  }

  get(): Readonly<Config> {
    return this.data;
  }

  /** 给渲染层看的版本：token 只留 hasToken 布尔。 */
  view(): SettingsView {
    return {
      serverUrl: this.data.serverUrl,
      profileId: this.data.profileId,
      pollSeconds: this.data.pollSeconds,
      launchAtLogin: this.data.launchAtLogin,
      hasToken: this.data.token.length > 0,
    };
  }

  /** 返回 true 表示有字段真的变了（调用方据此决定是否立刻重拉）。 */
  patch(p: SettingsPatch): boolean {
    const next: Config = { ...this.data };
    if (typeof p.serverUrl === "string") next.serverUrl = normalizeServerUrl(p.serverUrl);
    if (typeof p.profileId === "string") next.profileId = p.profileId.trim() || DEFAULT_CONFIG.profileId;
    if (p.pollSeconds !== undefined) next.pollSeconds = clampPoll(p.pollSeconds);
    if (typeof p.launchAtLogin === "boolean") next.launchAtLogin = p.launchAtLogin;
    // token 为 undefined = 不改动；空串 = 清除
    if (typeof p.token === "string") next.token = p.token.trim();

    const changed =
      next.serverUrl !== this.data.serverUrl ||
      next.profileId !== this.data.profileId ||
      next.pollSeconds !== this.data.pollSeconds ||
      next.launchAtLogin !== this.data.launchAtLogin ||
      next.token !== this.data.token;

    if (!changed) return false;
    this.data = next;
    this.write();
    return true;
  }

  private write(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.chmodSync(this.file, 0o600);
    } catch (err) {
      log.error(`config write failed: ${errText(err)}`);
    }
  }
}
