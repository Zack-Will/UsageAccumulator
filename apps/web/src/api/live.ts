import type {
  Calibration,
  Distribution,
  QuotaHistory,
  QuotaSessionStatus,
  MachinesResponse,
  ProfilesResponse,
  StreamEvent,
  Timeline,
  UaApi,
  WindowsCurrent,
} from "./types";

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

/** CONTRACT §2 的 error.code 取值。 */
export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "machine_revoked"
  | "not_found"
  | "rate_limited"
  | "upstream"
  | "internal"
  | "http_error";

export class ApiError extends Error {
  readonly code: ApiErrorCode | string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function joinUrl(base: string, path: string, query?: Record<string, string>): string {
  const url = new URL(
    base ? `${base.replace(/\/$/, "")}${path}` : path,
    base ? undefined : globalThis.location?.origin,
  );
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * CONTRACT §2：Base `/v1`。认证两条路：
 *   · 同源部署（生产就是这样，看板由服务端 @fastify/static 托管）→ 会话 Cookie
 *   · 跨源 / 脚本 → Authorization: Bearer <token>
 */
export function createLiveApi(opts: { base: string; token?: string | undefined }): UaApi {
  const base = opts.base;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  async function get<T>(path: string, query?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return send<T>("GET", path, query, undefined, signal);
  }

  async function send<T>(
    method: "GET" | "PUT" | "DELETE",
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(joinUrl(base, path, query), {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? null,
      // ★ "same-origin" 而不是 "include"：同源时带上会话 Cookie，跨源时自动退化成
      // 不带凭据 —— 于是不会触发带凭据的 CORS 模式（那会强制要求服务端回
      // Access-Control-Allow-Credentials: true 且 Allow-Origin 不得为 *，
      // 所有跨源请求在预检就被浏览器挡下；实际踩过：看板连真服务端时整页空白，
      // 而 fastify .inject() 的契约检查完全绕过 CORS，测不出来）。
      // 跨源那条路仍然靠 Authorization: Bearer。
      credentials: "same-origin",
    });
    if (!res.ok) {
      // CONTRACT §2：错误统一 {"error": {"code","message"}}，客户端看 code 不看状态码
      let code = "http_error";
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as ApiErrorBody;
        if (body.error?.code) code = body.error.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        /* 非 JSON 错误体，保留状态行 */
      }
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  return {
    kind: "live",
    profiles: async (signal) =>
      (await get<ProfilesResponse>("/v1/profiles", undefined, signal)).profiles,
    machines: async (signal) =>
      (await get<MachinesResponse>("/v1/machines", undefined, signal)).machines,
    windowsCurrent: (profileId, signal) =>
      get<WindowsCurrent>("/v1/windows/current", { profile_id: profileId }, signal),
    timeline: (p, signal) =>
      get<Timeline>("/v1/timeline", { profile_id: p.profile_id, from: p.from, to: p.to }, signal),
    distribution: (p, signal) => {
      const query: Record<string, string> = {
        profile_id: p.profile_id,
        from: p.from,
        to: p.to,
        by: p.by,
      };
      // bucket 缺省 none，不必显式带上
      if (p.bucket && p.bucket !== "none") query["bucket"] = p.bucket;
      return get<Distribution>("/v1/distribution", query, signal);
    },
    calibration: (profileId, signal) =>
      get<Calibration>("/v1/calibration", { profile_id: profileId }, signal),
    quotaHistory: (p, signal) => get<QuotaHistory>("/v1/quota/history", { ...p }, signal),
    quotaSession: (profileId, signal) =>
      get<QuotaSessionStatus>("/v1/quota/session", { profile_id: profileId }, signal),
    saveQuotaSession: (profileId, sessionKey) =>
      send<QuotaSessionStatus>("PUT", "/v1/quota/session", undefined, {
        profile_id: profileId,
        session_key: sessionKey,
      }),
    clearQuotaSession: (profileId) =>
      send<QuotaSessionStatus>("DELETE", "/v1/quota/session", { profile_id: profileId }),
    stream(profileId, handlers) {
      handlers.onStatus("connecting");
      const src = new EventSource(joinUrl(base, "/v1/stream", { profile_id: profileId }), {
        // ★ EventSource 不能自定义请求头，所以 SSE **没有**办法带 Bearer token。
        // 在会话 Cookie 之前这条路在生产环境其实一直是 401 的（服务端从未从
        // query string 读过 token，那句「两种都接受」的旧注释是错的），
        // 看板只能靠首屏那一次 /v1/windows/current，拿不到推送。
        // withCredentials=false 时凭据模式是 same-origin：同源照样带 Cookie，
        // 跨源不带 —— 正是我们要的，跨源 SSE 也不会被 CORS 挡掉。
        withCredentials: false,
      });
      const relay = (type: StreamEvent["type"]) => (ev: MessageEvent<string>) => {
        try {
          handlers.onEvent({ type, data: JSON.parse(ev.data) } as StreamEvent);
        } catch {
          /* 坏帧丢弃，不打断连接 */
        }
      };
      src.addEventListener("window_update", relay("window_update") as EventListener);
      src.addEventListener("event_batch", relay("event_batch") as EventListener);
      // ping 是心跳，收到就当连接还活着
      src.addEventListener("ping", (() => handlers.onStatus("open")) as EventListener);
      src.onopen = () => handlers.onStatus("open");
      // EventSource 自带重连；readyState=CLOSED 才是真的断了。
      src.onerror = () => handlers.onStatus(src.readyState === 2 ? "closed" : "connecting");
      return () => {
        src.close();
        handlers.onStatus("closed");
      };
    },
  };
}
