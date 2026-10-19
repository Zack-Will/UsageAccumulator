import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAccount, CodexAccountUsageSnapshot, CodexIngestBatch, CodexQuotaSnapshot } from "@ua/core";
import { CodexProbe } from "../src/codex-probe.js";
import { CodexClientError } from "../src/codex-client.js";
import type { ProbeConfig } from "../src/config.js";
import { cleanup, makeConfig, silentLog, tmpDir } from "./helpers.js";

const ACCOUNT: CodexAccount = { account_id: "account-a", email: "collector@example.test", plan_type: "pro" };
const FROM = "2026-10-01T00:00:00+08:00";
const UTC_FROM = "2026-09-30T16:00:00.000Z";
const T = "2026-10-01T01:00:00.000Z";
const QUOTA: CodexQuotaSnapshot = {
  captured_at: "2026-10-17T12:00:00.000Z",
  windows: [{ window_id: "codex:primary", limit_id: "codex", slot: "primary", label: null,
    used_percent: 44, duration_minutes: 10080, resets_at: null }],
  limits: [{ limit_id: "codex", plan_type: "pro", credits: null, limit_reached: null }],
};
const OFFICIAL: CodexAccountUsageSnapshot = {
  captured_at: "2026-10-17T12:00:01.000Z", daily: [{ date: "2026-10-01", tokens: 9_000 }], lifetime_tokens: 1_000_000, threads: [],
};
const line = (type: string, payload: unknown, timestamp = T): string => JSON.stringify({ type, payload, timestamp });
const meta = (extra: Record<string, unknown> = {}): string => line("session_meta", {
  id: "session-a", timestamp: "2026-09-30T15:00:00Z", cwd: "/test/project", model_provider: "custom", ...extra,
});
const turn = (id = "turn-a"): string => line("turn_context", { turn_id: id, model: "gpt-test", effort: "high" });
const counters = (input: number, output: number) => ({
  input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
});
const count = (input: number, output: number, lastInput = input, lastOutput = output, timestamp = T): string =>
  line("event_msg", { type: "token_count", info: {
    total_token_usage: counters(input, output), last_token_usage: counters(lastInput, lastOutput),
  } }, timestamp);
const content = (...lines: string[]): string => `${lines.join("\n")}\n`;

const dirs: string[] = [];
const probes = new Set<CodexProbe>();
afterEach(async () => {
  for (const probe of probes) { await probe.stop(); probe.close(); }
  probes.clear();
  for (const dir of dirs.splice(0)) cleanup(dir);
});

function setup() {
  const dir = tmpDir("ua-codex-probe-test-");
  dirs.push(dir);
  const sessions = join(dir, "sessions");
  const archives = join(dir, "archived_sessions");
  mkdirSync(sessions); mkdirSync(archives);
  const cfg = makeConfig();
  cfg.codex = { ...cfg.codex, enabled: true, expected_email: ACCOUNT.email, home: dir,
    scan_roots: [sessions, archives], state_db: join(dir, "codex.db"), backfill_from: FROM };
  return { dir, sessions, archives, cfg, file: join(sessions, "session.jsonl") };
}

function fakeClient() {
  const state = {
    account: structuredClone(ACCOUNT), quota: structuredClone(QUOTA), usage: structuredClone(OFFICIAL),
    accountError: null as Error | null, usageError: null as Error | null,
  };
  const calls = { start: vi.fn(async () => {}), account: vi.fn(), usage: vi.fn(), close: vi.fn(async () => {}) };
  const makeClient = () => ({
    start: calls.start,
    readAccount: async (expectedEmail: string) => {
      calls.account(expectedEmail);
      if (state.accountError) throw state.accountError;
      return { account: structuredClone(state.account), quota: structuredClone(state.quota) };
    },
    readUsage: async () => {
      calls.usage();
      if (state.usageError) throw state.usageError;
      return structuredClone(state.usage);
    },
    close: calls.close,
  });
  return { state, calls, makeClient };
}

const receipt = (batch: CodexIngestBatch, deduped = false): Response => new Response(JSON.stringify({
  accepted: deduped ? 0 : batch.events.length, deduped: deduped ? batch.events.length : 0,
}), { status: 200, headers: { "Content-Type": "application/json" } });

function fakeFetch(responder: (batch: CodexIngestBatch, index: number) => Response | Promise<Response> = (batch) => receipt(batch)) {
  const batches: CodexIngestBatch[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const batch = JSON.parse(String(init?.body)) as CodexIngestBatch;
    batches.push(batch);
    return responder(batch, batches.length - 1);
  };
  return { fetcher, batches };
}

