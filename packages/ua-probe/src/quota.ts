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
    // 契约 §4：百分比是 0..100。官方若给 0..1 的比例，这里换算。
    return util <= 1 ? util * 100 : util;
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
export function parseUsageResponse(raw: unknown): QuotaWindow[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: QuotaWindow[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const pct = pickPct(obj);
    if (pct === null) continue; // 比如 extra_usage：没有利用率，只进 raw
    out.push({ windowKind: key, utilizationPct: pct, resetsAt: pickDate(obj) });
  }
  return out;
}

export function extractOrgId(raw: unknown): string | null {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const uuid = (item as Record<string, unknown>)["uuid"] ?? (item as Record<string, unknown>)["id"];
        if (typeof uuid === "string" && uuid) return uuid;
      }
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

  private cookieHeaders(sessionKey: string): Record<string, string> {
    return {
      cookie: `sessionKey=${sessionKey}`,
      accept: "application/json",
      "user-agent": "ua-probe/0.1",
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
