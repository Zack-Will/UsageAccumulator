import { describe, expect, it } from "vitest";
import { LoginGuard } from "../src/login-guard.js";
import {
  SESSION_COOKIE,
  requestIsSecure,
  clearCookie,
  constantTimeEqualsStr,
  mintSession,
  parseCookies,
  serializeCookie,
  verifySession,
} from "../src/session.js";

const NOW = Date.UTC(2026, 8, 22, 10, 0, 0);
const HOUR = 3600_000;

describe("session / 签发与校验", () => {
  it("自己签的票自己认", () => {
    const t = mintSession("correct horse", NOW + HOUR);
    expect(verifySession(t, "correct horse", NOW)).toBe(true);
  });

  it("过期就不认", () => {
    const t = mintSession("pw", NOW + HOUR);
    expect(verifySession(t, "pw", NOW + HOUR + 1)).toBe(false);
  });

  it("★ 改密码 = 踢掉所有旧会话（签名密钥由密码派生）", () => {
    const t = mintSession("old-pw", NOW + HOUR);
    expect(verifySession(t, "old-pw", NOW)).toBe(true);
    expect(verifySession(t, "new-pw", NOW)).toBe(false);
  });

  it("签名被改一个字符就不认", () => {
    const t = mintSession("pw", NOW + HOUR);
    const parts = t.split(".");
    const sig = parts[2]!;
    const tampered = `${parts[0]}.${parts[1]}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect(verifySession(tampered, "pw", NOW)).toBe(false);
  });

  it("★ 把过期时刻往后改也没用 —— 它在签名覆盖范围内", () => {
    const t = mintSession("pw", NOW - 1); // 已经过期的票
    const parts = t.split(".");
    const forged = `${parts[0]}.${NOW + 10 * HOUR}.${parts[2]}`;
    expect(verifySession(forged, "pw", NOW)).toBe(false);
  });

  it("畸形输入一律 false，不抛", () => {
    for (const bad of ["", "x", "v1.abc.def", "v2.1.2.3", "....", undefined]) {
      expect(verifySession(bad, "pw", NOW)).toBe(false);
    }
  });

  it("服务端没配密码时任何票都不认", () => {
    const t = mintSession("", NOW + HOUR);
    expect(verifySession(t, "", NOW)).toBe(false);
  });
});

describe("session / Cookie 读写", () => {
  it("解析多个 Cookie，容忍空格与引号", () => {
    const got = parseCookies(`a=1; ${SESSION_COOKIE}="v1.2.3" ; b=%E4%B8%AD`);
    expect(got["a"]).toBe("1");
    expect(got[SESSION_COOKIE]).toBe("v1.2.3");
    expect(got["b"]).toBe("中");
  });

  it("没有 Cookie 头返回空对象而不是抛", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("garbage")).toEqual({});
  });

  it("非法百分号编码原样收下，不让整个头解析失败", () => {
    const got = parseCookies("ok=1; bad=%E4%B8");
    expect(got["ok"]).toBe("1");
    expect(got["bad"]).toBe("%E4%B8");
  });

  it("★ 会话 Cookie 必须带 HttpOnly 与 SameSite —— 那是它比 localStorage 强的地方", () => {
    const c = serializeCookie(SESSION_COOKIE, "v1.1.x", { maxAgeSec: 60, secure: true });
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Secure");
    expect(c).toContain("Max-Age=60");
  });

  it("http 下不加 Secure —— 加了浏览器根本不会存", () => {
    expect(serializeCookie(SESSION_COOKIE, "x", { secure: false })).not.toContain("Secure");
  });

  it("登出用 Max-Age=0 的空票", () => {
    const c = clearCookie(SESSION_COOKIE, true);
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("HttpOnly");
  });
});

describe("constantTimeEqualsStr", () => {
  it("长度不同返回 false 而不是抛", () => {
    expect(constantTimeEqualsStr("abc", "abcd")).toBe(false);
  });
  it("相同返回 true", () => {
    expect(constantTimeEqualsStr("abc", "abc")).toBe(true);
  });
});

describe("LoginGuard / 限速", () => {
  it("没失败过就放行", () => {
    const g = new LoginGuard();
    expect(g.check("ip", NOW).allowed).toBe(true);
  });

  it("失败后指数退避：1s、2s、4s…", () => {
    const g = new LoginGuard({ baseDelayMs: 1000 });
    g.fail("ip", NOW);
    expect(g.check("ip", NOW).retryAfterSec).toBe(1);
    g.fail("ip", NOW);
    expect(g.check("ip", NOW).retryAfterSec).toBe(2);
    g.fail("ip", NOW);
    expect(g.check("ip", NOW).retryAfterSec).toBe(4);
  });

  it("退避封顶，不会越滚越久到天荒地老", () => {
    const g = new LoginGuard({ baseDelayMs: 1000, maxDelayMs: 10_000 });
    for (let i = 0; i < 40; i++) g.fail("ip", NOW);
    expect(g.check("ip", NOW).retryAfterSec).toBe(10);
  });

  it("等够了就放行", () => {
    const g = new LoginGuard({ baseDelayMs: 1000 });
    g.fail("ip", NOW);
    expect(g.check("ip", NOW + 1001).allowed).toBe(true);
  });

  it("成功一次清零，下次失败重新从 1s 起算", () => {
    const g = new LoginGuard({ baseDelayMs: 1000 });
    g.fail("ip", NOW);
    g.fail("ip", NOW);
    g.succeed("ip");
    g.fail("ip", NOW);
    expect(g.check("ip", NOW).retryAfterSec).toBe(1);
  });

  it("不同来源互不影响", () => {
    const g = new LoginGuard({ baseDelayMs: 1000 });
    g.fail("a", NOW);
    expect(g.check("b", NOW).allowed).toBe(true);
  });

  it("久不再犯的来源会被忘掉，内存不会一直涨", () => {
    const g = new LoginGuard({ forgetAfterMs: 1000 });
    g.fail("a", NOW);
    expect(g.size).toBe(1);
    g.fail("b", NOW + 5000); // 触发 prune
    expect(g.size).toBe(1);
  });
});

describe("requestIsSecure / Secure 标志要 fail-closed", () => {
  it("X-Forwarded-Proto: https → 加", () => {
    expect(requestIsSecure({ forwardedProto: "https" })).toBe(true);
  });

  it("多级代理时只看第一跳", () => {
    expect(requestIsSecure({ forwardedProto: "https, http" })).toBe(true);
    expect(requestIsSecure({ forwardedProto: "http, https" })).toBe(false);
  });

  it("★ 反代没设这个头、域名又不是本地 → 仍然加 Secure", () => {
    // 线上入口是 nginx 容器，不确定它设不设 XFP：该加没加是悄无声息的降级，
    // 不该加却加了只会登录失败 —— 后者一眼看得见，所以往这边错。
    expect(requestIsSecure({ host: "ccusage.zackwill.space" })).toBe(true);
  });

  it("本地明文调试不加，否则浏览器根本不存这张 Cookie", () => {
    expect(requestIsSecure({ host: "localhost:5177" })).toBe(false);
    expect(requestIsSecure({ host: "127.0.0.1:8787" })).toBe(false);
    expect(requestIsSecure({ host: "[::1]:8787" })).toBe(false);
  });

  it("显式 http 头压过一切", () => {
    expect(requestIsSecure({ forwardedProto: "http", host: "ua.example.com" })).toBe(false);
  });
});
