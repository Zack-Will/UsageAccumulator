import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type UaApp } from "../src/app.js";
import { EventBus, formatSse } from "../src/bus.js";
import { MemoryStore } from "../src/store-memory.js";
import { testConfig } from "./helpers.js";

describe("EventBus", () => {
  it("delivers to every subscriber and survives a throwing one", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    const off = bus.subscribe((e) => seen.push(e.name));
    bus.publish({ name: "window_update", profileId: "p", data: {} });
    expect(seen).toEqual(["window_update"]);
    off();
    bus.publish({ name: "event_batch", profileId: "p", data: {} });
    expect(seen).toEqual(["window_update"]);
    expect(bus.size).toBe(1);
  });

  it("formats an SSE frame", () => {
    expect(formatSse("window_update", { a: 1 })).toBe('event: window_update\ndata: {"a":1}\n\n');
  });
});

describe("GET /v1/stream", () => {
  let store: MemoryStore;
  let app: UaApp;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.ensureProfiles(["claude-official"]);
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: new Date(),
      windows: [
        { windowKind: "five_hour", utilizationPct: 62, resetsAt: new Date(Date.now() + 3600_000) },
      ],
      raw: {},
    });
    // 心跳调快，不然要等 25 秒才能验到 ping
    app = buildApp({ store, config: testConfig({ streamHeartbeatMs: 30 }) });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await app.fastify.close();
  });

  it("streams window_update frames over SSE", async () => {
    const addr = app.fastify.server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no address");
    const controller = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${addr.port}/v1/stream?profile_id=claude-official`,
      { headers: { authorization: "Bearer dash-token" }, signal: controller.signal },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // 连上立刻推一次当前状态，所以第一帧不用等 tick
    while (!text.includes("\n\n") || !text.includes("event: window_update")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("event: window_update");
    expect(text).toContain('"window_kind":"five_hour"');

    // 总线上的推送也应该到达
    app.bus.publish({
      name: "event_batch",
      profileId: "claude-official",
      data: { profile_id: "claude-official", count: 3 },
    });
    while (!text.includes("event: event_batch")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("event: event_batch");

    // 心跳必须是具名事件 ping —— SSE 注释（": hb"）在 EventSource 里不触发任何回调，
    // 客户端就没法用它判断连接还活着
    while (!text.includes("event: ping")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("event: ping\ndata: {}");
    expect(text).not.toContain(": hb");

    controller.abort();
    await reader.cancel().catch(() => {});
  }, 15_000);

  it("still requires a bearer token", async () => {
    const addr = app.fastify.server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no address");
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/stream?profile_id=claude-official`);
    expect(res.status).toBe(401);
    await res.text();
  });
});
