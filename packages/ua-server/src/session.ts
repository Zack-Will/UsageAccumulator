import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * 看板会话 —— 用一个记得住的密码换一张有期限的 Cookie。
 *
 * 为什么不继续用 token：`UA_DASHBOARD_TOKEN` 是一串随机值，换台设备就得去翻
 * deploy/.env。而且 SSE 那条路 `EventSource` 不能自定义请求头，token 只能塞进
 * query string —— URL 会进访问日志、进浏览器历史、进 Referer。Cookie 两个问题一起解。
 *
 * ★ 会话是**无状态**的：Cookie 自带过期时刻和一段 HMAC，服务端不存会话表。
 *   签名密钥由密码派生（HKDF），因此**改密码 = 立刻踢掉所有旧会话** ——
 *   这正是单用户自托管场景下想要的语义，也省掉了一张需要清理的表。
 *
 * ★ 密码本身走**在线**校验，没有可离线爆破的材料（我们不发任何哈希给客户端）。
 *   所以强度靠限速兜底，见 login-guard.ts —— 一个记得住的密码必须配限速，
 *   否则「好记」直接等价于「好猜」。
 */

export const SESSION_COOKIE = "ua_session";
/** 默认 30 天：够久到不用反复输，又不至于一张 Cookie 用一年。 */
export const DEFAULT_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const KDF_SALT = "ua-dashboard-session";
const KDF_INFO = "v1";
const PREFIX = "v1";

/** 密码 → 会话签名密钥。密码变了密钥就变，旧 Cookie 当场失效。 */
export function sessionKey(password: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(password, "utf8"), KDF_SALT, KDF_INFO, 32));
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** 签一张到 `expiresAtMs` 为止的会话票。 */
export function mintSession(password: string, expiresAtMs: number): string {
  const payload = `${PREFIX}.${Math.floor(expiresAtMs)}`;
  return `${payload}.${sign(sessionKey(password), payload)}`;
}

/**
 * 校验会话票。任何一步不对都返回 false，不区分原因 ——
 * 「签名错」和「过期了」对调用方是同一件事：重新登录。
 */
export function verifySession(
  value: string | undefined,
  password: string,
  nowMs: number,
): boolean {
  if (!value || !password) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= nowMs) return false;

  const expected = sign(sessionKey(password), `${parts[0]}.${parts[1]}`);
  return constantTimeEqualsStr(expected, parts[2]!);
}

/** 长度不同就直接 false —— timingSafeEqual 对不等长会抛。 */
export function constantTimeEqualsStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 解析 Cookie 头。
 *
 * 刻意不引 @fastify/cookie：服务端在 NAS VM 上是直接跑源码的，
 * 加一个依赖就意味着那边得先 pnpm install 才能启动，为了一个十行的解析不值当。
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v; // 不是合法百分号编码就原样收下，别让整个头解析失败
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec?: number;
  /** 只有走 https 才加 Secure：本地 http://localhost 调试时加了反而设不上 */
  secure?: boolean;
  path?: string;
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${o.path ?? "/"}`);
  // HttpOnly：会话票**不**给 JS 读。比 localStorage 里的 token 抗 XSS。
  bits.push("HttpOnly");
  // Lax 而不是 Strict：从外部链接点进看板时也该是登录态；
  // 看板没有任何 GET 型副作用接口，Lax 足够挡住 CSRF。
  bits.push("SameSite=Lax");
  if (o.secure) bits.push("Secure");
  if (o.maxAgeSec !== undefined) bits.push(`Max-Age=${Math.floor(o.maxAgeSec)}`);
  return bits.join("; ");
}

/** 过期 Cookie，用于登出。 */
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAgeSec: 0, secure });
}
