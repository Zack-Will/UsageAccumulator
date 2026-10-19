import type { FastifyInstance, FastifyRequest, RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import { computeCodexCost, type CodexIngestBatch, type CodexQuotaSnapshot } from "@ua/core";

type CodexQuotaSnapshotWindows = CodexQuotaSnapshot["windows"];
import { z } from "zod";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { CodexHttpError, normalizeCodexEmail, type CodexCollectorRecord } from "./codex-store.js";
import { codexIngestSchema, codexTimestamp } from "./codex-wire.js";
import { aggregateCodexUsage } from "./codex-aggregate.js";
import {
  analyzeCodexWindow,
  codexFullCost,
  codexFullCostEstimate,
  codexFullCostReference,
  codexPeriods,
  type CodexPeriod,
} from "./codex-quota-analysis.js";
import type { CodexEventRow } from "./codex-store.js";
import { CODEX_SERVER_MACHINE_ID, type CodexSampler, type CodexSamplerStatus } from "./codex-sampler.js";

const accountQuery = z.object({ account_id: z.string().min(1).max(256).optional() }).strict();
const usageQuery = (defaultTimeZone: string) => accountQuery.extend({
  from: codexTimestamp, to: codexTimestamp.optional(),
  by: z.enum(["day", "model", "machine", "project", "session"]).default("day"),
  timezone: z.string().min(1).max(100).default(defaultTimeZone),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CodexHttpError(400, "bad_request", `Invalid Codex field ${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const periodsQuery = accountQuery.extend({
  window_id: z.string().min(1).max(256).optional(),
  weeks: z.coerce.number().int().min(1).max(26).default(8),
  timezone: z.string().min(1).max(100).optional(),
});
const sessionBody = z.object({ credential: z.string().min(20).max(65_536) }).strict();

const DAY_MS = 24 * 3600_000;

/** 给看板的一期：不带逐点样本（那只在当前期的分析里给） */
function periodView(p: CodexPeriod) {
  const { samples: _samples, ...rest } = p;
  return rest;
}

export function registerCodexRoutes(app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse<IncomingMessage>, Logger>, opts: { store: Store; config: Config; now: () => Date; sampler?: CodexSampler | null }): void {
  const { store, config, now } = opts;
  const sampler = opts.sampler ?? null;

  function requireDashboard(req: FastifyRequest): void {
    const auth = (req as FastifyRequest & { auth?: { kind: string } }).auth;
    if (auth?.kind !== "dashboard") throw new CodexHttpError(403, "forbidden", "只有看板身份能更改 Codex 登录");
  }
  const sessionView = (s: CodexSamplerStatus | null) => s
    ? { state: s.state, last_ok_at: s.lastOkAt?.toISOString() ?? null, last_attempt_at: s.lastAttemptAt?.toISOString() ?? null,
      next_attempt_at: s.nextAttemptAt?.toISOString() ?? null, error: s.error, email: s.email, plan_type: s.planType,
      refreshed_at: s.refreshedAt?.toISOString() ?? null }
    : { state: "disabled", last_ok_at: null, last_attempt_at: null, next_attempt_at: null, error: null, email: null, plan_type: null, refreshed_at: null };
  const age = (captured: string | null, at: Date) => captured ? Math.max(0, (at.getTime() - Date.parse(captured)) / 1000) : null;
  const freshness = (captured: string | null, at: Date) => ({
    age_seconds: age(captured, at), stale: captured === null || at.getTime() - Date.parse(captured) > config.quotaStaleMs,
  });
  function collectorView(row: CodexCollectorRecord, at: Date) {
    return { ...row, ...freshness(row.collector.captured_at, at),
      quota_freshness: freshness(row.last_quota_at, at), account_usage_freshness: freshness(row.last_account_usage_at, at) };
  }
  async function resolveAccount(raw: string | undefined): Promise<string> {
    const accounts = await store.codex.accounts();
    if (raw) {
      if (!accounts.some((a) => a.account_id === raw)) throw new CodexHttpError(404, "not_found", "Unknown Codex account");
      return raw;
    }
    if (accounts.length !== 1) throw new CodexHttpError(400, "bad_request", "account_id is required unless exactly one Codex account is registered");
    return accounts[0]!.account_id;
  }

  app.post("/v1/codex/ingest", async (req, reply) => {
    const auth = (req as FastifyRequest & { auth?: { kind: string; id?: string } }).auth;
    if (auth?.kind !== "machine" || !auth.id) throw new CodexHttpError(403, "forbidden", "Only an enrolled machine may ingest Codex observations");
    if (!config.codexAccountEmail) throw new CodexHttpError(503, "codex_not_configured", "UA_CODEX_ACCOUNT_EMAIL must be configured before Codex ingestion");
    const batch: CodexIngestBatch = parse(codexIngestSchema, req.body);
    if (normalizeCodexEmail(batch.account.email) !== normalizeCodexEmail(config.codexAccountEmail)) {
      throw new CodexHttpError(409, "account_binding_conflict", "The observed account does not match the configured Codex account");
    }
    const at = now();
    const future = at.getTime() + 5 * 60_000;
    const observed = [batch.collector.captured_at, ...batch.events.map((e) => e.ts),
      ...(batch.quota ? [batch.quota.captured_at] : []), ...(batch.account_usage ? [batch.account_usage.captured_at] : [])];
    if (observed.some((s) => Date.parse(s) > future)) throw new CodexHttpError(400, "bad_request", "Observed timestamps may not be more than five minutes in the future");
    if (batch.collector.backfill_from > batch.collector.captured_at
      || batch.events.some((e) => e.ts < batch.collector.backfill_from)) {
      throw new CodexHttpError(400, "bad_request", "Events must fall on or after the declared backfill_from boundary");
    }
    const ids = batch.quota?.windows.map((w) => w.window_id) ?? [];
    if (new Set(ids).size !== ids.length) throw new CodexHttpError(400, "bad_request", "Quota window_id values must be unique within a complete snapshot");
    const result = await store.codex.ingest(batch, auth.id, batch.events.map(computeCodexCost), at.toISOString());
    req.log.info({ accepted: result.accepted, deduped: result.deduped, conflicts: result.conflicting_duplicates }, "ingest Codex metadata");
    return reply.send({ ok: true, account_id: batch.account.account_id, machine_id: auth.id, ...result });
  });

  app.get("/v1/codex/accounts", async () => ({ accounts: await store.codex.accounts() }));

  app.get("/v1/codex/quota", async (req) => {
    const q = parse(accountQuery, req.query);
    const accountId = await resolveAccount(q.account_id);
    const [latest, server, collectors] = await Promise.all([
      store.codex.quota(accountId), store.codex.quota(accountId, CODEX_SERVER_MACHINE_ID), store.codex.collectors(accountId),
    ]);
    const at = now();
    // 服务端自采的快照新鲜就用它：只有它带重置券；探针那份（读不到券）只在服务端抓不到时兜底
    const record = server && at.getTime() - Date.parse(server.snapshot.captured_at) <= config.quotaStaleMs ? server : latest;
    const analysis = record ? await currentAnalysis(accountId, record.snapshot.windows, at) : [];
    return { account_id: accountId, snapshot: record?.snapshot ?? null, source_machine_id: record?.machine_id ?? null, analysis,
      received_at: record?.received_at ?? null, ...freshness(record?.snapshot.captured_at ?? null, at),
      collectors: collectors.map((r) => collectorView(r, at)), aggregation: "latest_complete_snapshot" };
  });

  /**
   * 当前每个窗口所在的一期。回看 = 最长窗口 + 1 天，够看见本期开头和打开它的那次重置。
   * 预测只用当前段（最近一次重置之后）的样本。
   */
  /** 期内本地用量：期开头没观测到时从第一次观测算起 */
  function periodUsage(p: CodexPeriod, rows: CodexEventRow[], end: string, timezone: string) {
    const start = p.starts_at ?? p.first_sample_at;
    const totals = aggregateCodexUsage(rows.filter((r) => r.event.ts >= start && r.event.ts < end), "day", timezone).totals;
    return { start, totals };
  }

  async function currentAnalysis(accountId: string, windows: CodexQuotaSnapshotWindows, at: Date) {
    if (windows.length === 0) return [];
    // 回看够看见本期开头，外加几期往期当「满额约」的参考（7d 是 3 周，5h 至少两天）
    const longest = Math.max(...windows.map((w) => w.duration_minutes ?? 7 * 24 * 60));
    const lookbackMs = Math.min(29 * DAY_MS, Math.max(longest * 60_000 * 3, 2 * DAY_MS) + DAY_MS);
    const from = new Date(at.getTime() - lookbackMs).toISOString();
    const nowIso = at.toISOString();
    const [history, rows] = await Promise.all([
      store.codex.quotaHistory(accountId, from, new Date(at.getTime() + 60_000).toISOString()),
      store.codex.events(accountId, from, nowIso),
    ]);
    const periods = codexPeriods(history);
    return windows.flatMap((w) => {
      const list = periods.get(w.window_id) ?? [];
      const current = list.at(-1);
      if (!current) return [];
      const past = list.slice(0, -1).map((p) => {
        const u = periodUsage(p, rows, p.ended_at ?? nowIso, config.timeZone).totals;
        return { ended_at: p.ended_at, cumulative_pct: p.cumulative_pct, full_cost_usd: codexFullCost(u.cost_usd, p.cumulative_pct) };
      });
      const usage = periodUsage(current, rows, nowIso, config.timeZone);
      return [{
        ...analyzeCodexWindow(current, at),
        local_usage: usage.totals,
        local_usage_from: usage.start,
        full_cost: codexFullCostEstimate(
          { cost_usd: usage.totals.cost_usd, cumulative_pct: current.cumulative_pct, unpriced_events: usage.totals.unpriced_events },
          codexFullCostReference(past),
        ),
      }];
    });
  }

  app.get("/v1/codex/periods", async (req) => {
    const q = parse(periodsQuery, req.query);
    const accountId = await resolveAccount(q.account_id);
    const at = now();
    const from = new Date(at.getTime() - q.weeks * 7 * DAY_MS - 8 * DAY_MS).toISOString();
    const to = at.toISOString();
    const [history, rows] = await Promise.all([
      store.codex.quotaHistory(accountId, from, new Date(at.getTime() + 60_000).toISOString()),
      store.codex.events(accountId, from, to),
    ]);
    const timezone = q.timezone ?? config.timeZone;
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
    catch { throw new CodexHttpError(400, "bad_request", "timezone must be a valid IANA time zone"); }
    const cutoff = at.getTime() - q.weeks * 7 * DAY_MS;
    const periods = [...codexPeriods(history).values()].flat()
      .filter((p) => !q.window_id || p.window_id === q.window_id)
      .filter((p) => Date.parse(p.ended_at ?? to) >= cutoff)
      .sort((a, b) => b.first_sample_at.localeCompare(a.first_sample_at))
      .map((p) => {
        // 本期的本地用量：期内的事件。期开头没观测到时从第一次观测算起，并如实标出
        const end = p.ended_at ?? to;
        const usage = periodUsage(p, rows, end, timezone);
        return { ...periodView(p), local_usage: usage.totals, local_usage_from: usage.start, local_usage_to: end,
          full_cost_usd: codexFullCost(usage.totals.cost_usd, p.cumulative_pct) };
      });
    // 每个窗口的往期参考：已结束、累计 ≥ 30% 的最近 8 期的中位数
    const references = Object.fromEntries([...new Set(periods.map((p) => p.window_id))].map((id) => [id,
      codexFullCostReference(periods.filter((p) => p.window_id === id).slice().reverse())]));
    return { account_id: accountId, weeks: q.weeks, periods, full_cost_references: references,
      reset_detection: { min_drop_pct: 2, gap_minutes: 30 } };
  });

  app.get("/v1/codex/session", async () => sessionView(sampler ? await sampler.status() : null));

  app.put("/v1/codex/session", async (req) => {
    requireDashboard(req);
    if (!sampler) throw new CodexHttpError(404, "not_found", "服务端没有开启 Codex 额度采集");
    const body = parse(sessionBody, req.body);
    try {
      return sessionView(await sampler.save(body.credential));
    } catch (err) {
      if (err instanceof CodexHttpError) throw err;
      throw new CodexHttpError(400, "bad_request", (err as Error).message);
    }
  });

  app.delete("/v1/codex/session", async (req) => {
    requireDashboard(req);
    if (!sampler) throw new CodexHttpError(404, "not_found", "服务端没有开启 Codex 额度采集");
    return sessionView(await sampler.clear());
  });

  app.get("/v1/codex/account-usage", async (req) => {
    const q = parse(accountQuery, req.query);
    const accountId = await resolveAccount(q.account_id);
    const record = await store.codex.accountUsage(accountId);
    return { account_id: accountId, snapshot: record?.snapshot ?? null, source_machine_id: record?.machine_id ?? null,
      received_at: record?.received_at ?? null, ...freshness(record?.snapshot.captured_at ?? null, now()),
      aggregation: "latest_official_account_snapshot", additive_with_local_events: false };
  });

  app.get("/v1/codex/collectors", async (req) => {
    const q = parse(accountQuery, req.query);
    const accountId = await resolveAccount(q.account_id);
    const at = now();
    const [rows, machines] = await Promise.all([store.codex.collectors(accountId), store.listMachines()]);
    return { account_id: accountId, collectors: rows.map((r) => ({ ...collectorView(r, at),
      hostname: machines.find((m) => m.id === r.machine_id)?.hostname ?? null })) };
  });

  app.get("/v1/codex/usage", async (req) => {
    const q = parse(usageQuery(config.timeZone), req.query);
    const accountId = await resolveAccount(q.account_id);
    const to = q.to ?? now().toISOString();
    if (q.from >= to) throw new CodexHttpError(400, "bad_request", "from must be before to");
    try { new Intl.DateTimeFormat("en", { timeZone: q.timezone }).format(); }
    catch { throw new CodexHttpError(400, "bad_request", "timezone must be a valid IANA time zone"); }
    const [rows, collectors] = await Promise.all([store.codex.events(accountId, q.from, to), store.codex.collectors(accountId)]);
    const result = aggregateCodexUsage(rows, q.by, q.timezone);
    const warningCount = collectors.reduce((n, c) => n + c.parse_warnings_total, 0);
    const legacyWarningCount = collectors.reduce((n, c) => n + c.legacy_parse_warnings_total, 0);
    // Withheld records have no event and often no timestamp: they cannot be placed in a usage
    // bucket, so conservatively qualify the account-level total, not each bucket. Legacy
    // diagnostics mixed in notes about emitted events and are disclosed only.
    if (warningCount > 0) {
      result.totals.usage_complete = false;
      result.totals.cost_complete = false;
      if (rows.length > 0) result.totals.usage_coverage_status = "incomplete";
    }
    return { account_id: accountId, from: q.from, to, by: q.by, timezone: q.timezone,
      source: "local_codex_events", machine_attribution: "first_observer",
      additive_with_account_usage: false, coverage_scope: "observed_local_records_not_all_account_activity",
      collector_parse_warnings_total: warningCount, collector_warnings_scope: "all_observed_scans_not_range_limited",
      collector_legacy_diagnostics_total: legacyWarningCount,
      ...result };
  });
}
