import { createLiveApi } from "./live";
import { createMockApi } from "./mock";
import type { UaApi } from "./types";

export * from "./types";
export { ApiError, type ApiErrorCode } from "./live";
export { MOCK_PROFILES, MOCK_MACHINES } from "./mock";

export type DataSource = "mock" | "live";

const LS_KEY = "ua.source";

/**
 * 数据源解析优先级（服务端未就绪，默认 mock）：
 *   1. URL 查询参数 ?source=mock|live      —— 临时试，不落盘
 *   2. localStorage "ua.source"            —— 顶栏开关写入，刷新后保持
 *   3. 构建期环境变量 VITE_UA_DATA_SOURCE  —— .env / CI
 *   4. "mock"
 */
export function resolveDataSource(): DataSource {
  const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("source");
  if (fromUrl === "mock" || fromUrl === "live") return fromUrl;
  try {
    const stored = globalThis.localStorage?.getItem(LS_KEY);
    if (stored === "mock" || stored === "live") return stored;
  } catch {
    /* 隐私模式下 localStorage 可能抛错 */
  }
  const fromEnv = import.meta.env.VITE_UA_DATA_SOURCE;
  if (fromEnv === "mock" || fromEnv === "live") return fromEnv;
  return "mock";
}

export function persistDataSource(source: DataSource): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, source);
  } catch {
    /* 忽略 */
  }
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

export function createApi(source: DataSource): UaApi {
  if (source === "live") {
    return createLiveApi({
      base: import.meta.env.VITE_UA_API_BASE ?? "",
      token: readToken(),
    });
  }
  return createMockApi();
}
