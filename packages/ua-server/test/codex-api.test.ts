import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexIngestBatch, CodexUsageEvent } from "@ua/core";
import { buildApp, type UaApp } from "../src/app.js";
import { MemoryStore } from "../src/store-memory.js";
import { AUTH, testConfig } from "./helpers.js";

const NOW = new Date("2026-10-18T01:00:00.000Z");
const START = "2026-09-30T16:00:00.000Z";
const EMAIL = "reader@example.com";
const RANGE = `from=${START}&to=${NOW.toISOString()}`;
const machineAuth = (id: string) => ({ authorization: `Bearer token-${id}` });

function event(over: Partial<CodexUsageEvent> = {}): CodexUsageEvent {
  return { event_id: "event-1", session_id: "session-1", turn_id: "turn-1", parent_session_id: null,
    ts: "2026-10-01T01:00:00.000Z", model: "gpt-6.1-sol", model_provider: "openai", reasoning_effort: "high",
    service_tier: null, project: "/projects/example", input_tokens: 1000, cached_input_tokens: 200,
    cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 1100,
    quality_flags: [], ...over };
}

function batch(over: Partial<CodexIngestBatch> = {}): CodexIngestBatch {
  return { schema_version: 1, account: { account_id: "account-1", email: EMAIL, plan_type: "pro" }, events: [event()],
    collector: { captured_at: NOW.toISOString(), state: "ok", error_code: null, backfill_from: START,
      scanned_files: 2, parse_warnings: 0, account_binding: "verified_login_configured_history" }, ...over };
}

let store: MemoryStore;
let app: UaApp;
beforeEach(async () => {
  store = new MemoryStore();
  for (const id of ["mac", "home"]) await store.createMachine({ id, provisionalMachineId: null,
    hostname: id, os: id === "mac" ? "darwin" : "linux",
    tokenSha256: createHash("sha256").update(`token-${id}`).digest("hex") });
  app = buildApp({ store, config: testConfig({ codexAccountEmail: EMAIL }), now: () => NOW });
  await app.fastify.ready();
});
afterEach(async () => { await app.fastify.close(); });
const ingest = (body: unknown, id = "mac") => app.fastify.inject({ method: "POST", url: "/v1/codex/ingest",
  headers: { ...machineAuth(id), "content-type": "application/json" }, payload: JSON.stringify(body) });
const get = (path: string) => app.fastify.inject({ method: "GET", url: `/v1/codex/${path}`, headers: AUTH });

