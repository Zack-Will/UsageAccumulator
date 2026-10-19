import { describe, expect, it } from "vitest";
import type { CodexIngestBatch } from "@ua/core";
import { CodexSampler, CODEX_VAULT_ID } from "../src/codex-sampler.js";
import { normalizeWhamUsage, parseCodexCredentialInput, type CodexFetch } from "../src/codex-web.js";
import type { SessionVault } from "../src/quota-vault.js";

const NOW = new Date("2026-10-19T04:00:00Z");
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const ID_TOKEN = jwt({
  email: "Codex@Example.test",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
});
const authJson = (refreshedAt: string) => JSON.stringify({
  tokens: { id_token: ID_TOKEN, access_token: "access-old", refresh_token: "refresh-0", account_id: "acct-1" },
  last_refresh: refreshedAt,
});
const USAGE = {
  plan_type: "pro",
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 34, limit_window_seconds: 18000, reset_after_seconds: 7000, reset_at: NOW.getTime() / 1000 + 7000 },
    secondary_window: { used_percent: 51, limit_window_seconds: 604800, reset_after_seconds: 200000, reset_at: NOW.getTime() / 1000 + 200000 },
  },
  additional_rate_limits: [{ limit_name: "GPT-6 Astra", metered_feature: "gpt_6_astra", rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 1, reset_at: NOW.getTime() / 1000 + 100 },
  } }],
  rate_limit_reset_credits: { available_count: 2 },
};
const CREDITS = { available_count: 2, credits: [
  { id: "c1", reset_type: "full", status: "available", granted_at: "2026-10-18T00:00:00Z", expires_at: "2026-11-01T00:00:00Z", title: "Reset", description: "x" },
] };

function memVault(initial?: string): SessionVault & { value: string | null; writes: string[] } {
  const v = {
    value: initial ?? null as string | null,
    writes: [] as string[],
    list: async () => (v.value ? [CODEX_VAULT_ID] : []),
    read: async () => v.value,
    write: async (_id: string, s: string) => { v.value = s; v.writes.push(s); },
    remove: async () => { const had = v.value !== null; v.value = null; return had; },
  };
  return v;
}

/** 假的 ChatGPT 后端：按 URL 路由；记录每次请求用的 token */
function backend(opts: { usageStatus?: (token: string) => number; refresh?: () => { status: number; body: object } } = {}) {
  const calls: Array<{ url: string; auth?: string; body?: string }> = [];
  let n = 0;
  const http: CodexFetch = async (url, init) => {
    calls.push({ url, auth: init.headers["Authorization"], body: init.body });
    const json = (status: number, body: object) => ({ status, contentType: "application/json", text: JSON.stringify(body) });
    if (url.endsWith("/oauth/token")) {
      const r = opts.refresh?.() ?? { status: 200, body: { access_token: `access-${++n}`, refresh_token: `refresh-${n}`, id_token: ID_TOKEN } };
      return json(r.status, r.body);
    }
    if (url.endsWith("/wham/usage")) {
      const token = (init.headers["Authorization"] ?? "").replace("Bearer ", "");
      const status = opts.usageStatus?.(token) ?? 200;
      return status === 200 ? json(200, USAGE) : json(status, { detail: "nope" });
    }
    if (url.endsWith("/wham/rate-limit-reset-credits")) return json(200, CREDITS);
    return json(404, {});
  };
  return { http, calls };
}

