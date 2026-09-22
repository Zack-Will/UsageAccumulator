import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type UaApp } from "../src/app.js";
import { MemoryStore } from "../src/store-memory.js";
import { SESSION_COOKIE } from "../src/session.js";
import { AUTH, testConfig } from "./helpers.js";

let store: MemoryStore;
let app: UaApp;

beforeEach(async () => {
  store = new MemoryStore();
  app = buildApp({ store, config: testConfig() });
  await app.fastify.ready();
});
afterEach(async () => {
  await app.fastify.close();
});

/** 从 set-cookie 里把会话票抠出来，模拟浏览器回传 */
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0]! : (raw as string);
  return line.split(";")[0]!;
}

async function login(password = "open-sesame") {
  return app.fastify.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { password },
  });
}

describe("POST /v1/auth/login", () => {
  it("密码对 → 下发 HttpOnly 会话 Cookie", async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(true);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("密码错 → 401，且不下发任何 Cookie", async () => {
    const res = await login("wrong");
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("★ 连错会被限速挡住，并给出 Retry-After", async () => {
    await login("wrong");
    const res = await login("wrong");
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("★ 限速期间**正确**的密码也进不来 —— 否则限速等于没有", async () => {
    await login("wrong");
    const res = await login("open-sesame");
    expect(res.statusCode).toBe(429);
  });

  it("没配密码的服务端回 404，而不是假装密码错", async () => {
    const bare = buildApp({ store, config: testConfig({ dashboardPassword: "" }) });
    await bare.fastify.ready();
    const res = await bare.fastify.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { password: "x" },
    });
    expect(res.statusCode).toBe(404);
    await bare.fastify.close();
  });

  it("空 body / 空密码 → 400", async () => {
    const res = await app.fastify.inject({ method: "POST", url: "/v1/auth/login", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe("会话 Cookie 当凭证用", () => {
  it("拿着 Cookie 就能读数据接口，不用再带 Authorization", async () => {
    const cookie = cookieFrom(await login());
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/machines",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("★ SSE 也认 Cookie —— 这条路以前只能把 token 塞进 query string", async () => {
    const cookie = cookieFrom(await login());
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/stream?profile_id=claude-official",
      headers: { cookie },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    res.stream().destroy();
  });

  it("伪造的 Cookie 一律 401", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/machines",
      headers: { cookie: `${SESSION_COOKIE}=v1.99999999999999.forged` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("什么都不带 → 401", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/v1/machines" });
    expect(res.statusCode).toBe(401);
  });

  it("★ 老的 Bearer token 仍然好使 —— 菜单栏和脚本不能被这次改动打断", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/machines",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /v1/auth/session", () => {
  it("没登录时 authenticated=false，但告诉前端这台服务端支持密码登录", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/v1/auth/session" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: false, password_login: true });
  });

  it("登录后 authenticated=true", async () => {
    const cookie = cookieFrom(await login());
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie },
    });
    expect(res.json().authenticated).toBe(true);
  });

  it("服务端没配密码时 password_login=false，前端据此退回 token 输入框", async () => {
    const bare = buildApp({ store, config: testConfig({ dashboardPassword: "" }) });
    await bare.fastify.ready();
    const res = await bare.fastify.inject({ method: "GET", url: "/v1/auth/session" });
    expect(res.json().password_login).toBe(false);
    await bare.fastify.close();
  });
});

describe("POST /v1/auth/logout", () => {
  it("清掉 Cookie，之后就进不去了", async () => {
    const cookie = cookieFrom(await login());
    const out = await app.fastify.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie },
    });
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    const cleared = cookieFrom(out);
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/machines",
      headers: { cookie: cleared },
    });
    expect(res.statusCode).toBe(401);
  });
});