describe("Codex independent account ledger", () => {
  it("requires enrolled machine ingestion and the configured account allowlist", async () => {
    expect((await app.fastify.inject({ method: "POST", url: "/v1/codex/ingest", payload: batch() })).statusCode).toBe(401);
    expect((await app.fastify.inject({ method: "POST", url: "/v1/codex/ingest", headers: AUTH, payload: batch() })).statusCode).toBe(403);
    expect((await ingest(batch({ account: { account_id: "other", email: "other@example.com", plan_type: null } }))).statusCode).toBe(409);
    const disabled = buildApp({ store, config: testConfig(), now: () => NOW });
    await disabled.fastify.ready();
    try {
      const r = await disabled.fastify.inject({ method: "POST", url: "/v1/codex/ingest", headers: machineAuth("mac"), payload: batch() });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe("codex_not_configured");
    } finally { await disabled.fastify.close(); }
  });

  it("globally deduplicates two machines and never overwrites an accepted event", async () => {
    expect((await ingest(batch())).json()).toMatchObject({ accepted: 1, deduped: 0, machine_id: "mac" });
    expect((await ingest(batch(), "home")).json()).toMatchObject({ accepted: 0, deduped: 1, conflicting_duplicates: 0 });
    const changed = event({ output_tokens: 500, total_tokens: 1500 });
    expect((await ingest(batch({ events: [changed] }), "home")).json()).toMatchObject({ accepted: 0, deduped: 1, conflicting_duplicates: 1 });
    const usage = (await get(`usage?${RANGE}&by=machine`)).json();
    expect(usage.totals.events).toBe(1);
    expect(usage.totals.tokens.output).toBe(100);
    expect(usage.totals.cost_usd).toBeCloseTo(0.00262, 9);
    expect(usage.totals).toMatchObject({ usage_complete: false, pricing_complete: true, cost_complete: false,
      incomplete_events: 1, conflicting_events: 1, conflicting_observations: 1 });
    expect(usage.machine_attribution).toBe("first_observer");
    expect(usage.buckets.map((b: { key: string }) => b.key)).toEqual(["mac"]);
    expect(store.events.size).toBe(0);
    expect(store.quota).toHaveLength(0);
    await ingest(batch({ events: [changed] }), "home");
    const collectors = (await get("collectors")).json().collectors;
    expect(collectors.find((c: { machine_id: string }) => c.machine_id === "home").conflicting_observations).toBe(1);
  });

  it("rejects account re-binding atomically, case-folds email, and leaves events untouched", async () => {
    expect((await ingest(batch({ account: { account_id: "account-1", email: EMAIL.toUpperCase(), plan_type: "pro" } }))).statusCode).toBe(200);
    const conflict = await ingest(batch({ account: { account_id: "account-2", email: EMAIL, plan_type: "pro" }, events: [event({ event_id: "event-2" })] }));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("account_binding_conflict");
    expect((await get("accounts")).json().accounts).toHaveLength(1);
    expect((await get(`usage?${RANGE}`)).json().totals.events).toBe(1);
  });

  it("uses the latest complete snapshot, clears removed windows, and exposes each collector's freshness", async () => {
    const old = "2026-10-18T00:00:00.000Z";
    await ingest(batch({ quota: { captured_at: old, windows: [{ window_id: "codex.primary", limit_id: "codex", slot: "primary",
      label: "Codex", used_percent: 31, duration_minutes: 10080, resets_at: "2026-10-22T01:00:00.000Z" }], limits: [] } }));
    const first = (await get("quota")).json();
    expect(first.snapshot.windows[0].duration_minutes).toBe(10080);
    expect(first.stale).toBe(true);
    await ingest(batch({ events: [], quota: { captured_at: NOW.toISOString(), windows: [], limits: [] } }), "home");
    // A delayed upload must not resurrect old windows.
    await ingest(batch({ events: [], quota: { captured_at: "2026-10-18T00:30:00.000Z", windows: [], limits: [] } }));
    const current = (await get("quota")).json();
    expect(current.snapshot.windows).toEqual([]);
    expect(current.source_machine_id).toBe("home");
    expect(current.stale).toBe(false);
    expect(current.collectors.find((c: { machine_id: string }) => c.machine_id === "mac").quota_freshness.stale).toBe(true);
    expect(current.collectors.find((c: { machine_id: string }) => c.machine_id === "home").quota_freshness.stale).toBe(false);
  });

  it("keeps official account aggregates separate from local events", async () => {
    await ingest(batch({ account_usage: { captured_at: NOW.toISOString(), daily: [{ date: "2026-10-01", tokens: 90000 }],
      lifetime_tokens: 1000000, threads: [{ session_id: "session-1", estimated_credits_micros: 20000, estimated_usd_micros: 12 }] } }));
    const official = (await get("account-usage")).json();
    expect(official.snapshot.lifetime_tokens).toBe(1000000);
    expect(official.additive_with_local_events).toBe(false);
    expect((await get(`usage?${RANGE}`)).json().totals.tokens.total).toBe(1100);
  });

  it("reports known USD subtotal, missing prices, quality and Shanghai calendar-day buckets", async () => {
    await ingest(batch({ events: [event({ ts: START }), event({ event_id: "event-2", model: "unpublished-model", ts: "2026-10-01T16:00:00.000Z", quality_flags: ["model_missing"] })] }));
    const r = (await get(`usage?${RANGE}&by=day`)).json();
    expect(r.totals).toMatchObject({ events: 2, cost_usd: 0.00262, cost_basis: "api_equivalent_current_rates",
      cost_complete: false, priced_events: 1, unpriced_events: 1, cost_coverage_pct: 50,
      missing_reasons: { unknown_model: 1 }, quality_flags: { model_missing: 1 } });
    expect(r.buckets.map((b: { key: string }) => b.key)).toEqual(["2026-10-01", "2026-10-02"]);
    for (const by of ["model", "project", "session"]) {
      const result = (await get(`usage?${RANGE}&by=${by}`)).json();
      expect(result.buckets.reduce((n: number, b: { events: number }) => n + b.events, 0)).toBe(2);
    }
  });

  it("distinguishes operator provenance from real gaps and retains skipped-record scan diagnostics", async () => {
    await ingest(batch({ events: [event({ quality_flags: ["configured_account_history", "total_tokens_derived"] })] }));
    expect((await get(`usage?${RANGE}`)).json().totals).toMatchObject({ usage_complete: true, pricing_complete: true, cost_complete: true, incomplete_events: 0 });
    await ingest(batch({ events: [event({ event_id: "gap-event", quality_flags: ["cumulative_gap"] })] }));
    expect((await get(`usage?${RANGE}`)).json().totals).toMatchObject({ usage_complete: false, pricing_complete: true,
      cost_complete: false, incomplete_events: 1 });
    const warningBatch = batch({ events: [], collector: { ...batch().collector, captured_at: "2026-10-18T00:40:00.000Z", parse_warnings: 3 } });
    await ingest(warningBatch);
    await ingest(warningBatch); // Snapshot and event uploads can repeat the same scan diagnostics.
    await ingest(batch({ events: [] })); // A clean later scan must not erase the earlier gaps.
    const collector = (await get("collectors")).json().collectors[0];
    expect(collector.collector.parse_warnings).toBe(0);
    expect(collector.warning_observations).toBe(1);
    expect(collector.parse_warnings_total).toBe(3);
    const usage = (await get(`usage?${RANGE}`)).json();
    expect(usage.collector_parse_warnings_total).toBe(3);
    expect(usage.collector_warnings_scope).toBe("all_observed_scans_not_range_limited");
  });

  it("rejects body fields outside the metadata contract and invalid temporal/query data", async () => {
    const cases = [
      { ...batch(), access_token: "not-a-real-token" },
      batch({ events: [{ ...event(), content: "must never be persisted" } as CodexUsageEvent] }),
      batch({ events: [event({ ts: "2026-09-30T15:59:59.999Z" })] }),
      batch({ events: [event({ ts: "2026-10-19T01:00:00.000Z" })] }),
      batch({ events: [event({ input_tokens: -1 })] }),
    ];
    for (const value of cases) expect((await ingest(value)).statusCode).toBe(400);
    await ingest(batch());
    for (const query of ["from=not-a-date", `${RANGE}&timezone=not-a-zone`, `${RANGE}&by=other`, `from=${NOW.toISOString()}&to=${START}`]) {
      expect((await get(`usage?${query}`)).statusCode).toBe(400);
    }
    expect((await get("quota?account_id=absent")).statusCode).toBe(404);
  });
});
