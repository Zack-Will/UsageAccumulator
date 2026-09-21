import { readFileSync } from "node:fs";
import type { AttributionLevel } from "@ua/core";
import type { ProbeConfig } from "./config.js";
import type { ProbeStore } from "./store.js";
import { CcSwitchReader } from "./ccswitch.js";
import { expandHome } from "./paths.js";
import type { Logger } from "./logger.js";

export interface AttributionHints {
  requestId: string;
  tsMs: number;
  /** JSONL 行上的 ownerAccountUuid（L3）。assistant 行上常为空。 */
  ownerAccountUuid: string | null;
}

export interface AttributionResult {
  profileId: string;
  level: AttributionLevel;
}

const UUID_RE = /"ownerAccountUuid"\s*:\s*"([0-9a-fA-F-]{8,64})"/;

/**
 * 从原始 JSONL 行里摘 ownerAccountUuid。
 * 刻意用正则而不是第二次 JSON.parse —— 82k 行的 backfill 里多一次全量 parse 不划算。
 * 只取形似 UUID 的值，且这个值只用于**本地**映射到 profile，不会被上报。
 */
export function extractOwnerAccountUuid(raw: string): string | null {
  if (!raw.includes("ownerAccountUuid")) return null;
  const m = UUID_RE.exec(raw);
  return m?.[1] ?? null;
}

export interface TimelineProbe {
  profileId: string;
  source: string;
  /** live settings.json 与 cc-switch is_current 不一致时记下来，供诊断 */
  mismatch: string | null;
}

/**
 * 读 live `~/.claude/settings.json` 的 env.ANTHROPIC_BASE_URL。
 *
 * ★ 这是 L2 的真相源（ARCHITECTURE §14 补充修正）：
 * cc-switch 的 providers.is_current 可能与 live 配置不同步，信它会把官方账号的用量整片记错。
 */
export function readLiveBaseUrl(settingsPath: string): string | null {
  try {
    const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const env = doc["env"] as Record<string, unknown> | undefined;
    const url = env?.["ANTHROPIC_BASE_URL"];
    return typeof url === "string" && url ? url : null;
  } catch {
    return null; // 文件不存在 / 不是 JSON → 当作没配 env，即官方 OAuth
  }
}

/**
 * 归属判定三级降级链（ARCHITECTURE §4.2）。
 *
 *   L1 proxy     cc-switch proxy_request_logs 按 request_id JOIN → 逐请求精确
 *   L2 timeline  live settings.json 的 base_url 变更时间线，按 ts 二分查找
 *   L3 fallback  ownerAccountUuid → default_profile_id
 *   unknown      探针安装前的历史数据（没有时间线可依）
 */
export class Attributor {
  private ccswitch: CcSwitchReader | null = null;
  private readonly installedAtMs: number;
  private lastMismatchLogged = "";
  readonly stats = { proxy: 0, timeline: 0, fallback: 0, unknown: 0 };

  constructor(
    private readonly cfg: ProbeConfig,
    private readonly store: ProbeStore,
    private readonly log: Logger,
  ) {
    this.installedAtMs = store.installedAt();
    if (cfg.attribution.enabled) {
      this.ccswitch = new CcSwitchReader(expandHome(cfg.attribution.cc_switch_db));
      if (!this.ccswitch.available) {
        this.log.warn({ reason: this.ccswitch.openError }, "cc-switch DB 不可读，L1 归属停用，降级到 L2");
      } else {
        const s = this.ccswitch.proxyLogStats();
        if (s.realProxy === 0) {
          this.log.info(
            { total: s.total },
            "cc-switch proxy_request_logs 没有真正的代理记录（provider_id 全是占位符），L1 实际不可用；开启 cc-switch 代理可把 Mac 侧归属变精确",
          );
        }
      }
    }
  }

  close(): void {
    this.ccswitch?.close();
    this.ccswitch = null;
  }

  /** 探针安装时间之前的事件一律 unknown，对外暴露供测试与 status 使用。 */
  get installedAt(): number {
    return this.installedAtMs;
  }

  /**
   * 采样当前生效的 profile 并在变更时追加一个时间线点。
   * 调用时机：启动时 + 每 attribution.poll_interval_ms 一次 + settings.json 变更事件。
   */
  refreshTimeline(now = Date.now()): TimelineProbe {
    const settingsPath = expandHome(this.cfg.attribution.claude_settings);
    const liveBaseUrl = readLiveBaseUrl(settingsPath);
    const officialProfile = this.cfg.attribution.official_profile_id || this.cfg.default_profile_id;

    let profileId: string;
    let source: string;
    if (liveBaseUrl) {
      profileId = this.cfg.attribution.base_url_profiles[liveBaseUrl] ?? liveBaseUrl;
      source = "settings.env.ANTHROPIC_BASE_URL";
    } else {
      // 没有 env 段 = 跑的是官方 OAuth。这是本机实测确认的情形。
      profileId = officialProfile;
      source = "settings.no-env(official-oauth)";
    }

    let mismatch: string | null = null;
    const current = this.ccswitch?.currentProvider(this.cfg.app_type) ?? null;
    if (current) {
      const ccProfile = this.cfg.attribution.provider_profiles[current.id] ?? current.id;
      if (ccProfile !== profileId) {
        mismatch = `cc-switch is_current=${current.id}(${current.name}) 与 live settings 推断的 ${profileId} 不一致；以 live settings 为准`;
        if (mismatch !== this.lastMismatchLogged) {
          this.log.warn({ ccSwitchProvider: current.id, liveProfile: profileId }, mismatch);
          this.lastMismatchLogged = mismatch;
        }
      }
    }

    const appended = this.store.appendTimeline(now, profileId, source);
    if (appended) this.log.info({ profileId, source }, "profile 时间线新增切换点");
    return { profileId, source, mismatch };
  }

  attribute(h: AttributionHints): AttributionResult {
    // 探针安装前的历史数据：没有时间线可依，一律 unknown（ARCHITECTURE §4.2）
    if (h.tsMs < this.installedAtMs) {
      this.stats.unknown++;
      return { profileId: this.cfg.default_profile_id, level: "unknown" };
    }

    // L1：逐请求精确
    if (this.ccswitch?.available && h.requestId) {
      const row = this.ccswitch.lookupProxy(h.requestId);
      if (row) {
        const profileId = this.cfg.attribution.provider_profiles[row.providerId] ?? row.providerId;
        this.stats.proxy++;
        return { profileId, level: "proxy" };
      }
    }

    // L2：切换时间线
    const tl = this.store.timelineAt(h.tsMs);
    if (tl) {
      this.stats.timeline++;
      return { profileId: tl.profileId, level: "timeline" };
    }

    // L3：ownerAccountUuid / 默认 profile
    if (h.ownerAccountUuid) {
      const mapped = this.cfg.attribution.account_profiles[h.ownerAccountUuid];
      if (mapped) {
        this.stats.fallback++;
        return { profileId: mapped, level: "fallback" };
      }
    }
    if (this.cfg.default_profile_id) {
      this.stats.fallback++;
      return { profileId: this.cfg.default_profile_id, level: "fallback" };
    }
    this.stats.unknown++;
    return { profileId: "", level: "unknown" };
  }
}
