import type { FastifyInstance, FastifyRequest, RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import { computeCodexCost, type CodexIngestBatch } from "@ua/core";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { CodexHttpError, normalizeCodexEmail, type CodexCollectorRecord } from "./codex-store.js";
import { codexIngestSchema, codexTimestamp } from "./codex-wire.js";
import { aggregateCodexUsage } from "./codex-aggregate.js";

const accountQuery = z.object({ account_id: z.string().min(1).max(256).optional() }).strict();
const usageQuery = accountQuery.extend({
  from: codexTimestamp, to: codexTimestamp.optional(),
  by: z.enum(["day", "model", "machine", "project", "session"]).default("day"),
  timezone: z.string().min(1).max(100).default("Asia/Shanghai"),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CodexHttpError(400, "bad_request", `Invalid Codex field ${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

export function registerCodexRoutes(app: FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse<IncomingMessage>, Logger>, opts: { store: Store; config: Config; now: () => Date }): void {
  const { store, config, now } = opts;
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
    const [record, collectors] = await Promise.all([store.codex.quota(accountId), store.codex.collectors(accountId)]);
    const at = now();
    return { account_id: accountId, snapshot: record?.snapshot ?? null, source_machine_id: record?.machine_id ?? null,
      received_at: record?.received_at ?? null, ...freshness(record?.snapshot.captured_at ?? null, at),
      collectors: collectors.map((r) => collectorView(r, at)), aggregation: "latest_complete_snapshot" };
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
    const q = parse(usageQuery, req.query);
    const accountId = await resolveAccount(q.account_id);
    const to = q.to ?? now().toISOString();
    if (q.from >= to) throw new CodexHttpError(400, "bad_request", "from must be before to");
    try { new Intl.DateTimeFormat("en", { timeZone: q.timezone }).format(); }
    catch { throw new CodexHttpError(400, "bad_request", "timezone must be a valid IANA time zone"); }
    const [rows, collectors] = await Promise.all([store.codex.events(accountId, q.from, to), store.codex.collectors(accountId)]);
    const result = aggregateCodexUsage(rows, q.by, q.timezone);
    const warningCount = collectors.reduce((n, c) => n + c.parse_warnings_total, 0);
    // Scan diagnostics can concern withheld records with no event. They cannot be placed in a
    // usage timestamp bucket, so conservatively qualify the account-level total, not each bucket.
    if (warningCount > 0) {
      result.totals.usage_complete = false;
      result.totals.cost_complete = false;
      if (rows.length > 0) result.totals.usage_coverage_status = "incomplete";
    }
    return { account_id: accountId, from: q.from, to, by: q.by, timezone: q.timezone,
      source: "local_codex_events", machine_attribution: "first_observer",
      additive_with_account_usage: false, coverage_scope: "observed_local_records_not_all_account_activity",
      collector_parse_warnings_total: warningCount, collector_warnings_scope: "all_observed_scans_not_range_limited",
      ...result };
  });
}