function sampler(vault: SessionVault, http: CodexFetch, email = "codex@example.test") {
  const recorded: CodexIngestBatch[] = [];
  const s = new CodexSampler({
    vault, http, configuredEmail: () => email,
    record: async (b) => { recorded.push(b); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => NOW, random: () => 0,
  });
  return { s, recorded };
}

describe("Codex 服务端采集", () => {
  it("把 /wham/usage 规整成与探针同形的快照，window_id 一致，带上重置券", () => {
    const { snapshot, plan_type } = normalizeWhamUsage(USAGE, CREDITS, NOW);
    expect(plan_type).toBe("pro");
    expect(snapshot.windows.map((w) => [w.window_id, w.used_percent, w.duration_minutes])).toEqual([
      ["codex:primary", 34, 300], ["codex:secondary", 51, 10080], ["gpt_6_astra:primary", 12, 10080],
    ]);
    expect(snapshot.windows[2]!.label).toBe("GPT-6 Astra");
    expect(snapshot.reset_credits).toEqual({ available_count: 2, credits: [
      { reset_type: "full", status: "available", granted_at: "2026-10-18T00:00:00.000Z", expires_at: "2026-11-01T00:00:00.000Z", title: "Reset" },
    ] });
  });

  it("粘贴整份 auth.json 或单独的 refresh token 都认；API key 形态的 auth.json 拒收", () => {
    expect(parseCodexCredentialInput(authJson("2026-10-18T00:00:00Z"))).toMatchObject({ refresh_token: "refresh-0", access_token: "access-old" });
    expect(parseCodexCredentialInput("rt_abcdefghijklmnopqrstuvwxyz")).toMatchObject({ refresh_token: "rt_abcdefghijklmnopqrstuvwxyz", access_token: null });
    expect(() => parseCodexCredentialInput(JSON.stringify({ OPENAI_API_KEY: "sk-x" }))).toThrow(/refresh_token/);
  });

  it("access token 新鲜就直接用，不轮换；成功后以 ua-server 身份入库", async () => {
    const vault = memVault();
    const { http, calls } = backend();
    const { s, recorded } = sampler(vault, http);
    expect((await s.save(authJson("2026-10-18T00:00:00Z"))).state).toBe("ok");
    expect(calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith("/wham/usage"))!.auth).toBe("Bearer access-old");
    expect(recorded[0]!.account).toEqual({ account_id: "acct-1", email: "codex@example.test", plan_type: "pro" });
    expect(recorded[0]!.quota!.windows).toHaveLength(3);
  });

  it("access token 旧了先轮换：新 refresh token 先落盘，再用新的 access token 读额度", async () => {
    const vault = memVault();
    const order: string[] = [];
    const { http } = backend();
    const tracked: CodexFetch = async (url, init) => { order.push(url.endsWith("/oauth/token") ? "refresh" : url.endsWith("/usage") ? "usage" : "other"); return http(url, init); };
    const write = vault.write;
    vault.write = async (id, v) => { order.push("persist"); return write(id, v); };
    const { s } = sampler(vault, tracked);
    await s.save(authJson("2026-10-01T00:00:00Z"));
    expect(order.slice(1, 4)).toEqual(["refresh", "persist", "usage"]); // order[0] 是 save 自己的落盘
    expect(JSON.parse(vault.value!)).toMatchObject({ refresh_token: "refresh-1", access_token: "access-1", refreshed_at: NOW.toISOString() });
  });

  it("access token 被拒：轮换一次再试，不无限重试", async () => {
    const vault = memVault();
    const { http, calls } = backend({ usageStatus: (t) => (t === "access-old" ? 401 : 200) });
    const { s } = sampler(vault, http);
    expect((await s.save(authJson("2026-10-18T00:00:00Z"))).state).toBe("ok");
    expect(calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/wham/usage")).map((c) => c.auth)).toEqual(["Bearer access-old", "Bearer access-1"]);
  });

  it("refresh token 已被用过：报登录失效、退避，采集器卡上留一条 auth 心跳", async () => {
    const vault = memVault();
    const { http, calls } = backend({ refresh: () => ({ status: 401, body: { error: { code: "refresh_token_reused" } } }) });
    const { s, recorded } = sampler(vault, http);
    const status = await s.save(authJson("2026-10-01T00:00:00Z"));
    expect(status.state).toBe("auth");
    expect(status.error).toMatch(/已被用过/);
    expect(status.nextAttemptAt!.getTime() - NOW.getTime()).toBe(15 * 60_000);
    expect(calls.filter((c) => c.url.endsWith("/wham/usage"))).toHaveLength(0);
    expect(recorded.at(-1)!.collector).toMatchObject({ state: "auth", error_code: "codex_server_auth" });
    await s.tick(); // 退避期内不再打
    expect(calls.filter((c) => c.url.endsWith("/oauth/token"))).toHaveLength(1);
  });

  it("登录的不是配置的账号：保存时就拒收", async () => {
    const { http } = backend();
    const { s } = sampler(memVault(), http, "someone-else@example.test");
    await expect(s.save(authJson("2026-10-18T00:00:00Z"))).rejects.toMatchObject({ status: 409 });
  });

  it("Cloudflare 质询：标 blocked，不当成登录失效", async () => {
    const vault = memVault();
    const http: CodexFetch = async (url) => (url.endsWith("/wham/usage")
      ? { status: 403, contentType: "text/html", text: "<html>challenge</html>" }
      : { status: 200, contentType: "application/json", text: "{}" });
    const { s } = sampler(vault, http);
    expect((await s.save(authJson("2026-10-18T00:00:00Z"))).state).toBe("blocked");
  });
});
