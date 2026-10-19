import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { CodexAccountUsageSnapshot, CodexIngestBatch, CodexQuotaSnapshot } from "@ua/core";
import {
  CodexHttpError, canonicalCodexEvent, normalizeCodexEmail,
  type CodexAccountRecord, type CodexCollectorRecord, type CodexCost, type CodexEventRow,
  type CodexIngestResult, type CodexSnapshotRecord, type CodexStore,
} from "./codex-store.js";

type Sql = postgres.Sql<Record<string, never>>;
const iso = (v: unknown): string => v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const nullableIso = (v: unknown): string | null => v == null ? null : iso(v);
const hashEvent = (event: CodexIngestBatch["events"][number]): string =>
  createHash("sha256").update(canonicalCodexEvent(event)).digest("hex");

export class PgCodexStore implements CodexStore {
  constructor(private readonly sql: Sql) {}

  async ingest(batch: CodexIngestBatch, machineId: string, costs: CodexCost[], receivedAt: string): Promise<CodexIngestResult> {
    const accountId = batch.account.account_id;
    const email = normalizeCodexEmail(batch.account.email);
    const result = await this.sql.begin(async (sql) => {
      // UNIQUE(email) and PK(account_id) serialize competing first bindings. A collision never rebinds.
      await sql`INSERT INTO codex_accounts (account_id, email, plan_type, first_seen_at, last_seen_at)
        VALUES (${accountId}, ${email}, ${batch.account.plan_type}, ${receivedAt}, ${receivedAt})
        ON CONFLICT DO NOTHING`;
      const accounts = await sql<{ email: string }[]>`SELECT email FROM codex_accounts WHERE account_id = ${accountId} FOR UPDATE`;
      if (!accounts[0] || accounts[0].email !== email) {
        throw new CodexHttpError(409, "account_binding_conflict", "The account ID and email conflict with an existing stable binding; explicit migration is required");
      }
      await sql`UPDATE codex_accounts SET plan_type = ${batch.account.plan_type}, last_seen_at = ${receivedAt}
        WHERE account_id = ${accountId}`;

      const unique = new Map<string, { event: CodexIngestBatch["events"][number]; cost: CodexCost }>();
      batch.events.forEach((event, i) => { if (!unique.has(event.event_id)) unique.set(event.event_id, { event, cost: costs[i]! }); });
      const rows = [...unique.values()];
      let accepted = 0;
      for (let offset = 0; offset < rows.length; offset += 500) {
        const chunk = rows.slice(offset, offset + 500).map(({ event, cost }) => ({
          account_id: accountId, event_id: event.event_id, machine_id: machineId, ts: event.ts,
          event: sql.json(event as never), event_hash: hashEvent(event), cost_usd: cost.usd,
          cost_basis: cost.basis, price_version: cost.price_version, missing_reason: cost.missing_reason, received_at: receivedAt,
        }));
        const inserted = await sql`INSERT INTO codex_events ${sql(chunk)} ON CONFLICT (account_id, event_id) DO NOTHING RETURNING event_id`;
        accepted += inserted.length;
      }
      let conflicts = 0;
      if (rows.length) {
        const existing = await sql<{ event_id: string; event_hash: string }[]>`
          SELECT event_id, event_hash FROM codex_events WHERE account_id = ${accountId} AND event_id IN ${sql([...unique.keys()])}`;
        const hashes = new Map(existing.map((r) => [r.event_id, r.event_hash]));
        const conflicting = batch.events.filter((e) => hashes.get(e.event_id) !== hashEvent(e));
        conflicts = conflicting.length;
        for (let offset = 0; offset < conflicting.length; offset += 500) {
          const evidence = conflicting.slice(offset, offset + 500).map((e) => ({
            account_id: accountId, event_id: e.event_id, machine_id: machineId,
            observed_hash: hashEvent(e), recorded_hash: hashes.get(e.event_id)!, first_seen_at: receivedAt,
          }));
          await sql`INSERT INTO codex_event_conflicts ${sql(evidence)} ON CONFLICT DO NOTHING`;
        }
      }

      if (batch.quota) {
        await sql`INSERT INTO codex_quota_snapshots (account_id, machine_id, captured_at, received_at, snapshot)
          VALUES (${accountId}, ${machineId}, ${batch.quota.captured_at}, ${receivedAt}, ${sql.json(batch.quota as never)})
          ON CONFLICT (account_id, machine_id, captured_at) DO NOTHING`;
      }
      if (batch.account_usage) {
        await sql`INSERT INTO codex_account_usage_snapshots (account_id, machine_id, captured_at, received_at, snapshot)
          VALUES (${accountId}, ${machineId}, ${batch.account_usage.captured_at}, ${receivedAt}, ${sql.json(batch.account_usage as never)})
          ON CONFLICT (account_id, machine_id, captured_at) DO NOTHING`;
      }
      if (batch.collector.parse_warnings > 0) {
        await sql`INSERT INTO codex_collection_warnings (account_id, machine_id, captured_at, parse_warnings, received_at, warning_scope)
          VALUES (${accountId}, ${machineId}, ${batch.collector.captured_at}, ${batch.collector.parse_warnings}, ${receivedAt},
            ${batch.collector.warning_scope ?? "legacy_all_diagnostics"})
          ON CONFLICT DO NOTHING`;
      }
      await sql`INSERT INTO codex_collectors (account_id, machine_id, captured_at, received_at, collector, last_quota_at, last_account_usage_at)
        VALUES (${accountId}, ${machineId}, ${batch.collector.captured_at}, ${receivedAt}, ${sql.json(batch.collector as never)},
          ${batch.quota?.captured_at ?? null}, ${batch.account_usage?.captured_at ?? null})
        ON CONFLICT (account_id, machine_id) DO UPDATE SET
          collector = CASE WHEN EXCLUDED.captured_at >= codex_collectors.captured_at THEN EXCLUDED.collector ELSE codex_collectors.collector END,
          captured_at = GREATEST(EXCLUDED.captured_at, codex_collectors.captured_at),
          received_at = EXCLUDED.received_at,
          last_quota_at = GREATEST(EXCLUDED.last_quota_at, codex_collectors.last_quota_at),
          last_account_usage_at = GREATEST(EXCLUDED.last_account_usage_at, codex_collectors.last_account_usage_at)`;
      return { accepted, deduped: batch.events.length - accepted, conflicting_duplicates: conflicts };
    });
    return result as CodexIngestResult;
  }

