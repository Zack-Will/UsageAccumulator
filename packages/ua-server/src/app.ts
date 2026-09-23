import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { Logger } from "pino";
import type { ClaudeWebClient, PricingTable, QuotaSnapshot } from "@ua/core";
import { EMPTY_PRICING, QuotaAuthError } from "@ua/core";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";
import { EventBus, formatSse } from "./bus.js";
import { eventCostUsd } from "./pricing.js";
import {
  buildDistribution,
  buildTimelineLanes,
  computeWindowMetrics,
  inferWindowMs,
  ratioToPct,
} from "./aggregate.js";
import type { DistributionBy, SeriesBucket } from "./aggregate.js";
import { isScratchWorkspace } from "./aggregate.js";
import { buildSummary, computeCurrentWindows } from "./windows-service.js";
import { decodeEventBatch, enrollWireSchema, quotaSnapshotWireSchema, quotaWireToSnapshot } from "./wire.js";
import type { EventRow, Store } from "./store.js";
import { LoginGuard } from "./login-guard.js";
import { QuotaSampler, type SamplerStatus } from "./quota-sampler.js";
import { isVaultSafeId, type SessionVault } from "./quota-vault.js";
import {
  DEFAULT_SESSION_MS,
  SESSION_COOKIE,
  clearCookie,
  constantTimeEqualsStr,
  mintSession,
  parseCookies,
  requestIsSecure,
  serializeCookie,
  verifySession,
} from "./session.js";

const NDJSON_CONTENT_TYPES = [
  "application/x-ndjson",
  "application/ndjson",
  "application/octet-stream",
  "application/gzip",
  "text/plain",
];

export interface BuildAppOptions {
  store: Store;
  config: Config;
  pricing?: PricingTable;
  logger?: Logger;
  bus?: EventBus;
  /** 测试注入可控时钟 */
  now?: () => Date;
  /**
   * 服务端直接抓额度（ARCHITECTURE §5.3）。不给就不开采样器，
   * /v1/quota/session 报 disabled，额度只能靠探针代抓上报。
   */
  quota?: {
    vault: SessionVault;
    client: Pick<ClaudeWebClient, "orgId" | "snapshot">;
    intervalMs?: number;
    jitterMs?: number;
    authBackoffMs?: number[];
  };
}

export type UaApp = ReturnType<typeof buildApp>;

/**
 * CONTRACT §2 规定的 error.code 取值集合。探针据此决定重试还是丢弃，
 * 所以这里刻意收成一个联合类型 —— 随手新造一个 code 会让探针走「其余 4xx 一律丢弃」分支。
 * 具体原因放 message，不放 code。
 */
type ErrorCode =
  | "bad_request"
  | "unauthorized"
  // 身份合法但无权做这件事（看板的只读身份去调写接口），区别于「凭证不对」的 unauthorized
  | "forbidden"
  | "machine_revoked"
  // 专指路由或资源不存在；不要用 bad_request 代替，看板调试时会误以为是参数错了
  | "not_found"
  | "rate_limited"
  // 服务端去问 claude.ai 时对方出了问题（连不上、被 Cloudflare 质询）。不是我们的 5xx，也不是请求写错了
  | "upstream"
  | "internal";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * 机器的可读名：enroll 时报的 hostname，没有就退回 machine_id。
 * 不做前 8 位截断 —— 截断的 UUID 在看板上既不可读又会撞车，宁可显示全量。
 */
function machineLabel(id: string, hostname: string | null | undefined): string {
  return hostname && hostname.length > 0 ? hostname : id;
}

/** 定长比较，避免把 token 的正确前缀长度泄漏出去。 */
function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const rangeSchema = z.object({
  profile_id: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const quotaHistorySchema = rangeSchema.extend({
  // window_kind 是自由字符串（CONTRACT §1.3），不做枚举约束
  window_kind: z.string().min(1).default("seven_day"),
});

const distributionSchema = rangeSchema.extend({
  by: z.enum(["machine", "model", "project", "hour", "attribution", "session"]).default("machine"),
  bucket: z.enum(["none", "hour", "day"]).default("none"),
});

/**
 * 查询参数校验。
 *
 * 必须走 safeParse —— 直接 .parse() 抛出的 ZodError 没有 statusCode，
 * 会被兜底成 500，而 5xx 在契约里是「服务端故障，指数退避重试」的意思：
 * 一个拼错的 query 参数会让客户端永远重试下去。参数错就是 400。
 */
function parseQuery<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "query";
    throw new HttpError(400, "bad_request", `invalid query parameter "${path}": ${issue?.message ?? "invalid"}`);
  }
  return parsed.data as z.infer<T>;
}

