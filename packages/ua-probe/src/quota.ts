import { request } from "undici";
import type { QuotaSnapshot, QuotaWindow } from "@ua/core";
import type { CredentialStore } from "./credentials.js";

/** 401/403：凭证失效。调用方必须退避 + 提示重新登录，**不要重试到被风控**。 */
export class QuotaAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "QuotaAuthError";
  }
}

export class QuotaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaUnavailableError";
  }
}

/**
 * 额度来源抽象。官方接口的字段与鉴权方式都不稳定，
 * 换实现时只动这一层（ARCHITECTURE §5.3）。
 */
export interface QuotaSource {
  readonly id: string;
  fetch(profileId: string, now?: Date): Promise<QuotaSnapshot>;
}

function pickDate(o: Record<string, unknown>): Date | null {
  for (const k of ["resets_at", "reset_at", "resetsAt", "resetAt"]) {
    const v = o[k];
    if (typeof v === "string") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      // 秒或毫秒的 epoch 都见过，按量级判断
      const d = new Date(v > 1e11 ? v : v * 1000);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function pickPct(o: Record<string, unknown>): number | null {
  const pct = o["utilization_pct"] ?? o["utilizationPct"];
  if (typeof pct === "number" && Number.isFinite(pct)) return pct;
  const util = o["utilization"];
  if (typeof util === "number" && Number.isFinite(util)) {
    // ★ 这里原本写的是 `util <= 1 ? util * 100 : util`，想顺带兼容 0..1 的比例。
    // 2026-09-21 实测推翻：body 里的 utilization 本来就是 0..100 ——
    // 同一份响应里 seven_day.utilization=80 与 limits[].percent=80 完全吻合。
    // 那个启发式会把 utilization=1（真实含义 1%）放大成 100%，直接触发「额度耗尽」误报。
    // 0..1 只出现在 anthropic-ratelimit-* 响应头里，那是另一条取数路径，不归这里管。
    return util;
  }
  return null;
}

/**
 * 解析 `/api/organizations/{org_id}/usage` 的响应。
 *
 * ★ `window_kind` 按返回的 key **原样透传**，不硬编码枚举 ——
 * 官方字段名尚未实测确认（ARCHITECTURE §2.2：`seven_day_opus` 很可能已经改名），
 * 硬编码会在改名那天静默丢掉一个窗口。
 */
/**
 * `limits[]` 里一条记录对应的 window_kind。
 *
 * 命名沿用扁平 key 的习惯（`seven_day_<model>`），
 * 这样服务端与看板不需要任何改动 —— window_kind 本来就是自由字符串。
 */
export function limitWindowKind(entry: Record<string, unknown>): string | null {
  const kind = entry["kind"];
  if (typeof kind !== "string" || !kind) return null;
  if (kind === "session") return "five_hour";
  if (kind === "weekly_all") return "seven_day";
  if (kind === "weekly_scoped") {
    const scope = entry["scope"];
    const model = scope && typeof scope === "object" ? (scope as Record<string, unknown>)["model"] : null;
    const name = model && typeof model === "object" ? (model as Record<string, unknown>)["display_name"] : null;
    if (typeof name === "string" && name.trim()) {
      return `seven_day_${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    }
    return "seven_day_scoped";
  }
  return kind; // 没见过的 kind 原样带出，别静默丢掉一个窗口
}

/**
 * 解析 `limits[]` 数组。
 *
 * ★ 新版响应把**按模型分别限流**放在这里，而老的扁平 key（`seven_day_opus` 等）
 * 值全是 null。2026-09-21 实测：`seven_day` 全局 80%，同一响应里却有
 * `{kind:"weekly_scoped", scope:{model:{display_name:"Fable"}}, percent:98}` ——
 * 只认扁平 key 就会完全看不到真正卡住用户的那一档。
 */
export function parseLimits(raw: unknown): QuotaWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: QuotaWindow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const windowKind = limitWindowKind(entry);
    if (!windowKind) continue;
    const percent = entry["percent"];
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    out.push({ windowKind, utilizationPct: percent, resetsAt: pickDate(entry) });
  }
  return out;
}

export function parseUsageResponse(raw: unknown): QuotaWindow[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const doc = raw as Record<string, unknown>;
  const out: QuotaWindow[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(doc)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const pct = pickPct(obj);
    if (pct === null) continue; // 比如 extra_usage：没有利用率，只进 raw
    out.push({ windowKind: key, utilizationPct: pct, resetsAt: pickDate(obj) });
    seen.add(key);
  }
  // 扁平 key 优先：五小时与全局七天两边都有，值一致，不重复入列
  for (const w of parseLimits(doc["limits"])) {
    if (seen.has(w.windowKind)) continue;
    out.push(w);
    seen.add(w.windowKind);
  }
  return out;
}

/** 带 `raven` capability 的才是 Claude Code 在用的那个组织（2026-09-21 实测）。 */
function isCodeOrg(o: Record<string, unknown>): boolean {
  const caps = o["capabilities"];
  if (Array.isArray(caps) && caps.some((c) => c === "raven")) return true;
  const tier = o["rate_limit_tier"];
  return typeof tier === "string" && tier.startsWith("default_raven");
}

export function extractOrgId(raw: unknown): string | null {
  if (Array.isArray(raw)) {
    const orgs = raw.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x));
    const uuidOf = (o: Record<string, unknown>): string | null => {
      const uuid = o["uuid"] ?? o["id"];
      return typeof uuid === "string" && uuid ? uuid : null;
    };
    // ★ 一个账号可能有多个组织（实测 2 个：带 raven 的工作组织 + 个人组织）。
    // 取第一个会随响应顺序变化，而两个组织的额度毫不相干 —— 取错了没有任何迹象，
    // 只会看到一份始终对不上的数字。
    for (const o of orgs) {
      if (isCodeOrg(o)) {
        const id = uuidOf(o);
        if (id) return id;
      }
    }
    for (const o of orgs) {
      const id = uuidOf(o);
      if (id) return id;
    }
    return null;
  }
  if (raw && typeof raw === "object") {
    const uuid = (raw as Record<string, unknown>)["uuid"];
    if (typeof uuid === "string") return uuid;
  }
  return null;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

const undiciGet: HttpGet = async (url, headers) => {
  const res = await request(url, { method: "GET", headers, headersTimeout: 20_000, bodyTimeout: 20_000 });
  return { status: res.statusCode, text: await res.body.text() };
};

/**
 * claude.ai 的 Web 接口（ARCHITECTURE §5.3）。
 *   1. GET /api/organizations            → org_id
 *   2. GET /api/organizations/{id}/usage → 各窗口的 utilization + resets_at
 * Cookie: sessionKey，**只从本机凭证库读，不落盘、不进日志、不上报**。
 */
export class ClaudeWebSource implements QuotaSource {
  readonly id = "claude_web";
  private cachedOrgId: string | null = null;

  constructor(
    private readonly credentials: CredentialStore,
    private readonly baseUrl = "https://claude.ai",
    private readonly get: HttpGet = undiciGet,
  ) {}

  /**
   * claude.ai 在 Cloudflare 后面。实测（2026-09-21）undici 能正常通过，
   * curl 不能 —— 差异在 TLS 指纹层，与请求头无关。
   * 这里仍然给一个真实浏览器的 UA 与 Referer/Origin：我们访问的是用户自己的数据，
   * 用可识别的常规客户端标识，比留一个会被当成异常流量的自定义 UA 更稳。
   */
  private cookieHeaders(sessionKey: string): Record<string, string> {
    return {
      cookie: `sessionKey=${sessionKey}`,
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      referer: "https://claude.ai/",
      origin: "https://claude.ai",
    };
  }

  private check(res: HttpResponse, what: string): unknown {
    if (res.status === 401 || res.status === 403) {
      throw new QuotaAuthError(`${what} 返回 ${res.status}，sessionKey 可能已失效`, res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new QuotaUnavailableError(`${what} 返回 HTTP ${res.status}`);
    }
    try {
      return JSON.parse(res.text);
    } catch {
      throw new QuotaUnavailableError(`${what} 返回的不是 JSON`);
    }
  }

  async resolveOrgId(sessionKey: string): Promise<string> {
    if (this.cachedOrgId) return this.cachedOrgId;
    const res = await this.get(`${this.baseUrl}/api/organizations`, this.cookieHeaders(sessionKey));
    const doc = this.check(res, "GET /api/organizations");
    const orgId = extractOrgId(doc);
    if (!orgId) throw new QuotaUnavailableError("organizations 响应里找不到 org id");
    this.cachedOrgId = orgId;
    return orgId;
  }

  async fetch(profileId: string, now = new Date()): Promise<QuotaSnapshot> {
    const sessionKey = await this.credentials.read();
    if (!sessionKey) {
      throw new QuotaAuthError(`凭证不可用（${this.credentials.kind}）：${this.credentials.hint()}`, 401);
    }
    const orgId = await this.resolveOrgId(sessionKey);
    const res = await this.get(
      `${this.baseUrl}/api/organizations/${encodeURIComponent(orgId)}/usage`,
      this.cookieHeaders(sessionKey),
    );
    const raw = this.check(res, "GET /api/organizations/{id}/usage");
    return {
      profileId,
      capturedAt: now,
      windows: parseUsageResponse(raw),
      // raw 原样上报：官方字段改名时可回溯重算（这里没有任何凭证）
      raw,
    };
  }
}