  async accounts(): Promise<CodexAccountRecord[]> {
    const rows = await this.sql<Record<string, unknown>[]>`SELECT * FROM codex_accounts ORDER BY account_id`;
    return rows.map((r) => ({ account_id: String(r["account_id"]), email: String(r["email"]),
      plan_type: r["plan_type"] == null ? null : String(r["plan_type"]), first_seen_at: iso(r["first_seen_at"]), last_seen_at: iso(r["last_seen_at"]) }));
  }

  async events(accountId: string, from: string, to: string): Promise<CodexEventRow[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT e.account_id, e.machine_id, e.event, e.cost_usd, e.cost_basis, e.price_version, e.missing_reason,
        COALESCE(c.n, 0) AS conflicting_observations
      FROM codex_events e LEFT JOIN (
        SELECT event_id, count(*) AS n FROM codex_event_conflicts WHERE account_id = ${accountId} GROUP BY event_id
      ) c ON c.event_id = e.event_id
      WHERE e.account_id = ${accountId} AND e.ts >= ${from} AND e.ts < ${to} ORDER BY e.ts, e.event_id`;
    return rows.map((r) => ({ account_id: String(r["account_id"]), machine_id: String(r["machine_id"]),
      event: r["event"] as CodexEventRow["event"], conflicting_observations: Number(r["conflicting_observations"]), cost: {
        usd: r["cost_usd"] == null ? null : Number(r["cost_usd"]), basis: "api_equivalent_current_rates",
        price_version: String(r["price_version"]), missing_reason: r["missing_reason"] == null ? null : String(r["missing_reason"]),
      } }));
  }

  async quota(accountId: string): Promise<CodexSnapshotRecord<CodexQuotaSnapshot> | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT machine_id, received_at, snapshot FROM codex_quota_snapshots WHERE account_id = ${accountId}
      ORDER BY captured_at DESC, machine_id LIMIT 1`;
    const r = rows[0];
    return r ? { machine_id: String(r["machine_id"]), received_at: iso(r["received_at"]), snapshot: r["snapshot"] as unknown as CodexQuotaSnapshot } : null;
  }

  async accountUsage(accountId: string): Promise<CodexSnapshotRecord<CodexAccountUsageSnapshot> | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT machine_id, received_at, snapshot FROM codex_account_usage_snapshots WHERE account_id = ${accountId}
      ORDER BY captured_at DESC, machine_id LIMIT 1`;
    const r = rows[0];
    return r ? { machine_id: String(r["machine_id"]), received_at: iso(r["received_at"]), snapshot: r["snapshot"] as unknown as CodexAccountUsageSnapshot } : null;
  }

  async collectors(accountId: string): Promise<CodexCollectorRecord[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT collector.*, COALESCE(conflicts.n, 0) AS conflicting_observations, conflicts.last_conflict_at,
        COALESCE(warnings.n, 0) AS warning_observations, COALESCE(warnings.total, 0) AS parse_warnings_total,
        COALESCE(warnings.legacy, 0) AS legacy_parse_warnings_total, warnings.last_warning_at
      FROM codex_collectors collector
      LEFT JOIN (SELECT machine_id, count(*) AS n, max(first_seen_at) AS last_conflict_at
        FROM codex_event_conflicts WHERE account_id = ${accountId} GROUP BY machine_id) conflicts USING (machine_id)
      LEFT JOIN (SELECT machine_id, count(*) AS n,
          sum(parse_warnings) FILTER (WHERE warning_scope = 'withheld_records') AS total,
          sum(parse_warnings) FILTER (WHERE warning_scope <> 'withheld_records') AS legacy,
          max(captured_at) AS last_warning_at
        FROM codex_collection_warnings WHERE account_id = ${accountId} GROUP BY machine_id) warnings USING (machine_id)
      WHERE collector.account_id = ${accountId} ORDER BY collector.machine_id`;
    return rows.map((r) => ({ account_id: accountId, machine_id: String(r["machine_id"]),
      collector: r["collector"] as CodexIngestBatch["collector"], received_at: iso(r["received_at"]),
      last_quota_at: nullableIso(r["last_quota_at"]), last_account_usage_at: nullableIso(r["last_account_usage_at"]),
      conflicting_observations: Number(r["conflicting_observations"]), last_conflict_at: nullableIso(r["last_conflict_at"]),
      warning_observations: Number(r["warning_observations"]), parse_warnings_total: Number(r["parse_warnings_total"]),
      legacy_parse_warnings_total: Number(r["legacy_parse_warnings_total"]),
      last_warning_at: nullableIso(r["last_warning_at"]) }));
  }
}
