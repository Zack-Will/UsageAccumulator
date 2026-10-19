import { describe, expect, it } from "vitest";
import { CodexSampler, CODEX_VAULT_ID } from "../src/codex-sampler.js";
import type { CodexFetch } from "../src/codex-web.js";
import type { SessionVault } from "../src/quota-vault.js";

let clock = Date.parse("2026-10-19T04:00:00Z");
const jwt = (email: string) => `h.${Buffer.from(JSON.stringify({
  email, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
})).toString("base64url")}.s`;

function memVault(): SessionVault & { value: string | null } {
  const v = {
    value: null as string | null,
    list: async () => (v.value ? [CODEX_VAULT_ID] : []),
    read: async () => v.value,
    write: async (_id: string, s: string) => { v.value = s; },
    remove: async () => { const had = v.value !== null; v.value = null; return had; },
  };
  return v;
}

/** 假的 auth.openai.com + chatgpt.com：approved 之前轮询一律 403 */
function fakeAuth(opts: { email?: string } = {}) {
  const state = { approved: false, calls: [] as Array<{ url: string; body?: string; contentType?: string }> };
  const json = (status: number, body: object) => ({ status, contentType: "application/json", text: JSON.stringify(body) });
  const http: CodexFetch = async (url, init) => {
    state.calls.push({ url, body: init.body, contentType: init.headers["Content-Type"] });
    if (url.endsWith("/deviceauth/usercode")) return json(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" });
    if (url.endsWith("/deviceauth/token")) {
      return state.approved ? json(200, { authorization_code: "code-1", code_challenge: "c", code_verifier: "ver-1" }) : json(403, {});
    }
    if (url.endsWith("/oauth/token")) {
      return json(200, { access_token: "access-dev", refresh_token: "refresh-dev", id_token: jwt(opts.email ?? "codex@example.test") });
    }
    if (url.endsWith("/wham/usage")) return json(200, { plan_type: "pro", rate_limit: { allowed: true, limit_reached: false,
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: clock / 1000 + 100 } } });
    return json(404, {});
  };
  return { http, state };
}

function sampler(vault: SessionVault, http: CodexFetch) {
  return new CodexSampler({
    vault, http, configuredEmail: () => "codex@example.test", record: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => new Date(clock), random: () => 0, devicePoll: false,
  });
}

describe("Codex 网页登录（设备码）", () => {
  it("给出链接与验证码；确认前一直等，确认后换 token、落盘、立刻抓一次", async () => {
    const vault = memVault();
    const { http, state } = fakeAuth();
    const s = sampler(vault, http);
    const started = await s.startDeviceLogin();
    expect(started.state).toBe("none");
    expect(started.device).toMatchObject({ state: "waiting", userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device" });

    await s.pollDeviceOnce();
    expect((await s.status()).device?.state).toBe("waiting");
    expect(vault.value).toBeNull();

    state.approved = true;
    await s.pollDeviceOnce();
    const done = await s.status();
    expect(done.state).toBe("ok");
    expect(done.device).toBeNull();
    expect(JSON.parse(vault.value!)).toMatchObject({ refresh_token: "refresh-dev", access_token: "access-dev" });
    // 授权码换 token 用表单编码，带上 Codex 的回调地址与 PKCE verifier
    const exchange = state.calls.find((c) => c.url.endsWith("/oauth/token"))!;
    expect(exchange.contentType).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toMatchObject({
      grant_type: "authorization_code", code: "code-1", code_verifier: "ver-1",
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    });
  });

  it("登录的是别的 ChatGPT 账号：不落盘，网页登录标失败", async () => {
    const vault = memVault();
    const { http, state } = fakeAuth({ email: "someone@example.test" });
    const s = sampler(vault, http);
    await s.startDeviceLogin();
    state.approved = true;
    await s.pollDeviceOnce();
    expect(vault.value).toBeNull();
    expect((await s.status()).device).toMatchObject({ state: "failed", error: expect.stringMatching(/UA_CODEX_ACCOUNT_EMAIL/) });
  });

  it("15 分钟没确认就过期，不再轮询", async () => {
    const { http, state } = fakeAuth();
    const s = sampler(memVault(), http);
    await s.startDeviceLogin();
    clock += 16 * 60_000;
    expect((await s.status()).device?.state).toBe("expired");
    const before = state.calls.length;
    await s.pollDeviceOnce();
    expect(state.calls.length).toBe(before);
  });
});