function probeFor(cfg: ProbeConfig, client = fakeClient(), http = fakeFetch()): CodexProbe {
  const probe = new CodexProbe(cfg, { logger: silentLog, makeClient: client.makeClient, fetcher: http.fetcher });
  probes.add(probe);
  return probe;
}
function closeProbe(probe: CodexProbe): void { probe.close(); probes.delete(probe); }

describe("CodexProbe durable collection", () => {
  it("uses Shanghai October 1 midnight as the UTC cutoff while parsing the earlier cumulative baseline", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(),
      count(100, 10, 100, 10, "2026-09-30T15:59:59.999Z"),
      count(300, 30, 200, 20, UTC_FROM),
      count(350, 35, 50, 5, "2026-09-30T16:00:00.001Z")));
    const http = fakeFetch();
    const probe = probeFor(cfg, fakeClient(), http);
    const outcome = await probe.sync();
    const events = http.batches.flatMap((batch) => batch.events);
    expect(outcome).toMatchObject({ files: 1, events: 2, sent: 2 });
    expect(events.map((event) => event.total_tokens)).toEqual([220, 55]);
    expect(events.map((event) => event.ts)).toEqual([UTC_FROM, "2026-09-30T16:00:00.001Z"]);
    expect(http.batches.every((batch) => batch.collector.backfill_from === UTC_FROM)).toBe(true);
    expect(events.every((event) => event.quality_flags.includes("configured_account_history"))).toBe(true);
  });

  it("deduplicates copied files and resumes a partial line with persisted parser state identically to a full scan", async () => {
    const { cfg, file, archives, dir } = setup();
    const prefix = content(meta(), turn(), count(100, 10));
    const next = count(300, 30, 200, 20, "2026-10-01T01:01:00Z");
    const split = Math.floor(next.length / 2);
    writeFileSync(file, prefix + next.slice(0, split));
    writeFileSync(join(archives, "copied.jsonl"), prefix);
    const first = probeFor(cfg);
    expect(await first.scan()).toMatchObject({ files: 2, events: 1 });
    const checkpoint = first.store.checkpoint(file)!;
    expect(checkpoint.cursor.offset).toBe(Buffer.byteLength(prefix));
    expect(checkpoint.state.cumulative?.total_tokens).toBe(110);
    closeProbe(first);

    appendFileSync(file, next.slice(split) + "\n");
    const resumed = probeFor(cfg);
    expect(resumed.store.checkpoint(file)).toEqual(checkpoint);
    expect(await resumed.scan()).toMatchObject({ files: 2, events: 1 });
    expect(await resumed.scan()).toMatchObject({ events: 0 });
    const incrementalEvents = resumed.store.pendingEvents(100).sort((a, b) => a.event_id.localeCompare(b.event_id));
    expect(resumed.store.stats()).toMatchObject({ events: 2, pending_events: 2, files: 2 });
    expect(resumed.store.checkpoint(file)?.cursor.offset).toBe(statSync(file).size);

    const full = probeFor({ ...cfg, codex: { ...cfg.codex, state_db: join(dir, "full.db") } });
    expect(await full.scan()).toMatchObject({ events: 2 });
    expect(full.store.pendingEvents(100).sort((a, b) => a.event_id.localeCompare(b.event_id))).toEqual(incrementalEvents);
    expect(full.store.checkpoint(file)?.state).toEqual(resumed.store.checkpoint(file)?.state);
  });

  it("does not ACK events after an HTTP failure, replays them after restart, then sends no events twice", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const offline = fakeFetch((batch) => batch.events.length ? new Response("unavailable", { status: 503 }) : receipt(batch));
    const first = probeFor(cfg, fakeClient(), offline);
    await expect(first.sync()).rejects.toThrow("codex_ingest_http_503");
    expect(first.store.stats()).toMatchObject({ events: 1, pending_events: 1, pending_snapshots: 0 });
    const original = first.store.pendingEvents(10);
    closeProbe(first);

    // A server can report deduplication after a previously lost HTTP acknowledgement.
    const online = fakeFetch((batch) => receipt(batch, true));
    const restarted = probeFor(cfg, fakeClient(), online);
    expect(await restarted.sync()).toMatchObject({ events: 0, sent: 1 });
    expect(online.batches.flatMap((batch) => batch.events)).toEqual(original);
    expect(restarted.store.stats()).toMatchObject({ events: 1, pending_events: 0, pending_snapshots: 0 });
    expect(await restarted.sync()).toMatchObject({ events: 0, sent: 0 });
    expect(online.batches.flatMap((batch) => batch.events)).toHaveLength(1);
  });

  it("does not ACK an event batch when a successful HTTP response has an incomplete receipt", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const http = fakeFetch(() => new Response(JSON.stringify({ accepted: 0, deduped: 0 }), { status: 200 }));
    const probe = probeFor(cfg, fakeClient(), http);
    await expect(probe.sync()).rejects.toThrow("codex_ingest_receipt_mismatch");
    expect(probe.store.stats().pending_events).toBe(1);
  });

  it("never scans a new file after account verification fails", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const client = fakeClient();
    client.state.accountError = new CodexClientError("ACCOUNT_MISMATCH");
    const http = fakeFetch();
    const probe = probeFor(cfg, client, http);
    await expect(probe.sync()).rejects.toThrow("codex_account_read_failed");
    expect(probe.store.stats()).toEqual({ events: 0, pending_events: 0, pending_snapshots: 0, rejected_snapshots: 0,
      rejected_events: 0, withheld_events: 0, files: 0 });
    expect(client.calls.usage).not.toHaveBeenCalled();
    expect(client.calls.close).toHaveBeenCalledOnce();
    expect(http.batches).toEqual([]);
  });

  it("rejects a changed stable account ID before scanning appended logs and retains the original account binding", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const client = fakeClient();
    const http = fakeFetch();
    const probe = probeFor(cfg, client, http);
    await probe.sync();
    const checkpoint = probe.store.checkpoint(file);
    appendFileSync(file, content(count(300, 30, 200, 20)));
    client.state.account.account_id = "account-b";
    await expect(probe.sync()).rejects.toThrow("codex_account_read_failed");
    expect(probe.store.checkpoint(file)).toEqual(checkpoint);
    expect(probe.store.stats().events).toBe(1);
    expect(probe.store.meta("account_id")).toBe(ACCOUNT.account_id);
    expect(http.batches.every((batch) => batch.account.account_id === ACCOUNT.account_id)).toBe(true);
    expect(http.batches.at(-1)?.collector.state).toBe("auth");
  });

  it("ships quota and local events when official account usage is unavailable, then keeps recovered summaries separate", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const client = fakeClient();
    client.state.usageError = new Error("SECRET-UPSTREAM-ERROR-BODY");
    const http = fakeFetch();
    const probe = probeFor(cfg, client, http);
    expect(await probe.sync()).toMatchObject({ events: 1, sent: 1 });
    expect(http.batches[0]).toMatchObject({ quota: QUOTA, collector: { state: "error", error_code: "codex_account_usage_unavailable" } });
    expect(http.batches[0]?.account_usage).toBeUndefined();
    expect(JSON.stringify(http.batches)).not.toContain("SECRET");

    client.state.usageError = null;
    expect(await probe.sync()).toMatchObject({ events: 0, sent: 0 });
    const snapshot = http.batches.at(-1)!;
    expect(snapshot.quota).toEqual(QUOTA);
    expect(snapshot.account_usage).toEqual(OFFICIAL);
    expect(snapshot.collector.state).toBe("ok");
    expect(http.batches.flatMap((batch) => batch.events).map((event) => event.total_tokens)).toEqual([110]);
  });

  it("persists offline foreground snapshots and replays every snapshot and event from a restarted background worker", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const client = fakeClient();
    const offline = fakeFetch(() => { throw new Error("offline"); });
    const foreground = probeFor(cfg, client, offline);
    await expect(foreground.sync()).rejects.toThrow("offline");
    client.state.quota.captured_at = "2026-10-17T13:00:00.000Z";
    client.state.quota.windows[0]!.used_percent = 45;
    await expect(foreground.sync()).rejects.toThrow("offline");
    const durable = foreground.store.pendingSnapshots().map((row) => row.batch);
    expect(durable).toHaveLength(2);
    expect(foreground.store.stats()).toMatchObject({ pending_snapshots: 2, pending_events: 1 });
    closeProbe(foreground);

    let background: CodexProbe;
    const online = fakeFetch(async (batch) => {
      if (batch.events.length) await background.stop();
      return receipt(batch);
    });
    background = probeFor(cfg, client, online);
    expect(background.store.pendingSnapshots().map((row) => row.batch)).toEqual(durable);
    await background.run();
    expect(online.batches.slice(0, 2)).toEqual(durable);
    expect(online.batches.filter((batch) => batch.quota)).toHaveLength(3); // two durable + current read
    expect(online.batches.flatMap((batch) => batch.events)).toHaveLength(1);
    expect(background.store.stats()).toMatchObject({ pending_snapshots: 0, pending_events: 0, events: 1 });
  });

  it("counts blank physical lines in a fork boundary so its first own context and usage are retained", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(
      meta({ id: "child", forked_from_id: "parent", parent_thread_id: "parent", subagent_history_start_ordinal: 4 }),
      "", meta({ id: "parent" }), count(10_000, 1_000), turn("child-turn"), count(100, 10),
    ));
    const probe = probeFor(cfg);
    expect(await probe.scan()).toMatchObject({ events: 1 });
    expect(probe.store.pendingEvents(10)[0]).toMatchObject({ session_id: "child", turn_id: "child-turn", total_tokens: 110 });
    expect(probe.store.checkpoint(file)?.state.line_ordinal).toBe(6);
  });

  it.each([400, 413, 422])("durably quarantines snapshot HTTP %i, drains later data, and never reports a clean recovery", async (status) => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const http = fakeFetch((batch, index) => index === 0 ? new Response("PRIVATE-UPSTREAM-DETAIL", { status }) : receipt(batch));
    const first = probeFor(cfg, fakeClient(), http);
    const result = await first.sync();
    expect(result).toMatchObject({ sent: 1, rejected_snapshots: 1 });
    expect(first.store.stats()).toMatchObject({ pending_events: 0, pending_snapshots: 0, rejected_snapshots: 1 });
    const rejected = first.store.rejectedSnapshots();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ http_status: status, batch: { quota: QUOTA, account_usage: OFFICIAL } });
    expect(JSON.stringify(rejected)).not.toContain("PRIVATE-UPSTREAM-DETAIL");
    expect(http.batches.slice(1).every((b) => b.collector.state === "error" && b.collector.error_code === "codex_snapshot_rejected")).toBe(true);
    // Accidental ACK cannot discard quarantined evidence.
    first.store.ackSnapshot(rejected[0]!.id);
    expect(first.store.rejectedSnapshots()).toEqual(rejected);
    closeProbe(first);

    const online = fakeFetch();
    const restarted = probeFor(cfg, fakeClient(), online);
    expect(restarted.store.rejectedSnapshots()).toEqual(rejected);
    expect(await restarted.sync()).toMatchObject({ sent: 0, rejected_snapshots: 1 });
    expect(online.batches).toHaveLength(1);
    expect(online.batches[0]?.collector).toMatchObject({ state: "error", error_code: "codex_snapshot_rejected" });
  });

  it.each([401, 403, 409, 503])("does not quarantine HTTP %i or advance past that rejected snapshot", async (status) => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const http = fakeFetch(() => new Response("blocked", { status }));
    const probe = probeFor(cfg, fakeClient(), http);
    await expect(probe.sync()).rejects.toMatchObject({ status });
    expect(http.batches).toHaveLength(1);
    expect(probe.store.stats()).toMatchObject({ pending_events: 1, pending_snapshots: 1, rejected_snapshots: 0 });
  });

  it("does not mistake a network error's text for an HTTP rejection", async () => {
    const { cfg } = setup();
    const probe = probeFor(cfg, fakeClient(), fakeFetch(() => { throw new Error("codex_ingest_http_400"); }));
    await expect(probe.sync()).rejects.toThrow("codex_ingest_http_400");
    expect(probe.store.stats()).toMatchObject({ pending_snapshots: 1, rejected_snapshots: 0 });
  });

  it("continues past an invalid old snapshot and bounds the status retry if all snapshots are invalid", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const offline = probeFor(cfg, fakeClient(), fakeFetch(() => { throw new Error("offline"); }));
    await expect(offline.sync()).rejects.toThrow("offline");
    const original = offline.store.pendingSnapshots()[0]!.batch;
    closeProbe(offline);
    const online = fakeFetch((batch, index) => index === 0 ? new Response("bad snapshot", { status: 400 }) : receipt(batch));
    const recovered = probeFor(cfg, fakeClient(), online);
    expect(await recovered.sync()).toMatchObject({ sent: 1, rejected_snapshots: 1 });
    expect(online.batches.filter((b) => b.quota)).toHaveLength(2);
    expect(recovered.store.rejectedSnapshots()[0]!.batch).toEqual(original);
    closeProbe(recovered);

    const blocked = fakeFetch(() => new Response("bad request", { status: 422 }));
    const repeated = probeFor(cfg, fakeClient(), blocked);
    expect(await repeated.sync()).toMatchObject({ sent: 0, rejected_snapshots: 3 });
    expect(blocked.batches).toHaveLength(2); // Current snapshot plus one minimal status; no infinite loop.
    expect(repeated.store.stats().pending_snapshots).toBe(0);
  });

  it("isolates a permanently rejected event and ships the rest instead of blocking the queue", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10), count(300, 30, 200, 20), count(600, 60, 300, 30)));
    // The server rejects any batch containing the middle request (e.g. an out-of-range timestamp).
    const bad = (b: CodexIngestBatch) => b.events.some((e) => e.input_tokens === 200);
    const http = fakeFetch((batch) => bad(batch) ? new Response("bad event", { status: 400 }) : receipt(batch));
    const probe = probeFor(cfg, fakeClient(), http);
    expect(await probe.sync()).toMatchObject({ sent: 2 });
    expect(probe.store.stats()).toMatchObject({ pending_events: 0, rejected_events: 1 });
    const shipped = http.batches.filter((b) => !bad(b)).flatMap((b) => b.events.map((e) => e.input_tokens));
    expect(shipped.sort((a, b) => a - b)).toEqual([100, 300]);
    // The collector reports the degradation instead of looking healthy.
    expect(http.batches.at(-1)!.collector).toMatchObject({ state: "error", error_code: "codex_events_rejected" });
  });

  it("does not quarantine events when the envelope itself is rejected", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    // E.g. a server that predates a collector field: every batch is a 400, with or without events.
    const http = fakeFetch((batch) => batch.quota ? receipt(batch) : new Response("bad collector", { status: 400 }));
    const probe = probeFor(cfg, fakeClient(), http);
    await expect(probe.sync()).rejects.toMatchObject({ status: 400 });
    expect(probe.store.stats()).toMatchObject({ pending_events: 1, rejected_events: 0 });
  });

  it("withholds queued events that a later backfill_from excludes, without reporting an error", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10)));
    const offline = probeFor(cfg, fakeClient(), fakeFetch(() => { throw new Error("offline"); }));
    await expect(offline.sync()).rejects.toThrow("offline");
    closeProbe(offline);
    cfg.codex = { ...cfg.codex, backfill_from: "2026-10-05T00:00:00+08:00" };
    const http = fakeFetch();
    const probe = probeFor(cfg, fakeClient(), http);
    expect(await probe.sync()).toMatchObject({ sent: 0 });
    expect(probe.store.stats()).toMatchObject({ pending_events: 0, rejected_events: 0, withheld_events: 1 });
    expect(http.batches.every((b) => b.events.length === 0)).toBe(true);
    expect(http.batches.at(-1)!.collector).toMatchObject({ state: "ok", warning_scope: "withheld_records" });
  });

  it("ships a compaction request reported only by its usage record, and counts no warnings for clean logs", async () => {
    const { cfg, file } = setup();
    const record = (response: string, u: ReturnType<typeof counters>) => line("token_usage_record", {
      thread_id: "session-a", session_id: "session-a", turn_id: "turn-a", response_id: response, usage: u,
    });
    writeFileSync(file, content(meta(), turn(),
      record("r1", counters(100, 10)), count(100, 10),
      record("r-compact", counters(5000, 300)), line("compacted", { message: "" }), count(100, 10),
      record("r2", counters(200, 20)), count(300, 30, 200, 20)));
    const http = fakeFetch();
    const probe = probeFor(cfg, fakeClient(), http);
    expect(await probe.sync()).toMatchObject({ events: 3, warnings: 0 });
    const events = http.batches.flatMap((b) => b.events);
    expect(events.map((e) => e.input_tokens).sort((a, b) => a - b)).toEqual([100, 200, 5000]);
    expect(events.find((e) => e.input_tokens === 5000)!.quality_flags).toContain("compaction_usage_from_record");
  });

  it("rescans after a parser revision without re-sending events it already derived", async () => {
    const { cfg, file } = setup();
    writeFileSync(file, content(meta(), turn(), count(100, 10), count(300, 30, 200, 20)));
    const http = fakeFetch();
    const probe = probeFor(cfg, fakeClient(), http);
    expect(await probe.sync()).toMatchObject({ sent: 2 });
    probe.store.setMeta("scan_identity", JSON.stringify({ version: 1, roots: [], from: 0 })); // a pre-revision checkpoint
    expect(await probe.sync()).toMatchObject({ files: 1, events: 0, sent: 0 });
    expect(probe.store.stats()).toMatchObject({ events: 2, pending_events: 0 });
  });
});

