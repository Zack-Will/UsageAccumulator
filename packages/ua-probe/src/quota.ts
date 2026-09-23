import { request } from "undici";
import { ClaudeWebClient, QuotaAuthError, type HttpGet, type QuotaSnapshot } from "@ua/core";
import type { CredentialStore } from "./credentials.js";

// 请求头、判错与解析挪到了 @ua/core —— 服务端直接抓额度也要用同一份。这里原样转出，老的引用路径不变
export {
  QuotaAuthError,
  QuotaUnavailableError,
  extractOrgId,
  limitWindowKind,
  parseLimits,
  parseUsageResponse,
  type HttpGet,
  type HttpResponse,
} from "@ua/core";

/**
 * 额度来源抽象。官方接口的字段与鉴权方式都不稳定，
 * 换实现时只动这一层（ARCHITECTURE §5.3）。
 */
export interface QuotaSource {
  readonly id: string;
  fetch(profileId: string, now?: Date): Promise<QuotaSnapshot>;
}

const undiciGet: HttpGet = async (url, headers) => {
  const res = await request(url, { method: "GET", headers, headersTimeout: 20_000, bodyTimeout: 20_000 });
  return { status: res.statusCode, text: await res.body.text() };
};

/**
 * 探针代抓 claude.ai 额度（旧路径；默认由服务端直接抓，见 ARCHITECTURE §5.3）。
 * Cookie: sessionKey，**只从本机凭证库读，不落盘、不进日志、不上报**。
 */
export class ClaudeWebSource implements QuotaSource {
  readonly id = "claude_web";
  private cachedOrgId: string | null = null;
  private readonly client: ClaudeWebClient;

  constructor(
    private readonly credentials: CredentialStore,
    baseUrl = "https://claude.ai",
    get: HttpGet = undiciGet,
  ) {
    this.client = new ClaudeWebClient(get, baseUrl);
  }

  async resolveOrgId(sessionKey: string): Promise<string> {
    if (this.cachedOrgId) return this.cachedOrgId;
    this.cachedOrgId = await this.client.orgId(sessionKey);
    return this.cachedOrgId;
  }

  async fetch(profileId: string, now = new Date()): Promise<QuotaSnapshot> {
    const sessionKey = await this.credentials.read();
    if (!sessionKey) {
      throw new QuotaAuthError(`凭证不可用（${this.credentials.kind}）：${this.credentials.hint()}`, 401);
    }
    const orgId = await this.resolveOrgId(sessionKey);
    return this.client.snapshot(sessionKey, orgId, profileId, now);
  }
}
