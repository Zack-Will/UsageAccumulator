/** Optional PostgreSQL integration test. Creates and drops ONLY a unique test schema. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCodexCost, type CodexIngestBatch, type CodexUsageEvent } from "@ua/core";
import { runMigrations } from "../src/migrate.js";
import { PgStore } from "../src/store-pg.js";

const url = process.env["UA_TEST_CODEX_DATABASE_URL"];
const dir = fileURLToPath(new URL("../../../deploy/migrations", import.meta.url));
const receivedAt = "2026-10-18T01:00:00.000Z";
function event(id: string): CodexUsageEvent {
  return { event_id: id, session_id: "s", turn_id: null, parent_session_id: null, ts: "2026-10-01T01:00:00.000Z",
    model: "gpt-6.1-sol", model_provider: "openai", reasoning_effort: null, service_tier: null, project: null,
    input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 100,
    reasoning_output_tokens: 40, total_tokens: 1100, quality_flags: [] };
}
function batch(accountId = "account-one", email = "test@example.com"): CodexIngestBatch {
  return { schema_version: 1, account: { account_id: accountId, email, plan_type: "pro" }, events: [event("event-one")],
    collector: { captured_at: receivedAt, state: "ok", error_code: null, backfill_from: "2026-09-30T16:00:00.000Z",
      scanned_files: 1, parse_warnings: 0, account_binding: "verified_login_configured_history" } };
}

describe.skipIf(!url)("Codex PostgreSQL ledger in an isolated schema", () => {
  const schema = `codex_test_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(url ?? "", { max: 1, onnotice: () => {} });
  const sql = postgres(url ?? "", { max: 5, onnotice: () => {}, connection: { search_path: schema } });
  const store = new PgStore(sql);
  beforeAll(async () => {
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    await runMigrations(sql, dir, { info: () => {} });
  });
  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end({ timeout: 5 });
  });
  const ingest = (b: CodexIngestBatch, machine = "mac") => store.codex.ingest(b, machine, b.events.map(computeCodexCost), receivedAt);

  it("migrates idempotently and handles concurrent duplicates without double counting", async () => {
    expect(await runMigrations(sql, dir, { info: () => {} })).toEqual([]);
    const b = batch();
    const results = await Promise.all([ingest(b), ingest(b, "home")]);
    expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.deduped, 0)).toBe(1);
    const events = await store.codex.events("account-one", "2026-09-30T16:00:00.000Z", receivedAt);
    expect(events).toHaveLength(1);
    expect(events[0]!.cost.usd).toBeCloseTo(0.00262, 9);
    const changed = { ...b, events: [{ ...event("event-one"), output_tokens: 500, total_tokens: 1500 }] };
    expect(await ingest(changed)).toMatchObject({ accepted: 0, deduped: 1, conflicting_duplicates: 1 });
    await ingest(changed);
    const unchanged = (await store.codex.events("account-one", "2026-09-30T16:00:00.000Z", receivedAt))[0]!;
    expect(unchanged.event.output_tokens).toBe(100);
    expect(unchanged.conflicting_observations).toBe(1);
    expect((await store.codex.collectors("account-one")).find((c) => c.machine_id === "mac")?.conflicting_observations).toBe(1);
  });

  it("refuses a second ID for a bound email without partially inserting its data", async () => {
    const other = batch("account-other");
    await expect(ingest(other)).rejects.toMatchObject({ status: 409, code: "account_binding_conflict" });
    expect((await store.codex.accounts()).map((a) => a.account_id)).toEqual(["account-one"]);
    expect(await store.codex.events("account-other", "2026-09-30T16:00:00.000Z", receivedAt)).toEqual([]);
  });

  it("selects complete snapshots by capture time and tracks both collectors independently", async () => {
    const b = batch();
    b.events = [];
    b.quota = { captured_at: "2026-10-18T00:00:00.000Z", windows: [{ window_id: "codex.primary", limit_id: "codex",
      slot: "primary", label: "Codex", used_percent: 41, duration_minutes: 10080, resets_at: null }], limits: [] };
    await ingest(b);
    const newBatch = { ...b, quota: { captured_at: receivedAt, windows: [], limits: [] },
      account_usage: { captured_at: receivedAt, daily: null, lifetime_tokens: 1000000, threads: [] } };
    await ingest(newBatch, "home");
    await ingest(b);
    expect((await store.codex.quota("account-one"))?.snapshot.windows).toEqual([]);
    expect((await store.codex.quota("account-one"))?.machine_id).toBe("home");
    const collectors = await store.codex.collectors("account-one");
    expect(collectors).toHaveLength(2);
    expect(collectors.find((c) => c.machine_id === "mac")?.last_quota_at).toBe("2026-10-18T00:00:00.000Z");
    expect((await store.codex.accountUsage("account-one"))?.snapshot.lifetime_tokens).toBe(1000000);
    b.collector.parse_warnings = 3;
    await ingest(b);
    await ingest(b);
    const clean = { ...b, collector: { ...b.collector, captured_at: "2026-10-18T01:01:00.000Z", parse_warnings: 0 } };
    await ingest(clean);
    const mac = (await store.codex.collectors("account-one")).find((c) => c.machine_id === "mac")!;
    expect(mac.collector.parse_warnings).toBe(0);
    expect(mac.warning_observations).toBe(1);
    expect(mac.parse_warnings_total).toBe(3);
  });
});
