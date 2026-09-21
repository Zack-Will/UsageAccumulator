/**
 * `GET /v1/summary` 客户端。菜单栏只打这一个端点（CONTRACT.md §2.2）。
 * 响应是外部数据：全字段逐个校验，坏字段降级而不是抛到上层崩掉。
 * 错误按契约 §2 的 `error.code` 分类，不只看 HTTP 状态码。
 */
import type { Summary, SummaryWindow, SoonestExhaust, UaErrorCode } from "./types.cjs";
import { log, errText } from "./log.cjs";

export const REQUEST_TIMEOUT_MS = 10_000;

/** 契约 §2 定义的 5 个 code */
const CONTRACT_CODES = new Set<string>([
  "bad_request",
  "unauthorized",
  "machine_revoked",
  "rate_limited",
  "internal",
]);

/** 每个 code 对应一句克制的中文，UI 直接用；不回显服务端自由文本 */
const CODE_TEXT: Record<UaErrorCode, string> = {
  bad_request: "请求被拒绝",
  unauthorized: "凭证失效",
  machine_revoked: "机器已吊销",
  rate_limited: "被限流",
  internal: "服务端故障",
  config: "未配置",
  network: "无法连接",
  timeout: "请求超时",
  bad_response: "响应无法解析",
  unknown: "未知错误",
};

export class SummaryError extends Error {
  readonly code: UaErrorCode;
  constructor(code: UaErrorCode, message?: string) {
    super(message ?? CODE_TEXT[code]);
    this.name = "SummaryError";
    this.code = code;
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 已知窗口的固定次序：服务端换了顺序也不让面板里的行跳来跳去。 */
const KIND_RANK: Record<string, number> = { five_hour: 0, seven_day: 1 };

function rankOf(kind: string): number {
  const r = KIND_RANK[kind];
  return r === undefined ? 2 : r;
}

function parseWindow(raw: unknown): SummaryWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r["label"] === "string" ? r["label"] : "";
  const kind = typeof r["window_kind"] === "string" ? r["window_kind"] : "";
  // label 缺失时退回 window_kind，两个都没有才丢弃
  if (!label && !kind) return null;
  const pct = num(r["pct"], 0);
  return {
    window_kind: kind,
    label: label || kind,
    pct,
    // projected 缺失时退化为 pct（宁可低估也不要 NaN 进渲染层）
    projected_pct: num(r["projected_pct"], pct),
    resets_at: typeof r["resets_at"] === "string" ? r["resets_at"] : "",
    exhaust_eta: isoOrNull(r["exhaust_eta"]),
  };
}

function parseSoonest(raw: unknown): SoonestExhaust | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const eta = isoOrNull(r["eta"]);
  if (!eta) return null;
  return { window_kind: typeof r["window_kind"] === "string" ? r["window_kind"] : "", eta };
}

export function parseSummary(raw: unknown): Summary {
  if (typeof raw !== "object" || raw === null) {
    throw new SummaryError("bad_response", "响应不是对象");
  }
  const r = raw as Record<string, unknown>;
  const windowsRaw = Array.isArray(r["windows"]) ? r["windows"] : [];
  const windows = windowsRaw
    .map(parseWindow)
    .filter((w): w is SummaryWindow => w !== null)
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rankOf(a.w.window_kind) - rankOf(b.w.window_kind) || a.i - b.i)
    .map(({ w }) => w);

  const dashboardRaw = typeof r["dashboard_url"] === "string" ? r["dashboard_url"] : "";
  return {
    profile_id: typeof r["profile_id"] === "string" ? r["profile_id"] : "",
    tray_title_pct: typeof r["tray_title_pct"] === "string" ? r["tray_title_pct"] : "",
    windows,
    soonest_exhaust: parseSoonest(r["soonest_exhaust"]),
    captured_at: isoOrNull(r["captured_at"]),
    stale: r["stale"] === true,
    rate_pct_per_min: num(r["rate_pct_per_min"], 0),
    // 这个 URL 会被丢进 shell.openExternal，协议必须先验；非 http(s) 一律丢弃
    dashboard_url: isHttpUrl(dashboardRaw) ? dashboardRaw : "",
  };
}

/** 从 `{"error":{"code","message"}}` 里取码；取不到就按状态码兜底（契约 §2 的表）。 */
export function classifyError(status: number, body: unknown): UaErrorCode {
  if (typeof body === "object" && body !== null) {
    const err = (body as Record<string, unknown>)["error"];
    if (typeof err === "object" && err !== null) {
      const code = (err as Record<string, unknown>)["code"];
      if (typeof code === "string" && CONTRACT_CODES.has(code)) return code as UaErrorCode;
    }
  }
  if (status === 400) return "bad_request";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal";
  // 其余 4xx 按契约一律当「永不接受」处理
  return status >= 400 ? "bad_request" : "internal";
}

export interface FetchArgs {
  serverUrl: string;
  token: string;
  profileId: string;
  signal?: AbortSignal;
}

export async function fetchSummary(args: FetchArgs): Promise<Summary> {
  const { serverUrl, token, profileId } = args;
  if (!serverUrl) throw new SummaryError("config", "未配置服务器地址");
  if (!isHttpUrl(serverUrl)) throw new SummaryError("config", "服务器地址无效");

  const url = new URL(`${serverUrl.replace(/\/+$/, "")}/v1/summary`);
  if (profileId) url.searchParams.set("profile_id", profileId);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => ac.abort();
  args.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: ac.signal,
      redirect: "error",
    });
  } catch (err) {
    if (ac.signal.aborted) throw new SummaryError("timeout");
    throw new SummaryError("network", errText(err));
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onOuterAbort);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const code = classifyError(res.status, body);
    // 服务端的自由文本只进日志（log.warn 内部会 redact），不进 UI
    const detail = serverMessage(body);
    log.warn(`summary ${res.status} ${code}${detail ? `: ${detail}` : ""}`);
    throw new SummaryError(code);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SummaryError("bad_response", "响应不是 JSON");
  }
  return parseSummary(body);
}

function serverMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const err = (body as Record<string, unknown>)["error"];
  if (typeof err !== "object" || err === null) return "";
  const msg = (err as Record<string, unknown>)["message"];
  return typeof msg === "string" ? msg.slice(0, 200) : "";
}
