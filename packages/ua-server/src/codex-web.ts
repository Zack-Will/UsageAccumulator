/**
 * 服务端直接读 Codex 额度：chatgpt.com/backend-api/wham/usage（与 Codex CLI 同一个接口）。
 *
 * ★ 凭证是一份**专供服务端**的 ChatGPT 登录（另开一个 CODEX_HOME 登录得到的 auth.json）。
 *   OpenAI 的 refresh token 是一次性的：用过一次就作废，换回一个新的。和本机 Codex CLI
 *   共用同一份，谁后刷新谁被踢下线 —— 所以绝不能把日常用的 ~/.codex/auth.json 交给服务端。
 * ★ 轮换节奏照 Codex 自己：access token 用到约 7 天或被拒才刷新，不是每轮都刷。
 *   新的 refresh token 必须**先落盘再使用**：拿到新 token 后进程崩了，旧的已经作废，链条就断了。
 * ★ 任何错误信息都不带 token 与上游响应正文。
 */
import type { CodexQuotaSnapshot, CodexResetCredits } from "@ua/core";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_BACKEND_BASE = "https://chatgpt.com/backend-api";
/** Codex 自己 8 天刷新一次；留一天余量 */
export const CODEX_ACCESS_MAX_AGE_MS = 7 * 24 * 3600_000;

/** 保管在 0600 文件里的全部内容。只有 refresh_token 是必需的 */
export interface CodexCredential {
  refresh_token: string;
  access_token: string | null;
  id_token: string | null;
  /** access token 是什么时候换来的；null = 不知道，下一轮先刷新 */
  refreshed_at: string | null;
}

export interface CodexIdentity {
  email: string | null;
  account_id: string | null;
  plan_type: string | null;
}

/**
 * expired / reused / revoked：refresh token 已经不能用，要重新登录；
 * rejected：access token 被拒且刷新也救不回来；challenge：被 Cloudflare 质询，换 token 也没用。
 */
export type CodexAuthReason = "expired" | "reused" | "revoked" | "rejected" | "challenge";

export class CodexAuthError extends Error {
  constructor(readonly reason: CodexAuthReason, readonly status: number | null = null) {
    super(AUTH_MESSAGE[reason]);
    this.name = "CodexAuthError";
  }
}

const AUTH_MESSAGE: Record<CodexAuthReason, string> = {
  expired: "refresh token 已过期，需要重新登录一份",
  reused: "refresh token 已被用过（可能还在别处用着这份登录），需要重新登录一份",
  revoked: "refresh token 已被吊销，需要重新登录一份",
  rejected: "ChatGPT 不认这份登录",
  challenge: "被 Cloudflare 拦下，换 token 也没用",
};

export type CodexFetch = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; contentType: string; text: string }>;

export const codexFetch: CodexFetch = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
};

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * 看板里粘贴的内容：整份 auth.json（推荐，连 access token 一起带上，第一轮不必刷新），
 * 或者只有 refresh token 本身。
 */
export function parseCodexCredentialInput(input: string): CodexCredential {
  const text = input.trim();
  if (text.startsWith("{")) {
    let doc: Obj | null;
    try {
      doc = object(JSON.parse(text));
    } catch {
      throw new Error("不是合法的 JSON");
    }
    const tokens = object(doc?.["tokens"]);
    const refresh = str(tokens?.["refresh_token"]);
    if (!refresh) throw new Error("auth.json 里没有 tokens.refresh_token —— 要用 ChatGPT 登录得到的那种，不是 API key");
    const lastRefresh = str(doc?.["last_refresh"]);
    return {
      refresh_token: refresh,
      access_token: str(tokens?.["access_token"]),
      id_token: str(tokens?.["id_token"]),
      refreshed_at: lastRefresh && Number.isFinite(Date.parse(lastRefresh)) ? new Date(lastRefresh).toISOString() : null,
    };
  }
  if (!/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(text)) throw new Error("看起来不是 refresh token，也不是 auth.json");
  return { refresh_token: text, access_token: null, id_token: null, refreshed_at: null };
}

