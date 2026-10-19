import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexIngestBatch, CodexQuotaWindow, CodexUsageEvent } from "@ua/core";
import { buildApp, type UaApp } from "../src/app.js";
import { CODEX_VAULT_ID } from "../src/codex-sampler.js";
import type { SessionVault } from "../src/quota-vault.js";
import { MemoryStore } from "../src/store-memory.js";
import { AUTH, testConfig } from "./helpers.js";

const EMAIL = "reader@example.com";
const T0 = Date.parse("2026-10-13T00:00:00Z");
const MIN = 60_000;
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
const END = 7 * 24 * 60;
let nowMs = T0;

const win = (used: number, resetMin: number): CodexQuotaWindow => ({
  window_id: "codex:secondary", limit_id: "codex", slot: "secondary", label: null,
  used_percent: used, duration_minutes: END, resets_at: at(resetMin),
});
const event = (id: string, min: number, input: number): CodexUsageEvent => ({
  event_id: id, session_id: "s", turn_id: "t", parent_session_id: null, ts: at(min), model: "gpt-6.1-sol",
  model_provider: "openai", reasoning_effort: null, service_tier: null, project: null, input_tokens: input,
  cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0,
  total_tokens: input + 10, quality_flags: [],
});
const batch = (min: number, used: number, resetMin: number, events: CodexUsageEvent[] = []): CodexIngestBatch => ({
  schema_version: 1, account: { account_id: "account-1", email: EMAIL, plan_type: "pro" }, events,
  quota: { captured_at: at(min), windows: [win(used, resetMin)], limits: [] },
  collector: { captured_at: at(min), state: "ok", error_code: null, backfill_from: at(-60), scanned_files: 1,
    parse_warnings: 0, warning_scope: "withheld_records", account_binding: "verified_login_configured_history" },
});

const vault: SessionVault = { list: async () => [], read: async () => null, write: async () => {}, remove: async () => false };

let store: MemoryStore;
let app: UaApp;
beforeEach(async () => {
  store = new MemoryStore();
  await store.createMachine({ id: "mac", provisionalMachineId: null, hostname: "mac", os: "darwin",
    tokenSha256: createHash("sha256").update("token-mac").digest("hex") });
  app = buildApp({ store, config: testConfig({ codexAccountEmail: EMAIL }), now: () => new Date(nowMs),
    codex: { vault, http: async () => ({ status: 500, contentType: "text/plain", text: "" }) } });
  await app.fastify.ready();
});
afterEach(async () => { await app.fastify.close(); });

const ingest = async (b: CodexIngestBatch) => {
  nowMs = Date.parse(b.collector.captured_at);
  const r = await app.fastify.inject({ method: "POST", url: "/v1/codex/ingest",
    headers: { authorization: "Bearer token-mac", "content-type": "application/json" }, payload: JSON.stringify(b) });
  expect(r.statusCode).toBe(200);
};
const get = (path: string) => app.fastify.inject({ method: "GET", url: `/v1/codex/${path}`, headers: AUTH });

describe("Codex 额度：重置感知的 API", () => {
  it("/quota 给出当前期的累计、重置事件与只看当前段的预测", async () => {
    await ingest(batch(0, 40, END, [event("a", -1, 1000)]));
    await ingest(batch(10, 51, END, [event("b", 8, 1000)]));
    await ingest(batch(20, 0, END));
    await ingest(batch(30, 2, END, [event("c", 25, 1000)]));
    const body = (await get("quota")).json();
    const a = body.analysis[0];
    expect(a.window_id).toBe("codex:secondary");
    expect(a.period).toMatchObject({ cumulative_pct: 53, final_pct: 2 });
    expect(a.period.resets).toHaveLength(1);
    expect(a.rate_pct_per_min).toBeCloseTo(0.2, 6);
  });

  it("/periods：重置推走 resets_at 时切成两期，本地花费按期归属", async () => {
    const moved = 20 + END;
    await ingest(batch(0, 40, END, [event("a", 5, 1000)]));
    await ingest(batch(10, 51, END, [event("b", 15, 2000)]));
    await ingest(batch(20, 0, moved, [event("c", 25, 4000)]));
    await ingest(batch(30, 6, moved));
    const body = (await get("periods?weeks=2")).json();
    expect(body.periods.map((p: { cumulative_pct: number; end_reason: string | null }) => [p.cumulative_pct, p.end_reason]))
      .toEqual([[6, null], [51, "reset"]]);
    expect(body.periods[0].opened_by_reset.kind).toBe("new_period");
    expect(body.periods[0].samples).toBeUndefined();
    // 旧期 [T0−7d+…, 重置) 里有 a、b；新期从重置起只有 c
    expect(body.periods[1].local_usage.tokens.input).toBe(3000);
    expect(body.periods[0].local_usage.tokens.input).toBe(4000);
  });

  it("登录只有看板身份能改；读状态不回显任何 token", async () => {
    const put = (headers: Record<string, string>) => app.fastify.inject({ method: "PUT", url: "/v1/codex/session",
      headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify({ credential: "rt_abcdefghijklmnopqrstuvwxyz" }) });
    expect((await put({ authorization: "Bearer token-mac" })).statusCode).toBe(403);
    const status = (await get("session")).json();
    expect(status).toMatchObject({ state: "none" });
    expect(JSON.stringify(status)).not.toMatch(/rt_|refresh_token|access/);
    void CODEX_VAULT_ID;
  });
});
