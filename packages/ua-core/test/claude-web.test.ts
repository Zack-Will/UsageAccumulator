import { describe, expect, it } from "vitest";
import { checkClaudeResponse, ClaudeWebClient, QuotaAuthError, QuotaUnavailableError, type HttpGet } from "../src/index.js";

const SESSION_INVALID = JSON.stringify({
  type: "error",
  error: { type: "permission_error", message: "Invalid authorization", details: { error_code: "account_session_invalid" } },
});

function authError(fn: () => unknown): QuotaAuthError {
  try {
    fn();
  } catch (err) {
    if (err instanceof QuotaAuthError) return err;
    throw err;
  }
  throw new Error("expected QuotaAuthError");
}

describe("checkClaudeResponse", () => {
  it("claude.ai 自己的 403 JSON 是会话失效", () => {
    const err = authError(() => checkClaudeResponse({ status: 403, text: SESSION_INVALID }, "GET x"));
    expect(err.reason).toBe("session");
    expect(err.status).toBe(403);
  });

  it("Cloudflare 的 HTML 质询页单独归为 challenge —— 换会话也没用，提示不能混", () => {
    const html = "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>";
    expect(authError(() => checkClaudeResponse({ status: 403, text: html }, "GET x")).reason).toBe("challenge");
  });

  it("401 一律是会话问题", () => {
    expect(authError(() => checkClaudeResponse({ status: 401, text: "" }, "GET x")).reason).toBe("session");
  });

  it("其余非 2xx 与非 JSON 是暂时不可用，不是凭证问题", () => {
    expect(() => checkClaudeResponse({ status: 503, text: "{}" }, "GET x")).toThrow(QuotaUnavailableError);
    expect(() => checkClaudeResponse({ status: 200, text: "<html>" }, "GET x")).toThrow(QuotaUnavailableError);
  });
});

describe("ClaudeWebClient", () => {
  it("sessionKey 只进请求头，不进错误信息", async () => {
    const secret = "sk-ant-sid01-SECRET-VALUE";
    const seen: Record<string, string>[] = [];
    const get: HttpGet = async (_url, headers) => {
      seen.push(headers);
      return { status: 403, text: SESSION_INVALID };
    };
    const err = await new ClaudeWebClient(get).orgId(secret).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(QuotaAuthError);
    expect(err?.message).not.toContain(secret);
    expect(seen[0]?.["cookie"]).toBe(`sessionKey=${secret}`);
  });

  it("用解析出的 org 取 usage，窗口原样透传", async () => {
    const get: HttpGet = async (url) => {
      if (url.endsWith("/api/organizations")) {
        return { status: 200, text: JSON.stringify([{ uuid: "org-personal" }, { uuid: "org-code", capabilities: ["raven"] }]) };
      }
      expect(url).toContain("/api/organizations/org-code/usage");
      return { status: 200, text: JSON.stringify({ five_hour: { utilization: 12, resets_at: "2026-09-24T01:00:00Z" } }) };
    };
    const client = new ClaudeWebClient(get);
    const orgId = await client.orgId("k");
    const snap = await client.snapshot("k", orgId, "claude-official", new Date("2026-09-23T10:00:00Z"));
    expect(orgId).toBe("org-code");
    expect(snap.windows).toEqual([
      { windowKind: "five_hour", utilizationPct: 12, resetsAt: new Date("2026-09-24T01:00:00Z") },
    ]);
  });
});
