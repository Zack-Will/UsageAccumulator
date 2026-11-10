import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodexIngestBatch, CodexUsageEvent } from "@ua/core";
import { buildApp, type UaApp } from "../src/app.js";
import { startRepricing, withLivePricing } from "../src/live-pricing.js";
import { PriceBook } from "../src/pricing.js";
import { MemoryStore } from "../src/store-memory.js";
import { AUTH, makeEvent, ndjson, testConfig, toWire } from "./helpers.js";

const NOW = new Date("2026-11-10T08:00:00.000Z");
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const V2 = { input: 15, output: 75, cache_read: 1.5, cache_write_5m: 18.75, cache_write_1h: 30 };
/** 1M 输入、其余为 0：成本 = input 单价 */
const inputOnly = (over: Parameters<typeof makeEvent>[0] = {}) =>
  makeEvent({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, ts: new Date("2026-11-10T07:00:00Z"), ...over });

function codexEvent(over: Partial<CodexUsageEvent> = {}): CodexUsageEvent {
  return { event_id: "event-1", session_id: "session-1", turn_id: "turn-1", parent_session_id: null,
    ts: "2026-11-10T07:00:00.000Z", model: "gpt-6.1-sol", model_provider: "openai", reasoning_effort: "high",
    service_tier: null, project: "/projects/example", input_tokens: 1_000_000, cached_input_tokens: 0,
    cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1_000_000,
    quality_flags: [], ...over };
}
const codexBatch = (events: CodexUsageEvent[]): CodexIngestBatch => ({
  schema_version: 1, account: { account_id: "account-1", email: "reader@example.com", plan_type: "pro" }, events,
  collector: { captured_at: NOW.toISOString(), state: "ok", error_code: null, backfill_from: "2026-11-01T00:00:00.000Z",
    scanned_files: 1, parse_warnings: 0, account_binding: "verified_login_configured_history" },
});