function parseRange(
  q: z.infer<typeof rangeSchema>,
  now: Date,
  defaultSpanMs: number,
): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaultSpanMs);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new HttpError(400, "bad_request", "from/to must be RFC3339 timestamps");
  }
  if (from >= to) throw new HttpError(400, "bad_request", "from must be before to");
  return { from, to };
}

export function buildApp(opts: BuildAppOptions) {
  const { store, config } = opts;
  const pricing = opts.pricing ?? EMPTY_PRICING;
  const log = opts.logger ?? createLogger(config.logLevel);
  const bus = opts.bus ?? new EventBus();
  const now = opts.now ?? (() => new Date());

  const app = Fastify({
    loggerInstance: log,
    bodyLimit: config.maxIngestBytes,
  });

  // gzip NDJSON 原样收进来，解压与解析都在 wire.ts 的纯函数里做
  app.addContentTypeParser(
    NDJSON_CONTENT_TYPES,
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  void app.register(cors, { origin: true });

  // 看板构建产物与 API 同源托管（ARCHITECTURE §3）。
  // 同源是刻意的：跨源时 EventSource 无法带自定义头，SSE 的 token 只能塞进
  // query string 并进访问日志；同源则 /v1 与页面共用一个 origin，CORS 与该问题一起消失。
  // 产物里不含任何 token —— 看板在浏览器本地输入并存 localStorage。
  if (config.webDir) {
    if (existsSync(config.webDir)) {
      void app.register(fastifyStatic, { root: config.webDir, prefix: "/", index: ["index.html"] });
      log.info({ webDir: config.webDir }, "serving dashboard");
    } else {
      log.warn({ webDir: config.webDir }, "UA_WEB_DIR 不存在，跳过静态托管");
    }
  }

  app.setErrorHandler((err: FastifyError | HttpError, _req, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      void reply.status(err.status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    const status = typeof (err as FastifyError).statusCode === "number"
      ? (err as FastifyError).statusCode!
      : 500;
    if (status >= 500) log.error({ err }, "unhandled error");
    void reply
      .status(status)
      .send({
        error: {
          code: status >= 500 ? "internal" : "bad_request",
          // 5xx 不回显内部细节
          message: status >= 500 ? "internal error" : err.message,
        },
      });
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: { code: "not_found", message: "no such route" } });
  });

  /** 额度快照入库并立即推给看板。探针上报与服务端自采走同一条路。 */
  async function recordQuota(snapshot: QuotaSnapshot, machineId: string | null): Promise<void> {
    await store.insertQuotaSnapshot(snapshot, machineId);
    const current = await computeCurrentWindows(store, snapshot.profileId, {
      now: now(),
      quotaStaleMs: config.quotaStaleMs,
    });
    bus.publish({ name: "window_update", profileId: snapshot.profileId, data: current });
  }

  const sampler = opts.quota
    ? new QuotaSampler({
        vault: opts.quota.vault,
        client: opts.quota.client,
        // machine_id 留空 = 服务端自己抓的（探针上报的带着上报机器的 id）
        record: (snap) => recordQuota(snap, null),
        log,
        now,
        ...(opts.quota.intervalMs !== undefined ? { intervalMs: opts.quota.intervalMs } : {}),
        ...(opts.quota.jitterMs !== undefined ? { jitterMs: opts.quota.jitterMs } : {}),
        ...(opts.quota.authBackoffMs !== undefined ? { authBackoffMs: opts.quota.authBackoffMs } : {}),
      })
    : null;

  // ── 鉴权：会话 Cookie（浏览器）、Bearer machine_token（探针）、单一看板 token（脚本）
  async function authenticate(req: FastifyRequest): Promise<void> {
    // 浏览器优先走 Cookie。它比 localStorage 里的 token 抗 XSS（HttpOnly），
    // 而且 SSE 不用再把凭证塞进 query string。
    if (config.dashboardPassword) {
      const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (verifySession(cookie, config.dashboardPassword, now().getTime())) {
        (req as FastifyRequest & { auth?: unknown }).auth = { kind: "dashboard" };
        return;
      }
    }

    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m?.[1]) throw new HttpError(401, "unauthorized", "missing credentials");
    const token = m[1].trim();

    if (config.dashboardToken && constantTimeEquals(token, config.dashboardToken)) {
      (req as FastifyRequest & { auth?: unknown }).auth = { kind: "dashboard" };
      return;
    }
    const machine = await store.findMachineByTokenSha256(sha256(token));
    // 未 enroll 就上报 → 401（CONTRACT §2.3）
    if (!machine) throw new HttpError(401, "unauthorized", "unknown machine token");
    // 吊销与「token 本来就不对」必须分开：前者要提示重新 enroll，后者可能只是配置错了
    if (machine.revokedAt !== null) {
      throw new HttpError(403, "machine_revoked", "this machine has been revoked");
    }
    (req as FastifyRequest & { auth?: unknown }).auth = { kind: "machine", id: machine.id };
    void store.touchMachine(machine.id).catch(() => {});
  }

  const PUBLIC_PATHS = new Set([
    "/healthz",
    "/v1/enroll",
    // 登录三兄弟必须公开，否则没有任何办法拿到第一张 Cookie
    "/v1/auth/login",
    "/v1/auth/logout",
    "/v1/auth/session",
  ]);
  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0] ?? "";
    if (PUBLIC_PATHS.has(path)) return;
    if (!path.startsWith("/v1/")) return;
    await authenticate(req);
  });

  async function resolveProfileId(raw: string | undefined): Promise<string> {
    if (raw && raw.length > 0) return raw;
    const profiles = await store.listProfiles();
    if (profiles.length === 1) return profiles[0]!.id;
    throw new HttpError(400, "bad_request", "profile_id is required");
  }

  // ── GET /healthz
  // ── 看板登录（密码 → 会话 Cookie）────────────────────────────────────────
  //
  // ★ 密码是「记得住」的，熵比随机 token 低得多，所以限速不是可选项。
  //   两道闸：按来源一道（正常人不会连错十次），全局一道（挡住伪造 XFF 换桶）。
  const loginGuard = new LoginGuard();
  const globalLoginGuard = new LoginGuard({ baseDelayMs: 500, maxDelayMs: 30_000 });

  /** 反代终止 TLS，所以协议要看 X-Forwarded-Proto；判不出来时按 https 算（见 session.ts）。 */
  function isSecure(req: FastifyRequest): boolean {
    return requestIsSecure({
      forwardedProto: req.headers["x-forwarded-proto"],
      protocol: req.protocol,
      host: req.headers.host,
    });
  }

  /**
   * 限速分桶的来源标识。
   * XFF 可伪造，所以它只用来「让正常用户不被别人连累」，真正的兜底是全局那道闸。
   */
  function loginSource(req: FastifyRequest): string {
    const xf = req.headers["x-forwarded-for"];
    const raw = Array.isArray(xf) ? xf[0] : xf;
    return (raw?.split(",")[0] ?? "").trim() || req.ip || "unknown";
  }

  const loginSchema = z.object({ password: z.string().min(1).max(512) });

  app.post("/v1/auth/login", async (req, reply) => {
    if (!config.dashboardPassword) {
      throw new HttpError(404, "not_found", "password login is not enabled on this server");
    }
    const nowMs = now().getTime();
    const src = loginSource(req);
    for (const [guard, key] of [
      [loginGuard, src],
      [globalLoginGuard, "global"],
    ] as const) {
      const v = guard.check(key, nowMs);
      if (!v.allowed) {
        void reply.header("retry-after", String(v.retryAfterSec));
        throw new HttpError(429, "rate_limited", `too many attempts, retry in ${v.retryAfterSec}s`);
      }
    }

    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, "bad_request", "password is required");

    if (!constantTimeEqualsStr(parsed.data.password, config.dashboardPassword)) {
      loginGuard.fail(src, nowMs);
      globalLoginGuard.fail("global", nowMs);
      // 失败原因不细分：说「密码错了」和说「没这个用户」一样，只会帮到猜的人
      throw new HttpError(401, "unauthorized", "invalid password");
    }
    loginGuard.succeed(src);
    globalLoginGuard.succeed("global");

    const ttlMs = config.sessionTtlMs || DEFAULT_SESSION_MS;
    const cookie = serializeCookie(
      SESSION_COOKIE,
      mintSession(config.dashboardPassword, nowMs + ttlMs),
      { maxAgeSec: Math.floor(ttlMs / 1000), secure: isSecure(req) },
    );
    return reply.header("set-cookie", cookie).send({ authenticated: true, expires_in: Math.floor(ttlMs / 1000) });
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    return reply
      .header("set-cookie", clearCookie(SESSION_COOKIE, isSecure(req)))
      .send({ authenticated: false });
  });

  /** 前端开屏问一句：我还登着吗？决定显示看板还是登录框。 */
  app.get("/v1/auth/session", async (req, reply) => {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const authenticated =
      !!config.dashboardPassword && verifySession(cookie, config.dashboardPassword, now().getTime());
    return reply.send({
      authenticated,
      /** false 时前端该退回 token 输入框 —— 这台服务端没配密码 */
      password_login: !!config.dashboardPassword,
    });
  });

  app.get("/healthz", async (_req, reply) => {
    const ok = await store.ping().catch(() => false);
    if (!ok) throw new HttpError(503, "internal", "database unavailable");
    return reply.type("text/plain").send("ok");
  });

  // ── POST /v1/enroll  → { machine_id, machine_token }
  app.post("/v1/enroll", async (req, reply) => {
    const parsed = enrollWireSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "bad_request", "invalid enroll payload");
    if (!config.enrollToken) throw new HttpError(503, "internal", "enrollment is not configured");
    if (!constantTimeEquals(parsed.data.enroll_token, config.enrollToken)) {
      throw new HttpError(401, "unauthorized", "invalid enroll token");
    }
    // ★ 服务端是权威（CONTRACT §2.3）：id 由这里生成，探针提交的 provisional 只留作追溯。
    // 直接采用客户端给的 id 等于让机器自己挑身份，拿到 enroll token 的人就能冒充已有机器。
    const machineId = randomUUID();
    const machineToken = randomBytes(32).toString("hex");
    await store.createMachine({
      id: machineId,
      provisionalMachineId: parsed.data.provisional_machine_id ?? null,
      hostname: parsed.data.hostname,
      os: parsed.data.os,
      tokenSha256: sha256(machineToken),
    });
    // machine_token 只在这一次返回，服务端只留 sha256
    log.info(
      {
        machine_id: machineId,
        provisional_machine_id: parsed.data.provisional_machine_id ?? null,
        os: parsed.data.os,
      },
      "machine enrolled",
    );
    return reply.send({ machine_id: machineId, machine_token: machineToken });
  });

  // ── POST /v1/ingest/events  （gzip NDJSON）
  app.post("/v1/ingest/events", async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      throw new HttpError(415, "bad_request", "body must be (gzip) NDJSON");
    }
    let decoded;
    try {
      decoded = decodeEventBatch(body);
    } catch {
      throw new HttpError(400, "bad_request", "could not decode gzip NDJSON body");
    }

    const rows: EventRow[] = decoded.events.map((event) => ({
      event,
      // 缺价返回 null（不是 0）；`<synthetic>` 也强制 null，合成事件不计费
      costUsd: eventCostUsd(event, pricing),
    }));

    await store.ensureProfiles([...new Set(rows.map((r) => r.event.profileId))]);
    const inserted = await store.insertEvents(rows);
    const total = decoded.events.length + decoded.dedupedInBatch;
    const deduped = total - inserted;

    if (inserted > 0) {
      // last_ts = 该 profile 本批最新事件的时间戳，前端据此知道数据推进到哪了
      const byProfile = new Map<string, { count: number; lastTs: number }>();
      for (const r of rows) {
        const cur = byProfile.get(r.event.profileId);
        const t = r.event.ts.getTime();
        if (cur) {
          cur.count++;
          cur.lastTs = Math.max(cur.lastTs, t);
        } else {
          byProfile.set(r.event.profileId, { count: 1, lastTs: t });
        }
      }
      for (const [profileId, agg] of byProfile) {
        bus.publish({
          name: "event_batch",
          profileId,
          data: {
            profile_id: profileId,
            count: agg.count,
            last_ts: new Date(agg.lastTs).toISOString(),
          },
        });
      }
    }

    // 只记数字与维度，绝不记正文（CONTRACT §4）
    req.log.info({ accepted: inserted, deduped, invalid: decoded.invalid }, "ingest events");
    return reply.send({ accepted: inserted, deduped, invalid: decoded.invalid });
  });

  // ── POST /v1/ingest/quota
  // ── POST /v1/ingest/sessions：会话标题（只收标题，不收任何对话正文）
  //
  // 只认探针的 machine token：看板 token / 会话 Cookie 是只读身份，不能往库里写东西。
  // 机器身份取自鉴权，不信 body 里自报的 —— 否则一台机器能改写别的机器的会话名。
  const sessionTitlesSchema = z.object({
    sessions: z
      .array(
        z.object({
          session_id: z.string().min(1).max(200),
          // 桌面端的标题一般十几个字；截断在探针侧做，这里只挡明显异常的输入
          title: z.string().trim().min(1).max(300),
        }),
      )
      .max(2000),
  });

  app.post("/v1/ingest/sessions", async (req, reply) => {
    const auth = (req as FastifyRequest & { auth?: { kind: string; id?: string } }).auth;
    if (auth?.kind !== "machine" || !auth.id) {
      throw new HttpError(403, "forbidden", "only a machine token can report session titles");
    }
    const parsed = sessionTitlesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "bad_request", parsed.error.issues[0]?.message ?? "invalid sessions payload");
    }
    const updated = await store.upsertSessionTitles(
      auth.id,
      parsed.data.sessions.map((x) => ({ sessionId: x.session_id, title: x.title })),
    );
    return reply.send({ ok: true, received: parsed.data.sessions.length, updated });
  });

  app.post("/v1/ingest/quota", async (req, reply) => {
    const parsed = quotaSnapshotWireSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "bad_request", parsed.error.issues[0]?.message ?? "invalid quota payload");
    }
    const snapshot = quotaWireToSnapshot(parsed.data);
    if (!snapshot) throw new HttpError(400, "bad_request", "captured_at must be RFC3339");
    // 采集机器仅供追溯来源（CONTRACT §1.3）。以鉴权身份为准 —— 探针从来不在 body 里带 machine_id，
    // 以前这一列因此全是空的，分不出是谁抓的；现在留空专指「服务端自己抓的」
    const auth = (req as FastifyRequest & { auth?: { kind: string; id?: string } }).auth;
    const machineId = auth?.kind === "machine" && auth.id ? auth.id : (parsed.data.machine_id ?? null);
    await recordQuota(snapshot, machineId);
    return reply.send({ ok: true });
  });

  // ── claude.ai 会话：服务端直接抓额度用（ARCHITECTURE §5.3）──────────────────
  //
  // ★ 只写不读：没有任何接口回显 sessionKey，GET 只给采集状态。
  // ★ 写（PUT / DELETE）只认看板身份；探针的 machine token 不能改会话。
  // ★ 先验再存：claude.ai 不认的会话不落盘，免得把一个好的换成坏的。
  const quotaSessionQuery = z.object({ profile_id: z.string().optional() });
  const quotaSessionBody = z.object({
    profile_id: z.string().optional(),
    session_key: z
      .string()
      .trim()
      .min(16, "sessionKey 太短")
      .max(4096, "sessionKey 太长")
      .regex(/^[\x21-\x7e]+$/, "sessionKey 里不应有空白或非 ASCII 字符"),
  });

  function requireDashboard(req: FastifyRequest): void {
    const auth = (req as FastifyRequest & { auth?: { kind: string } }).auth;
    if (auth?.kind !== "dashboard") {
      throw new HttpError(403, "forbidden", "只有看板身份能更改 claude.ai 会话");
    }
  }

  async function sessionProfile(raw: string | undefined): Promise<string> {
    const profileId = await resolveProfileId(raw);
    if (!isVaultSafeId(profileId)) throw new HttpError(400, "bad_request", "profile_id 含不允许的字符");
    return profileId;
  }

  function sessionDto(s: SamplerStatus) {
    return {
      profile_id: s.profileId,
      state: s.state,
      last_ok_at: s.lastOkAt ? s.lastOkAt.toISOString() : null,
      last_attempt_at: s.lastAttemptAt ? s.lastAttemptAt.toISOString() : null,
      next_attempt_at: s.nextAttemptAt ? s.nextAttemptAt.toISOString() : null,
      error: s.error,
    };
  }

  const disabledStatus = (profileId: string): SamplerStatus => ({
    profileId,
    state: "disabled",
    lastOkAt: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    error: null,
  });

  app.get("/v1/quota/session", async (req, reply) => {
    const q = parseQuery(quotaSessionQuery, req.query);
    const profileId = await sessionProfile(q.profile_id);
    return reply.send(sessionDto(sampler ? await sampler.status(profileId) : disabledStatus(profileId)));
  });

  app.put("/v1/quota/session", async (req, reply) => {
    requireDashboard(req);
    if (!sampler || !opts.quota) throw new HttpError(404, "not_found", "服务端没有开启额度采集");
    const parsed = quotaSessionBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "bad_request", parsed.error.issues[0]?.message ?? "invalid body");
    }
    const profileId = await sessionProfile(parsed.data.profile_id);
    const sessionKey = parsed.data.session_key;
    try {
      await opts.quota.client.orgId(sessionKey);
    } catch (err) {
      if (err instanceof QuotaAuthError && err.reason === "session") {
        throw new HttpError(400, "bad_request", "claude.ai 不认这个 sessionKey");
      }
      if (err instanceof QuotaAuthError) {
        throw new HttpError(502, "upstream", "请求被 claude.ai 前面的 Cloudflare 拦下了");
      }
      throw new HttpError(502, "upstream", `暂时连不上 claude.ai：${(err as Error).message}`);
    }
    await opts.quota.vault.write(profileId, sessionKey);
    log.info({ profileId }, "claude.ai 会话已更新");
    return reply.send(sessionDto(await sampler.kick(profileId)));
  });

  app.delete("/v1/quota/session", async (req, reply) => {
    requireDashboard(req);
    if (!sampler || !opts.quota) throw new HttpError(404, "not_found", "服务端没有开启额度采集");
    const q = parseQuery(quotaSessionQuery, req.query);
    const profileId = await sessionProfile(q.profile_id);
    if (await opts.quota.vault.remove(profileId)) log.info({ profileId }, "claude.ai 会话已删除");
    sampler.forget(profileId);
    return reply.send(sessionDto(await sampler.status(profileId)));
  });

  // ── GET /v1/profiles —— 注意键是 `id`，不是 `profile_id`
  app.get("/v1/profiles", async (_req, reply) => {
    const profiles = await store.listProfiles();
    return reply.send({
      profiles: profiles.map((p) => ({
        id: p.id,
        kind: p.kind,
        label: p.label,
        account_uuid: p.accountUuid,
        base_url: p.baseUrl,
        plan: p.plan,
      })),
    });
  });

  // ── GET /v1/machines —— 甘特图泳道要的可读名就来自这里
  app.get("/v1/machines", async (_req, reply) => {
    const machines = await store.listMachines();
    return reply.send({
      machines: machines.map((m) => ({
        machine_id: m.id,
        label: machineLabel(m.id, m.hostname),
        hostname: m.hostname,
        os: m.os,
        last_seen_at: m.lastSeenAt ? m.lastSeenAt.toISOString() : null,
        revoked: m.revokedAt !== null,
      })),
    });
  });

  // ── GET /v1/windows/current
  // burn_points：燃尽 / 预测曲线最多多少个点（缺省 240）。手表这类只要数字不画曲线的客户端
  // 传 2 就够 —— 否则四个窗口加起来上百 KB，每分钟走一趟蓝牙太重
  const windowsCurrentSchema = rangeSchema.extend({
    burn_points: z.coerce.number().int().min(2).max(240).optional(),
  });
  app.get("/v1/windows/current", async (req, reply) => {
    const q = parseQuery(windowsCurrentSchema, req.query);
    const profileId = await resolveProfileId(q.profile_id);
    const result = await computeCurrentWindows(store, profileId, {
      now: now(),
      quotaStaleMs: config.quotaStaleMs,
      ...(q.burn_points !== undefined ? { maxBurnPoints: q.burn_points } : {}),
    });
    return reply.send(result);
  });

  // ── GET /v1/summary（菜单栏专用）
  app.get("/v1/summary", async (req, reply) => {
    const q = parseQuery(rangeSchema, req.query);
    const profileId = await resolveProfileId(q.profile_id);
    const current = await computeCurrentWindows(store, profileId, {
      now: now(),
      quotaStaleMs: config.quotaStaleMs,
      // 菜单栏不画燃尽曲线，最少取两点够算速率即可
      maxBurnPoints: 2,
    });
    return reply.send(buildSummary(current, { dashboardUrl: config.dashboardUrl }));
  });

  // ── GET /v1/timeline（甘特图 + §7.5 重叠度指标）
  app.get("/v1/timeline", async (req, reply) => {
    const q = parseQuery(rangeSchema, req.query);
    const profileId = await resolveProfileId(q.profile_id);
    const { from, to } = parseRange(q, now(), 24 * 60 * 60 * 1000);
    const rows = await store.eventsInRange(profileId, from, to);
    const events = rows.map((r) => r.event);

    const latest = await store.latestQuotaWindows(profileId);
    const fiveHour = latest.find((w) => inferWindowMs(w.windowKind) <= 6 * 60 * 60 * 1000) ?? null;
    const windowEnd = fiveHour?.resetsAt ?? to;
    const windowMs = fiveHour ? inferWindowMs(fiveHour.windowKind) : 5 * 60 * 60 * 1000;
    const windowStart = new Date(windowEnd.getTime() - windowMs);

    const metrics = computeWindowMetrics({
      events,
      windowStart,
      windowEnd,
      utilizationPct: fiveHour?.utilizationPct ?? 0,
      localWindowMs: windowMs,
    });

    // 窗口边界竖线：覆盖 [from, to] 的每一条
    const boundaries: string[] = [];
    for (let t = windowEnd.getTime(); t >= from.getTime(); t -= windowMs) {
      if (t <= to.getTime()) boundaries.push(new Date(t).toISOString());
    }
    boundaries.reverse();

    // 泳道上显示 hostname 而不是 UUID；未 enroll 过的 machine_id 退回显示 id 本身
    const labels = new Map(
      (await store.listMachines()).map((m) => [m.id, machineLabel(m.id, m.hostname)]),
    );

    return reply.send({
      profile_id: profileId,
      from: from.toISOString(),
      to: to.toISOString(),
      window_boundaries: boundaries,
      lanes: buildTimelineLanes(events).map((lane) => ({
        machine_id: lane.machineId,
        machine_label: labels.get(lane.machineId) ?? lane.machineId,
        events: lane.events,
        tokens: lane.tokens,
        spans: lane.spans.map((s) => ({
          from: s.from.toISOString(),
          to: s.to.toISOString(),
          events: s.events,
          tokens: s.tokens,
        })),
      })),
      metrics: {
        local_window_offset_min: metrics.localWindowOffsetMin,
        // 0..1 的比值转 0..100（CONTRACT §4）
        multi_machine_overlap_pct: ratioToPct(metrics.multiMachineOverlap),
        session_cut_rate_pct: ratioToPct(metrics.sessionCutRate),
        window_waste_pct: metrics.windowWastePct,
      },
    });
  });

  // ── GET /v1/distribution
  app.get("/v1/distribution", async (req, reply) => {
    const q = parseQuery(distributionSchema, req.query);
    const profileId = await resolveProfileId(q.profile_id);
    const { from, to } = parseRange(q, now(), 7 * 24 * 60 * 60 * 1000);
    const rows = await store.eventsInRange(profileId, from, to);
    const buckets = buildDistribution(rows, q.by as DistributionBy, q.bucket as SeriesBucket);

    // CONTRACT §2.1a：key 是稳定标识（跨端点一致，分类色板按它登记），label 只管展示。
    // by=machine 时 key = machine_id，label = 可读主机名；没有可读名就不塞 label，
    // 让前端退回显示 key —— 硬塞一个等于 key 的 label 只会让调用方误以为拿到了人名。
    let labelOf: ((key: string) => string | undefined) | null = null;
    /** by=session 的桶另带「在哪个项目、哪台机器」：只看标题分不清同名的两个会话 */
    let sessionExtra: ((key: string) => { project_slug: string | null; machine_label: string }) | null = null;
    if (q.by === "machine") {
      const names = new Map(
        (await store.listMachines()).map((m) => [m.id, machineLabel(m.id, m.hostname)]),
      );
      labelOf = (key) => {
        const l = names.get(key);
        return l && l !== key ? l : undefined;
      };
    } else if (q.by === "session") {
      const titles = await store.sessionTitles(buckets.map((b) => b.key));
      labelOf = (key) => titles.get(key);
      const machines = new Map(
        (await store.listMachines()).map((m) => [m.id, machineLabel(m.id, m.hostname)]),
      );
      // 一个会话只在一台机器、一个项目目录里：取第一次见到的即可
      const where = new Map<string, { project: string | null; machine: string }>();
      for (const r of rows) {
        const sid = r.event.sessionId || "(unknown)";
        if (!where.has(sid)) where.set(sid, { project: r.event.projectSlug, machine: r.event.machineId });
      }
      sessionExtra = (key) => {
        const w = where.get(key);
        return {
          project_slug: w?.project ?? null,
          machine_label: w ? (machines.get(w.machine) ?? w.machine) : "",
        };
      };
    } else if (q.by === "project") {
      // ★ 临时工作区的目录名只有一段随机后缀（「105cae」）。它的名字应该是里面那个会话的标题：
      //   取该目录里 token 最多的会话，有标题就用标题；多于一个会话时注明「等 N 个」。
      const bySlug = new Map<string, Map<string, number>>();
      for (const r of rows) {
        const slug = r.event.projectSlug;
        if (!isScratchWorkspace(slug)) continue;
        const inner = bySlug.get(slug!) ?? new Map<string, number>();
        const sid = r.event.sessionId || "(unknown)";
        inner.set(sid, (inner.get(sid) ?? 0) + r.event.inputTokens + r.event.outputTokens + r.event.cacheReadTokens + r.event.cacheWrite5mTokens + r.event.cacheWrite1hTokens);
        bySlug.set(slug!, inner);
      }
      const top = new Map<string, { sessionId: string; n: number }>();
      for (const [slug, inner] of bySlug) {
        const [sid] = [...inner.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
        if (sid) top.set(slug, { sessionId: sid, n: inner.size });
      }
      const titles = await store.sessionTitles([...top.values()].map((t) => t.sessionId));
      labelOf = (key) => {
        const t = top.get(key);
        const title = t ? titles.get(t.sessionId) : undefined;
        if (!title) return undefined;
        return t!.n > 1 ? `${title} 等 ${t!.n} 个` : title;
      };
    }
    return reply.send({
      profile_id: profileId,
      by: q.by,
      bucket: q.bucket,
      from: from.toISOString(),
      to: to.toISOString(),
      buckets: buckets.map((b) => ({
        key: b.key,
        ...(labelOf?.(b.key) ? { label: labelOf(b.key) } : {}),
        ...(sessionExtra ? sessionExtra(b.key) : {}),
        events: b.events,
        input_tokens: b.inputTokens,
        output_tokens: b.outputTokens,
        cache_read_tokens: b.cacheReadTokens,
        cache_write_5m_tokens: b.cacheWrite5mTokens,
        cache_write_1h_tokens: b.cacheWrite1hTokens,
        total_tokens: b.totalTokens,
        // null = 这一桶里没有任何有报价的模型；unpriced_events > 0 表示成本不完整
        cost_usd: b.costUsd,
        unpriced_events: b.unpricedEvents,
        // series 只在 bucket=hour|day 时出现
        ...(b.series ? { series: b.series } : {}),
      })),
    });
  });

  /**
   * GET /v1/quota/history —— 历史额度快照。
   *
   * `/v1/windows/current` 只给当前窗口。按周回看需要任意区间的原始百分比序列，
   * 而这些快照本来就在 quota_snapshots 里，只是之前没有出口。
   */
  app.get("/v1/quota/history", async (req, reply) => {
    const q = parseQuery(quotaHistorySchema, req.query);
    const profileId = await resolveProfileId(q.profile_id);
    const { from, to } = parseRange(q, now(), 7 * 24 * 60 * 60 * 1000);
    const samples = await store.quotaSamples(profileId, q.window_kind, from, to);
    return reply.send({
      profile_id: profileId,
      window_kind: q.window_kind,
      from: from.toISOString(),
      to: to.toISOString(),
      samples: samples.map((x) => ({ ts: x.ts.toISOString(), utilization_pct: x.pct })),
    });
  });

  // ── GET /v1/calibration
  app.get("/v1/calibration", async (req, reply) => {
    const q = parseQuery(rangeSchema, req.query);
    const profileId = await resolveProfileId(q.profile_id);
    const records = await store.latestCalibration(profileId);
    return reply.send({
      profile_id: profileId,
      // 空数组 = 观测点还不够，看板显示「标定中」，退回百分比口径
      calibrations: records.map((c) => ({
        window_kind: c.windowKind,
        computed_at: c.computedAt.toISOString(),
        limit_weighted_tokens: c.limitWeightedTokens,
        base_model: c.baseModel,
        weights: c.weights,
        residual: c.residual,
        observations: c.observations,
        converged: c.converged,
        // 逐观测点，供「拟合散点」图；空数组表示这条记录早于 points 落库
        points: c.points,
      })),
    });
  });

  // ── GET /v1/stream（SSE）
  app.get("/v1/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const q = parseQuery(rangeSchema, req.query);
    const profileId = await resolveProfileId(q.profile_id);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write(`retry: 5000\n\n`);

    const send = (name: string, data: unknown) => {
      if (!raw.writableEnded) raw.write(formatSse(name, data));
    };

    // 连上先推一次当前状态，前端不用等第一个 tick
    try {
      send(
        "window_update",
        await computeCurrentWindows(store, profileId, {
          now: now(),
          quotaStaleMs: config.quotaStaleMs,
        }),
      );
    } catch {
      /* 首推失败不影响后续订阅 */
    }

    const unsubscribe = bus.subscribe((e) => {
      if (e.profileId !== profileId) return;
      send(e.name, e.data);
    });
    // 心跳是**具名事件** `ping`，不是 SSE 注释 —— 注释在 EventSource 里不触发任何回调，
    // 客户端就没法用它判断连接还活着（CONTRACT §2）。
    const heartbeat = setInterval(() => send("ping", {}), config.streamHeartbeatMs);
    heartbeat.unref?.();

    const cleanup = () => {
      unsubscribe();
      clearInterval(heartbeat);
    };
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
  });

  return { fastify: app, bus, sampler };
}