function jwtClaims(token: string | null): Obj | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    return object(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/** id_token（或 access token）里的账号信息：邮箱、ChatGPT 账号 id、套餐 */
export function codexIdentity(cred: Pick<CodexCredential, "id_token" | "access_token">): CodexIdentity {
  const out: CodexIdentity = { email: null, account_id: null, plan_type: null };
  for (const token of [cred.id_token, cred.access_token]) {
    const c = jwtClaims(token);
    if (!c) continue;
    const auth = object(c["https://api.openai.com/auth"]);
    const profile = object(c["https://api.openai.com/profile"]);
    out.email ??= str(c["email"]) ?? str(profile?.["email"]);
    out.account_id ??= str(auth?.["chatgpt_account_id"]);
    out.plan_type ??= str(auth?.["chatgpt_plan_type"]);
  }
  if (out.email) out.email = out.email.trim().toLowerCase();
  return out;
}

/** access token 是否该换了：从没换过、换了快 7 天、或者 JWT 自己说快过期了 */
export function codexAccessStale(cred: CodexCredential, now: Date): boolean {
  if (!cred.access_token || !cred.refreshed_at) return true;
  if (now.getTime() - Date.parse(cred.refreshed_at) > CODEX_ACCESS_MAX_AGE_MS) return true;
  const exp = jwtClaims(cred.access_token)?.["exp"];
  return typeof exp === "number" && exp * 1000 - now.getTime() < 10 * 60_000;
}

function isChallenge(r: { status: number; contentType: string }): boolean {
  return (r.status === 403 || r.status === 503) && r.contentType.includes("text/html");
}

/** 用 refresh token 换一套新 token。返回值里的 refresh_token 必须先落盘再用 access token */
export async function refreshCodexCredential(cred: CodexCredential, http: CodexFetch, now: Date): Promise<CodexCredential> {
  const res = await http(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: cred.refresh_token }),
  });
  if (isChallenge(res)) throw new CodexAuthError("challenge", res.status);
  if (res.status < 200 || res.status >= 300) {
    let code: string | null = null;
    try {
      const body = object(JSON.parse(res.text));
      code = str(body?.["error"]) ?? str(object(body?.["error"])?.["code"]) ?? str(body?.["code"]);
    } catch {
      /* 非 JSON：只看状态码 */
    }
    const c = code?.toLowerCase() ?? "";
    if (c === "refresh_token_expired") throw new CodexAuthError("expired", res.status);
    if (c === "refresh_token_reused") throw new CodexAuthError("reused", res.status);
    if (c === "refresh_token_invalidated") throw new CodexAuthError("revoked", res.status);
    if (res.status === 401 || c === "invalid_grant") throw new CodexAuthError("rejected", res.status);
    throw new Error(`刷新 token 失败：HTTP ${res.status}`);
  }
  const body = object(JSON.parse(res.text));
  const access = str(body?.["access_token"]);
  if (!access) throw new Error("刷新 token 的响应里没有 access_token");
  return {
    // 没回新的 refresh token 时旧的仍有效（Codex 也是这样处理的）
    refresh_token: str(body?.["refresh_token"]) ?? cred.refresh_token,
    access_token: access,
    id_token: str(body?.["id_token"]) ?? cred.id_token,
    refreshed_at: now.toISOString(),
  };
}

function backendHeaders(cred: CodexCredential, accountId: string | null): Record<string, string> {
  return {
    Authorization: `Bearer ${cred.access_token ?? ""}`,
    Accept: "application/json",
    "User-Agent": "codex-cli",
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };
}

/** GET /wham/usage 的原始 JSON。401 抛 rejected，调用方可以刷新一次再试 */
export async function fetchCodexUsage(cred: CodexCredential, accountId: string | null, http: CodexFetch): Promise<Obj> {
  const res = await http(`${CODEX_BACKEND_BASE}/wham/usage`, { method: "GET", headers: backendHeaders(cred, accountId) });
  if (isChallenge(res)) throw new CodexAuthError("challenge", res.status);
  if (res.status === 401 || res.status === 403) throw new CodexAuthError("rejected", res.status);
  if (res.status < 200 || res.status >= 300) throw new Error(`读取 Codex 额度失败：HTTP ${res.status}`);
  const body = object(JSON.parse(res.text));
  if (!body) throw new Error("Codex 额度响应不是对象");
  return body;
}

