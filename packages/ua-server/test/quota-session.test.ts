import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QuotaAuthError, QuotaUnavailableError, type QuotaSnapshot } from "@ua/core";
import { buildApp, type UaApp } from "../src/app.js";
import { MemorySessionVault } from "../src/quota-vault.js";
import { MemoryStore } from "../src/store-memory.js";
import { AUTH, testConfig } from "./helpers.js";

const NOW = new Date("2026-09-23T10:00:00.000Z");
const GOOD = "sk-ant-sid01-GOOD-SECRET-VALUE-1234";
const BAD = "sk-ant-sid01-REVOKED-VALUE-5678";

/** claude.ai 替身：只认 GOOD；blocked / down 用来模拟 Cloudflare 与网络故障。 */
class FakeClaude {
  mode: "normal" | "blocked" | "down" = "normal";
  private check(key: string): void {
    if (this.mode === "blocked") throw new QuotaAuthError("GET x 被 Cloudflare 质询（403）", 403, "challenge");
    if (this.mode === "down") throw new QuotaUnavailableError("GET x 返回 HTTP 503");
    if (key !== GOOD) throw new QuotaAuthError("GET x 返回 403，sessionKey 可能已失效", 403, "session");
  }
  async orgId(key: string): Promise<string> {
    this.check(key);
    return "org-1";
  }
  async snapshot(key: string, _org: string, profileId: string, now = new Date()): Promise<QuotaSnapshot> {
    this.check(key);
    return { profileId, capturedAt: now, windows: [{ windowKind: "five_hour", utilizationPct: 37, resetsAt: null }], raw: {} };
  }
}

let store: MemoryStore;
let vault: MemorySessionVault;
let claude: FakeClaude;
let app: UaApp;
let machineAuth: { authorization: string };

beforeEach(async () => {
  store = new MemoryStore();
  await store.ensureProfiles(["claude-official"]);
  vault = new MemorySessionVault();
  claude = new FakeClaude();
  app = buildApp({ store, config: testConfig(), now: () => NOW, quota: { vault, client: claude } });
  await app.fastify.ready();
  const res = await app.fastify.inject({
    method: "POST",
    url: "/v1/enroll",
    payload: { enroll_token: "enroll-token", hostname: "mac", os: "darwin" },
  });
  machineAuth = { authorization: `Bearer ${(res.json() as { machine_token: string }).machine_token}` };
});
afterEach(async () => {
  await app.fastify.close();
});

function put(sessionKey: string, headers: Record<string, string> = AUTH) {
  return app.fastify.inject({
    method: "PUT",
    url: "/v1/quota/session",
    headers,
    payload: { profile_id: "claude-official", session_key: sessionKey },
  });
}

