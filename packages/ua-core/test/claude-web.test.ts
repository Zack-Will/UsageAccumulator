import { describe, expect, it } from "vitest";
import {
  checkClaudeResponse,
  ClaudeWebClient,
  parseOrganizations,
  parseUsageResponse,
  planFromTier,
  QuotaAuthError,
  QuotaUnavailableError,
  unambiguousOrg,
  type HttpGet,
} from "../src/index.js";

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

describe("组织列表", () => {
  // 2026-09-27 实测形态：同一个 sessionKey 下 team + 个人 Max，Max 不带 raven
  const ORGS = [
    { uuid: "org-team", name: "Kimmy Inc.", rate_limit_tier: "default_raven", capabilities: ["chat", "raven"] },
    { uuid: "org-max", name: "Personal", rate_limit_tier: "default_claude_max_5x", capabilities: ["chat", "claude_max"] },
  ];

  it("解析名称、档位与能力，跳过没有 uuid 的", () => {
    const orgs = parseOrganizations([...ORGS, { name: "x" }]);
    expect(orgs.map((o) => [o.uuid, o.name, o.rateLimitTier])).toEqual([
      ["org-team", "Kimmy Inc.", "default_raven"],
      ["org-max", "Personal", "default_claude_max_5x"],
    ]);
  });

  it("档位映射成 plan", () => {
    expect(planFromTier("default_claude_max_5x")).toBe("max_5x");
    expect(planFromTier("default_claude_max_20x")).toBe("max_20x");
    expect(planFromTier("default_raven")).toBe("team");
    expect(planFromTier(null)).toBeNull();
  });

  it("team + Max 两个都能用 Claude Code：有歧义，不挑", () => {
    expect(unambiguousOrg(parseOrganizations(ORGS))).toBeNull();
    expect(unambiguousOrg(parseOrganizations([ORGS[1]]))?.uuid).toBe("org-max");
    // 只有一个能用 Claude Code（另一个是纯 chat 的免费组织）时照样自动选
    expect(unambiguousOrg(parseOrganizations([ORGS[1], { uuid: "org-free", capabilities: ["chat"] }]))?.uuid).toBe("org-max");
  });
});

describe("parseUsageResponse · 只认 limits[]", () => {
  it("个人 Max 响应（2026-09-27 实测形态）：美元额度与占位 key 不成窗口", () => {
    const dollars = { utilization: 0, used_dollars: 0, limit_dollars: 250, remaining_dollars: 250, locked_reason: null };
    const empty = { utilization: 0, resets_at: null, used_dollars: null, limit_dollars: null };
    const w = (u: number, r: string) => ({ utilization: u, resets_at: r, used_dollars: null, limit_dollars: null });
    const windows = parseUsageResponse({
      five_hour: w(13, "2026-09-27T07:59:59Z"),
      seven_day: w(2, "2026-09-30T17:59:59Z"),
      iguana_necktie: { ...dollars, resets_at: "2026-11-05T07:59:00Z" },
      nimbus_quill: empty,
      extra_usage: { is_enabled: false, utilization: null },
      limits: [
        { kind: "session", percent: 13, resets_at: "2026-09-27T07:59:59Z" },
        { kind: "weekly_all", percent: 2, resets_at: "2026-09-30T17:59:59Z" },
        { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 0, resets_at: "2026-09-30T18:00:00Z" },
      ],
    });
    expect(windows.map((x) => [x.windowKind, x.utilizationPct])).toEqual([
      ["five_hour", 13],
      ["seven_day", 2],
      ["seven_day_fable", 0],
    ]);
  });
});