/** 重置券详情。读不到不算失败：额度照样记，券只剩 /wham/usage 里的数量 */
export async function fetchCodexResetCredits(cred: CodexCredential, accountId: string | null, http: CodexFetch): Promise<Obj | null> {
  try {
    const res = await http(`${CODEX_BACKEND_BASE}/wham/rate-limit-reset-credits`, {
      method: "GET",
      headers: backendHeaders(cred, accountId),
    });
    if (res.status < 200 || res.status >= 300) return null;
    return object(JSON.parse(res.text));
  } catch {
    return null;
  }
}

const iso = (seconds: unknown): string | null =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
const isoString = (v: unknown): string | null => {
  const s = str(v);
  return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
};

/**
 * /wham/usage → 与探针同形的快照。window_id 与探针一致（`<limit_id>:<slot>`），
 * 两条来源的样本落在同一条历史上，不会分叉成两个窗口。
 */
export function normalizeWhamUsage(
  usage: Obj,
  creditDetails: Obj | null,
  capturedAt: Date,
): { snapshot: CodexQuotaSnapshot; plan_type: string | null; account_id: string | null } {
  const plan = str(usage["plan_type"]);
  const snapshot: CodexQuotaSnapshot = { captured_at: capturedAt.toISOString(), windows: [], limits: [] };
  const credits = object(usage["credits"]);
  const reachedType = str(object(usage["rate_limit_reached_type"])?.["type"]);

  const addLimit = (limitId: string, label: string | null, rateLimit: Obj | null, reached: string | null) => {
    snapshot.limits.push({
      limit_id: limitId,
      plan_type: plan,
      credits:
        limitId === "codex" && credits && typeof credits["has_credits"] === "boolean" && typeof credits["unlimited"] === "boolean"
          ? {
              has_credits: credits["has_credits"] as boolean,
              unlimited: credits["unlimited"] as boolean,
              balance: typeof credits["balance"] === "string" && /^-?\d+(?:\.\d+)?$/.test(credits["balance"]) ? credits["balance"] : null,
            }
          : null,
      limit_reached: reached ?? (rateLimit?.["limit_reached"] === true ? "rate_limit_reached" : null),
    });
    for (const slot of ["primary", "secondary"] as const) {
      const w = object(rateLimit?.[`${slot}_window`]);
      if (!w) continue;
      const used = w["used_percent"];
      if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) throw new Error("Codex 额度窗口的 used_percent 不合法");
      const seconds = w["limit_window_seconds"];
      snapshot.windows.push({
        window_id: `${encodeURIComponent(limitId)}:${slot}`,
        limit_id: limitId,
        slot,
        label,
        used_percent: used,
        duration_minutes: typeof seconds === "number" && seconds > 0 ? Math.ceil(seconds / 60) : null,
        resets_at: iso(w["reset_at"]),
      });
    }
  };

  addLimit("codex", null, object(usage["rate_limit"]), reachedType);
  const extra = Array.isArray(usage["additional_rate_limits"]) ? usage["additional_rate_limits"] : [];
  for (const raw of extra.slice(0, 50)) {
    const l = object(raw);
    const id = str(l?.["metered_feature"]);
    if (!l || !id) continue;
    addLimit(id, str(l["limit_name"]), object(l["rate_limit"]), null);
  }

  const summary = object(usage["rate_limit_reset_credits"]);
  const detailCount = creditDetails?.["available_count"];
  const count = typeof detailCount === "number" ? detailCount : summary?.["available_count"];
  if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
    const list = Array.isArray(creditDetails?.["credits"]) ? (creditDetails!["credits"] as unknown[]) : null;
    const resetCredits: CodexResetCredits = {
      available_count: count,
      credits: list
        ? list.slice(0, 200).flatMap((raw) => {
            const c = object(raw);
            const granted = isoString(c?.["granted_at"]);
            const type = str(c?.["reset_type"]);
            const status = str(c?.["status"]);
            if (!c || !granted || !type || !status) return [];
            return [{ reset_type: type.slice(0, 256), status: status.slice(0, 256), granted_at: granted,
              expires_at: isoString(c["expires_at"]), title: str(c["title"])?.slice(0, 256) ?? null }];
          })
        : null,
    };
    snapshot.reset_credits = resetCredits;
  }
  return { snapshot, plan_type: plan, account_id: str(usage["account_id"]) };
}