describe("/v1/quota/session", () => {
  it("没登录时是 none；不带凭证 401", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/v1/quota/session?profile_id=claude-official", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ profile_id: "claude-official", state: "none", last_ok_at: null });
    expect((await app.fastify.inject({ method: "GET", url: "/v1/quota/session" })).statusCode).toBe(401);
  });

  it("保存有效会话：先验后存，立刻抓一次并入库；返回里没有 sessionKey", async () => {
    const res = await put(GOOD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "ok", last_ok_at: NOW.toISOString() });
    expect(res.body).not.toContain(GOOD);
    expect(await vault.read("claude-official")).toBe(GOOD);
    // 服务端自己抓的：machine_id 留空
    expect(store.quota).toHaveLength(1);
    expect(store.quota[0]?.machineId).toBeNull();

    const status = await app.fastify.inject({ method: "GET", url: "/v1/quota/session?profile_id=claude-official", headers: AUTH });
    expect(status.body).not.toContain(GOOD);
  });

  it("claude.ai 不认的会话不落盘，也不顶掉原来那个好的", async () => {
    await put(GOOD);
    const res = await put(BAD);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "bad_request", message: "claude.ai 不认这个 sessionKey" } });
    expect(await vault.read("claude-official")).toBe(GOOD);
  });

  it("被 Cloudflare 拦 / 连不上 claude.ai 是 502 upstream，不是「会话无效」", async () => {
    claude.mode = "blocked";
    const blocked = await put(GOOD);
    expect(blocked.statusCode).toBe(502);
    expect(blocked.json()).toMatchObject({ error: { code: "upstream" } });
    claude.mode = "down";
    expect((await put(GOOD)).json()).toMatchObject({ error: { code: "upstream" } });
    expect(await vault.read("claude-official")).toBeNull();
  });

  it("格式明显不对的直接 400，连 claude.ai 都不去问", async () => {
    expect((await put("short")).statusCode).toBe(400);
    expect((await put("sk-ant-sid01 with spaces inside")).statusCode).toBe(400);
  });

  it("探针的 machine token 只能看状态，不能改会话", async () => {
    expect((await put(GOOD, machineAuth)).statusCode).toBe(403);
    const del = await app.fastify.inject({ method: "DELETE", url: "/v1/quota/session?profile_id=claude-official", headers: machineAuth });
    expect(del.statusCode).toBe(403);
    const get = await app.fastify.inject({ method: "GET", url: "/v1/quota/session?profile_id=claude-official", headers: machineAuth });
    expect(get.statusCode).toBe(200);
  });

  it("删除后回到 none", async () => {
    await put(GOOD);
    const res = await app.fastify.inject({ method: "DELETE", url: "/v1/quota/session?profile_id=claude-official", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "none" });
    expect(await vault.read("claude-official")).toBeNull();
  });

  it("profile_id 带路径字符直接拒绝", async () => {
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/v1/quota/session",
      headers: AUTH,
      payload: { profile_id: "../../etc/passwd", session_key: GOOD },
    });
    expect(res.statusCode).toBe(400);
  });

  it("服务端没开采集时报 disabled，写接口 404", async () => {
    await app.fastify.close();
    app = buildApp({ store, config: testConfig(), now: () => NOW });
    await app.fastify.ready();
    const get = await app.fastify.inject({ method: "GET", url: "/v1/quota/session?profile_id=claude-official", headers: AUTH });
    expect(get.json()).toMatchObject({ state: "disabled" });
    expect((await put(GOOD)).statusCode).toBe(404);
  });
});

describe("POST /v1/ingest/quota 的来源", () => {
  it("machine_id 以鉴权身份为准：探针 body 里从来不带它", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/quota",
      headers: machineAuth,
      payload: {
        profile_id: "claude-official",
        captured_at: NOW.toISOString(),
        windows: [{ window_kind: "five_hour", utilization_pct: 12, resets_at: null }],
        raw: {},
      },
    });
    expect(res.statusCode).toBe(200);
    expect(store.quota.at(-1)?.machineId).toBeTruthy();
  });
});

describe("GET /v1/windows/current?burn_points", () => {
  it("限制曲线点数；越界 400", async () => {
    for (let i = 0; i < 30; i++) {
      await store.insertQuotaSnapshot({
        profileId: "claude-official",
        capturedAt: new Date(NOW.getTime() - (30 - i) * 5 * 60_000),
        windows: [{ windowKind: "seven_day", utilizationPct: 10 + i * 0.5, resetsAt: new Date("2026-09-29T00:00:00Z") }],
        raw: {},
      });
    }
    const full = await app.fastify.inject({ method: "GET", url: "/v1/windows/current?profile_id=claude-official", headers: AUTH });
    const lite = await app.fastify.inject({ method: "GET", url: "/v1/windows/current?profile_id=claude-official&burn_points=2", headers: AUTH });
    type W = { windows: { burn_curve: unknown[] }[] };
    expect((full.json() as W).windows[0]!.burn_curve.length).toBeGreaterThan(2);
    expect((lite.json() as W).windows[0]!.burn_curve.length).toBeLessThanOrEqual(2);
    const bad = await app.fastify.inject({ method: "GET", url: "/v1/windows/current?burn_points=1", headers: AUTH });
    expect(bad.statusCode).toBe(400);
  });
});