let dir: string;
let file: string;
let book: PriceBook;
const setPrices = async (models: Record<string, unknown>) => {
  await writeFile(file, JSON.stringify({ models }));
  book.reload();
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ua-live-pricing-"));
  file = join(dir, "pricing.json");
  book = new PriceBook([{ kind: "bundled", path: file, optional: false }], quiet);
  await setPrices({ "claude-opus-5": V2, "gpt-6.1-sol": { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("withLivePricing：读出来的成本按当前价格现算", () => {
  it("不认库里存的值；改价后同一条历史记录立刻按新价算，补价后旧的缺价记录马上有价", async () => {
    const raw = new MemoryStore();
    await raw.insertEvents([
      { event: inputOnly(), costUsd: 999 },
      { event: inputOnly({ model: "claude-fable-9" }), costUsd: null },
    ]);
    const store = withLivePricing(raw, book);
    const costs = async () => (await store.eventsInRange("claude-official", new Date(0), NOW)).map((r) => r.costUsd);

    expect(await costs()).toEqual([15, null]);
    await setPrices({ "claude-opus-5": { ...V2, input: 5 }, "claude-fable-9": { input: 8, output: 40 } });
    expect(await costs()).toEqual([5, 8]);
  });

  it("Codex 的成本同样现算，带上算它的价格版本", async () => {
    const raw = new MemoryStore();
    await raw.codex.ingest(codexBatch([codexEvent()]), "mac", [{ usd: 999, basis: "api_equivalent_current_rates", price_version: "old", missing_reason: null }], NOW.toISOString());
    const store = withLivePricing(raw, book);
    const [row] = await store.codex.events("account-1", "2026-11-01T00:00:00.000Z", NOW.toISOString());
    expect(row!.cost).toMatchObject({ usd: 2, price_version: book.version, missing_reason: null });
  });

  it("其余方法原样转发（包括内部互相调用的）", async () => {
    const raw = new MemoryStore();
    await raw.insertEvents([{ event: inputOnly(), costUsd: null }]);
    const store = withLivePricing(raw, book);
    expect(await store.quotaEventTimestamps("claude-official", new Date(0), NOW)).toHaveLength(1);
    expect(await store.ping()).toBe(true);
  });
});

describe("startRepricing：库里的成本列在后台跟上价格", () => {
  it("启动时把没算过 / 版本过时的行重算；改价后自动再来一轮", async () => {
    const raw = new MemoryStore();
    await raw.insertEvents([
      { event: inputOnly(), costUsd: 999 },
      { event: inputOnly({ model: "claude-fable-9" }), costUsd: null, priceVersion: "old" },
    ]);
    await raw.codex.ingest(codexBatch([codexEvent()]), "mac", [{ usd: null, basis: "api_equivalent_current_rates", price_version: "old", missing_reason: "unknown_model" }], NOW.toISOString());
    const job = startRepricing(raw, book, quiet);
    try {
      await job.trigger();
      const stored = () => [...raw.events.values()].map((r) => [r.costUsd, r.priceVersion]);
      expect(stored()).toEqual([[15, book.version], [null, book.version]]);
      const [codex] = await raw.codex.events("account-1", "2026-11-01T00:00:00.000Z", NOW.toISOString());
      expect(codex!.cost).toMatchObject({ usd: 2, price_version: book.version, missing_reason: null });

      // 再跑一遍什么都不用改
      expect(await raw.staleCostEvents(book.version, 10)).toEqual([]);

      await setPrices({ "claude-opus-5": V2, "claude-fable-9": { input: 8, output: 40 } });
      await job.trigger(); // onChange 已经触发了一轮，这里等它跑完
      expect(stored()).toEqual([[15, book.version], [8, book.version]]);
      const [codex2] = await raw.codex.events("account-1", "2026-11-01T00:00:00.000Z", NOW.toISOString());
      expect(codex2!.cost).toMatchObject({ usd: null, missing_reason: "unknown_model" });
    } finally {
      job.stop();
    }
  });
});

describe("startRepricing：跑到一半价格又变了", () => {
  it("立刻按新版本重来，不会把同一批行反复抓回来重算", async () => {
    const raw = new MemoryStore();
    const events = Array.from({ length: 5 }, (_, i) => codexEvent({ event_id: `e${i}` }));
    await raw.codex.ingest(codexBatch(events), "mac", events.map(() => ({ usd: null, basis: "api_equivalent_current_rates", price_version: "old", missing_reason: null })), NOW.toISOString());
    let fetches = 0;
    let changed = false;
    const fetch = raw.codex.staleCostEvents.bind(raw.codex);
    const update = raw.codex.updateEventCosts.bind(raw.codex);
    raw.codex.staleCostEvents = async (v, limit) => {
      fetches++;
      return fetch(v, Math.min(limit, 2)); // 一批两条，好让「中途」存在
    };
    raw.codex.updateEventCosts = async (rows) => {
      await update(rows);
      if (!changed) {
        changed = true;
        writeFileSync(file, JSON.stringify({ models: { "gpt-6.1-sol": { input: 3, output: 10 } } }));
        book.reload();
      }
    };
    const job = startRepricing(raw, book, quiet);
    try {
      await job.trigger();
      const rows = await raw.codex.events("account-1", "2026-11-01T00:00:00.000Z", NOW.toISOString());
      expect(new Set(rows.map((r) => r.cost.price_version))).toEqual(new Set([book.version]));
      expect(rows.every((r) => r.cost.usd === 3)).toBe(true);
      expect(fetches).toBeLessThan(10);
    } finally {
      job.stop();
    }
  });
});

describe("定价接口", () => {
  let store: MemoryStore;
  let app: UaApp;
  let machineAuth: { authorization: string };

  beforeEach(async () => {
    store = new MemoryStore();
    app = buildApp({ store, config: testConfig({ codexAccountEmail: "reader@example.com" }), now: () => NOW, pricing: book });
    await app.fastify.ready();
    const res = await app.fastify.inject({
      method: "POST", url: "/v1/enroll",
      payload: { enroll_token: "enroll-token", hostname: "mac", os: "darwin" },
    });
    machineAuth = { authorization: `Bearer ${(res.json() as { machine_token: string }).machine_token}` };
    await store.createMachine({ id: "codex-mac", provisionalMachineId: null, hostname: "codex-mac", os: "darwin",
      tokenSha256: createHash("sha256").update("token-codex-mac").digest("hex") });
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  it("GET /v1/pricing：当前价格、文件状态，以及最近有用量却缺价的模型", async () => {
    await store.insertEvents([
      { event: inputOnly(), costUsd: null },
      { event: inputOnly({ model: "claude-fable-9" }), costUsd: null },
      { event: inputOnly({ model: "claude-fable-9" }), costUsd: null },
      // 不计额度的不算「缺价」：合成标记、套壳路由到的非 Anthropic 模型
      { event: inputOnly({ model: "<synthetic>" }), costUsd: null },
      { event: inputOnly({ model: "qwen3.7-plus" }), costUsd: null },
      // 30 天以前的不提
      { event: inputOnly({ model: "claude-ancient", ts: new Date("2026-09-01T00:00:00Z") }), costUsd: null },
    ]);
    await store.codex.ingest(codexBatch([codexEvent(), codexEvent({ event_id: "e2", model: "gpt-9-nova" }), codexEvent({ event_id: "e3", model: "gpt-6.1-sol-wm" })]),
      "codex-mac", [], NOW.toISOString());

    const res = await app.fastify.inject({ method: "GET", url: "/v1/pricing", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown> & { models: { model: string }[]; unpriced: unknown[] };
    expect(body["version"]).toBe(book.version);
    expect(body.models.map((m) => m.model)).toEqual(["claude-opus-5", "gpt-6.1-sol"]);
    expect(body["layers"]).toEqual([{ kind: "bundled", path: file, present: true, declared_version: null, models: 2, errors: [] }]);
    expect(body.unpriced).toEqual([
      { provider: "claude", model: "claude-fable-9", events: 2, last_seen: "2026-11-10T07:00:00.000Z" },
      { provider: "codex", model: "gpt-9-nova", events: 1, last_seen: "2026-11-10T07:00:00.000Z" },
    ]);
  });

  it("只有看板身份能看、能重新加载", async () => {
    for (const [method, url] of [["GET", "/v1/pricing"], ["POST", "/v1/pricing/reload"]] as const) {
      const res = await app.fastify.inject({ method, url, headers: machineAuth });
      expect(res.statusCode).toBe(403);
    }
  });

  it("POST /v1/pricing/reload：立即生效；文件坏了不生效并说明原因", async () => {
    await writeFile(file, JSON.stringify({ models: { "claude-opus-5": { ...V2, input: 1 } } }));
    let res = await app.fastify.inject({ method: "POST", url: "/v1/pricing/reload", headers: AUTH });
    expect(res.json()).toMatchObject({ applied: true, rejected: null });
    expect(book.claudeCost(inputOnly())).toBeCloseTo(1, 9);

    await writeFile(file, "{");
    res = await app.fastify.inject({ method: "POST", url: "/v1/pricing/reload", headers: AUTH });
    const body = res.json() as { applied: boolean; rejected: { errors: string[] } };
    expect(body.applied).toBe(false);
    expect(body.rejected.errors[0]).toContain("not valid JSON");
    expect(book.claudeCost(inputOnly())).toBeCloseTo(1, 9);
  });

  it("上报入库时记下算成本用的价格版本", async () => {
    const res = await app.fastify.inject({
      method: "POST", url: "/v1/ingest/events",
      headers: { ...machineAuth, "content-type": "application/x-ndjson", "content-encoding": "gzip" },
      payload: gzipSync(ndjson([toWire(inputOnly())])),
    });
    expect(res.statusCode).toBe(200);
    const [row] = [...store.events.values()];
    expect(row).toMatchObject({ costUsd: 15, priceVersion: book.version });
  });
});
