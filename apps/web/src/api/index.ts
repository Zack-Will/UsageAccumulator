import { createLiveApi } from "./live";
import { createMockApi } from "./mock";
import type { UaApi } from "./types";

export * from "./types";
export { ApiError, type ApiErrorCode } from "./live";

export type DataSource = "mock" | "live";

/**
 * 数据源。**生产构建只有 live**：mock 是开发期没有服务端时调界面用的，不进线上产物，也不给切换。
 * 以前顶栏有个 mock/live 开关、还记在 localStorage 里 —— 点过一次 mock 的浏览器，线上看板就一直是假数据。
 *
 * 开发期优先级：URL ?source=mock|live（临时试）> 环境变量 VITE_UA_DATA_SOURCE（.env.local）> mock。
 */
export function resolveDataSource(): DataSource {
  if (import.meta.env.PROD) return "live";
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("source");
  if (fromUrl === "mock" || fromUrl === "live") return fromUrl;
  const fromEnv = import.meta.env.VITE_UA_DATA_SOURCE;
  if (fromEnv === "mock" || fromEnv === "live") return fromEnv;
  return "mock";
}

const TOKEN_KEY = "ua.token";

/**
 * 看板 token 的运行时来源。
 *
 * ★ 公网托管下**绝不能**只靠 `VITE_UA_TOKEN`：那是构建期常量，会被原样打进
 *   公开的 JS 产物，任何能打开页面的人都能读出来并查走全部用量数据。
 *   因此优先读 localStorage（用户在本机输入一次），env 只作开发期便利。
 *   生产构建必须**不带** VITE_UA_TOKEN。
 */
export function readToken(): string {
  try {
    const stored = globalThis.localStorage?.getItem(TOKEN_KEY);
    if (stored) return stored;
  } catch {
    /* 隐私模式下 localStorage 可能抛错 */
  }
  return import.meta.env.VITE_UA_TOKEN ?? "";
}

export function persistToken(token: string): void {
  try {
    globalThis.localStorage?.setItem(TOKEN_KEY, token);
  } catch {
    /* 忽略 */
  }
}

export function clearToken(): void {
  try {
    globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    /* 忽略 */
  }
}

// ── 会话（密码登录）────────────────────────────────────────────────────────
//
// 为什么从 token 改成密码：token 是一串随机值，换台设备就得去翻 deploy/.env。
// 密码记得住，而且服务端把它换成一张 HttpOnly 的会话 Cookie ——
// 比存在 localStorage 里的 token 抗 XSS，SSE 也终于有凭证可带了。

export interface SessionStatus {
  authenticated: boolean;
  /** false = 这台服务端没配 UA_DASHBOARD_PASSWORD，只能退回 token */
  password_login: boolean;
}

function apiBase(): string {
  return import.meta.env.VITE_UA_API_BASE ?? "";
}

/** 问一句「我还登着吗」。网络不通时当作未登录，让门口把话说清楚。 */
export async function fetchSessionStatus(): Promise<SessionStatus> {
  const res = await fetch(`${apiBase()}/v1/auth/session`, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) return { authenticated: false, password_login: false };
  return (await res.json()) as SessionStatus;
}

/** 登录成功返回 true；密码错返回 false；被限速则抛出带秒数的错误。 */
export async function login(password: string): Promise<boolean> {
  const res = await fetch(`${apiBase()}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ password }),
  });
  if (res.ok) return true;
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new Error(retry ? `尝试太频繁，${retry} 秒后再试` : "尝试太频繁，稍后再试");
  }
  if (res.status === 404) throw new Error("这台服务端没有开启密码登录");
  return false;
}

export async function logout(): Promise<void> {
  await fetch(`${apiBase()}/v1/auth/logout`, {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => undefined);
  clearToken();
}

export function createApi(source: DataSource): UaApi {
  // import.meta.env.DEV 在生产构建里是常量 false：这一支连同 mock 模块一起被摇掉
  if (import.meta.env.DEV && source === "mock") return createMockApi();
  return createLiveApi({
    base: import.meta.env.VITE_UA_API_BASE ?? "",
    token: readToken(),
  });
}
