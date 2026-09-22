import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type UaApp } from "../src/app.js";
import { MemoryStore } from "../src/store-memory.js";
import { countsTowardQuota, parsePricingFile } from "../src/pricing.js";
import { AUTH, makeEvent, ndjson, testConfig, toWire } from "./helpers.js";

const NOW = new Date("2026-09-21T08:42:00.000Z");
const PRICE = {
  inputPerMTok: 15,
  outputPerMTok: 75,
  cacheReadPerMTok: 1.5,
  cacheWrite5mPerMTok: 18.75,
  cacheWrite1hPerMTok: 30,
};

let store: MemoryStore;
let app: UaApp;

function ingestBody(objs: Record<string, unknown>[], gzip = true): Buffer {
  const raw = Buffer.from(ndjson(objs));
  return gzip ? gzipSync(raw) : raw;
}

async function seedQuota(): Promise<void> {
  for (let i = 6; i >= 0; i--) {
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: new Date(NOW.getTime() - i * 5 * 60_000),
      windows: [
        {
          windowKind: "five_hour",
          utilizationPct: 62 - i * 2,
          resetsAt: new Date(NOW.getTime() + 108 * 60_000),
        },
        {
          windowKind: "seven_day",
          utilizationPct: 41 - i,
          resetsAt: new Date(NOW.getTime() + 3 * 24 * 3600_000),
        },
      ],
      raw: { five_hour: { utilization_pct: 62 } },
    });
  }
}

beforeEach(() => {
  store = new MemoryStore();
  app = buildApp({
    store,
    config: testConfig(),
    pricing: parsePricingFile({ "claude-opus-5": PRICE }).table,
    now: () => NOW,
  });
});

afterEach(async () => {
  await app.fastify.close();
});

describe("auth", () => {
  it("healthz needs no token", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("rejects missing and wrong bearer tokens with the contract error shape", async () => {
    const none = await app.fastify.inject({ method: "GET", url: "/v1/profiles" });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({
      error: { code: "unauthorized", message: "missing credentials" },
    });

    const wrong = await app.fastify.inject({
      method: "GET",
      url: "/v1/profiles",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("unknown routes return the contract error shape too", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/v1/nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
    // not_found 专指路由/资源不存在；用 bad_request 会让人以为是参数错了
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("POST /v1/enroll", () => {
  it("swaps a valid enroll token for a machine token that then authenticates", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: { enroll_token: "enroll-token", hostname: "mbp", os: "darwin" },
    });
    expect(res.statusCode).toBe(200);
    const { machine_id, machine_token } = res.json() as {
      machine_id: string;
      machine_token: string;
    };
    expect(machine_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(machine_token).toHaveLength(64);
    // 明文 token 绝不入库，只留 sha256
    expect([...store.machines.values()][0]!.tokenSha256).not.toBe(machine_token);

    const ok = await app.fastify.inject({
      method: "GET",
      url: "/v1/profiles",
      headers: { authorization: `Bearer ${machine_token}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects a wrong enroll token", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: { enroll_token: "wrong-token-xx", hostname: "h", os: "linux" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("keeps provisional_machine_id for tracing but never adopts it as the id", async () => {
    const provisional = "11111111-2222-3333-4444-555555555555";
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: {
        enroll_token: "enroll-token",
        hostname: "mbp",
        os: "darwin",
        provisional_machine_id: provisional,
      },
    });
    const { machine_id } = res.json() as { machine_id: string };
    // 服务端是权威（§2.3）：下发的 id 必须是服务端生成的，不能是客户端挑的
    expect(machine_id).not.toBe(provisional);
    expect([...store.machines.values()][0]!.provisionalMachineId).toBe(provisional);
  });

  it("tells a revoked machine apart from a bad token", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: { enroll_token: "enroll-token", hostname: "h", os: "linux" },
    });
    const { machine_id, machine_token } = res.json() as {
      machine_id: string;
      machine_token: string;
    };
    store.machines.get(machine_id)!.revokedAt = new Date();

    const after = await app.fastify.inject({
      method: "GET",
      url: "/v1/profiles",
      headers: { authorization: `Bearer ${machine_token}` },
    });
    // 403 + machine_revoked 让探针知道要重新 enroll，而不是以为服务端配置错了
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe("machine_revoked");
  });

  it("only ever uses the contract's error.code vocabulary", async () => {
    const allowed = [
      "bad_request",
      "unauthorized",
      "machine_revoked",
      "not_found",
      "rate_limited",
      "internal",
    ];
    const cases = await Promise.all([
      app.fastify.inject({ method: "GET", url: "/v1/profiles" }),
      app.fastify.inject({ method: "GET", url: "/v1/nope", headers: AUTH }),
      app.fastify.inject({
        method: "POST",
        url: "/v1/enroll",
        payload: { enroll_token: "wrong-token-xx" },
      }),
      app.fastify.inject({
        method: "POST",
        url: "/v1/ingest/quota",
        headers: AUTH,
        payload: { profile_id: "p", captured_at: "nope" },
      }),
    ]);
    for (const res of cases) {
      expect(allowed).toContain(res.json().error.code);
      expect(typeof res.json().error.message).toBe("string");
    }
  });
});

describe("POST /v1/ingest/events", () => {
  it("accepts gzip NDJSON and reports accepted/deduped", async () => {
    const a = makeEvent();
    const b = makeEvent();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload: ingestBody([toWire(a), toWire(b)]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 2, deduped: 0 });
  });

  it("is idempotent across batches — the ssh double-report gets eaten", async () => {
    const e = makeEvent();
    const post = (machineId: string) =>
      app.fastify.inject({
        method: "POST",
        url: "/v1/ingest/events",
        headers: { ...AUTH, "content-type": "application/x-ndjson" },
        payload: ingestBody([toWire({ ...e, machineId })]),
      });
    expect((await post("machine-a")).json()).toMatchObject({ accepted: 1, deduped: 0 });
    // 同一次请求由第二台机器再上报一次：(message_id, request_id) 吃掉
    expect((await post("machine-b")).json()).toMatchObject({ accepted: 0, deduped: 1 });
    expect(store.events.size).toBe(1);
  });

  it("counts in-batch duplicates as deduped", async () => {
    const e = makeEvent();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload: ingestBody([toWire(e), toWire(e), toWire(e)]),
    });
    expect(res.json()).toMatchObject({ accepted: 1, deduped: 2 });
  });

  it("accepts uncompressed NDJSON too", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload: ingestBody([toWire(makeEvent())], false),
    });
    expect(res.json()).toMatchObject({ accepted: 1 });
  });

  it("stores null cost for unpriced models and a real cost for priced ones", async () => {
    await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload: ingestBody([
        toWire(makeEvent({ model: "claude-opus-5" })),
        toWire(makeEvent({ model: "claude-fable-5-1" })),
        toWire(makeEvent({ model: "<synthetic>" })),
      ]),
    });
    const costs = [...store.events.values()].map((r) => ({ model: r.event.model, cost: r.costUsd }));
    expect(costs.find((c) => c.model === "claude-opus-5")!.cost).toBeGreaterThan(0);
    expect(costs.find((c) => c.model === "claude-fable-5-1")!.cost).toBeNull();
    // 合成事件永远不计费
    expect(costs.find((c) => c.model === "<synthetic>")!.cost).toBeNull();
  });

  it("auto-registers unseen profiles so ingest never fails on a new profile", async () => {
    await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload: ingestBody([toWire(makeEvent({ profileId: "gw-openrouter" }))]),
    });
    expect((await store.listProfiles()).map((p) => p.id)).toContain("gw-openrouter");
  });

  it("skips malformed lines instead of failing the batch", async () => {
    const payload = Buffer.concat([
      Buffer.from("{oops\n"),
      Buffer.from(ndjson([toWire(makeEvent())])),
    ]);
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload,
    });
    expect(res.json()).toMatchObject({ accepted: 1, invalid: 1 });
  });

  it("publishes an event_batch on the bus for SSE subscribers", async () => {
    const seen: unknown[] = [];
    app.bus.subscribe((e) => seen.push(e));
    await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload: ingestBody([toWire(makeEvent())]),
    });
    expect(seen).toContainEqual({
      name: "event_batch",
      profileId: "claude-official",
      data: {
        profile_id: "claude-official",
        count: 1,
        // last_ts 让前端知道数据推进到哪一刻了，而不是只知道「来了 N 条」
        last_ts: new Date("2026-09-21T06:00:00.000Z").toISOString(),
      },
    });
  });
});

describe("POST /v1/ingest/quota", () => {
  it("stores the snapshot verbatim and returns {ok:true}", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/quota",
      headers: AUTH,
      payload: {
        profile_id: "claude-official",
        captured_at: NOW.toISOString(),
        windows: [
          { window_kind: "five_hour", utilization_pct: 62, resets_at: "2026-09-21T10:30:00Z" },
        ],
        raw: { five_hour: { utilization_pct: 62 } },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(store.quota[0]!.snapshot.raw).toEqual({ five_hour: { utilization_pct: 62 } });
  });

  it("records the collecting machine_id so a snapshot's origin stays traceable", async () => {
    await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/quota",
      headers: AUTH,
      payload: {
        profile_id: "claude-official",
        machine_id: "9f2c1a7e-0000-0000-0000-000000000000",
        captured_at: NOW.toISOString(),
        windows: [{ window_kind: "five_hour", utilization_pct: 62 }],
        raw: {},
      },
    });
    expect(store.quota[0]!.machineId).toBe("9f2c1a7e-0000-0000-0000-000000000000");
  });

  it("rejects a percentage outside 0..100", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/quota",
      headers: AUTH,
      payload: {
        profile_id: "p",
        captured_at: NOW.toISOString(),
        windows: [{ window_kind: "five_hour", utilization_pct: 620 }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });
});

describe("GET /v1/windows/current", () => {
  beforeEach(seedQuota);

  it("returns the contract §2.1 shape with projections in percentage terms", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/windows/current?profile_id=claude-official",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile_id).toBe("claude-official");
    const five = body.windows.find((w: { window_kind: string }) => w.window_kind === "five_hour");
    expect(five.utilization_pct).toBe(62);
    expect(five.resets_at).toBe(new Date(NOW.getTime() + 108 * 60_000).toISOString());
    expect(five.starts_at).toBe(
      new Date(NOW.getTime() + 108 * 60_000 - 5 * 3600_000).toISOString(),
    );
    // 速率 2% / 5min = 0.4 %/min
    expect(five.rate_pct_per_min).toBeCloseTo(0.4, 6);
    expect(five.projected_pct.mid).toBeGreaterThan(62);
    expect(five.projected_pct.p25).toBeLessThanOrEqual(five.projected_pct.p75);
    expect(five.burn_curve.length).toBeGreaterThan(0);
    expect(five.captured_at).toBe(NOW.toISOString());
    expect(five.stale).toBe(false);
  });

  it("把「本地没动静时涨的额度」单独归因出来，并给出扣掉它之后的本地占比", async () => {
    // seedQuota 的 five_hour 是 50→62，每 5 分钟 +2，一个本地事件都没有
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/windows/current?profile_id=claude-official",
      headers: AUTH,
    });
    const five = res.json().windows.find((w: { window_kind: string }) => w.window_kind === "five_hour");
    // 窗口开头没采到（第一个采样点已经是 50%）→ 覆盖不完整
    expect(five.attribution.unobserved_pct).toBe(50);
    expect(five.attribution.usable).toBe(false);
    // 但下界照样合法、照样用来修分母：12 个点全是在无本地活动时涨的
    expect(five.attribution.other_pct_lower_bound).toBe(12);
    expect(five.attribution.quiet_spans).toBe(6);
    expect(five.attribution.local_utilization_pct).toBe(62 - 12);
  });

  it("窗口内有本地事件时，那段上升算「判不了」而不是算到别处头上", async () => {
    // 在每个采样区间里都塞一条事件，护栏内一律 ambiguous
    for (let i = 6; i >= 0; i--) {
      await store.insertEvents([
        {
          event: makeEvent({
            messageId: `m-attr-${i}`,
            ts: new Date(NOW.getTime() - i * 5 * 60_000 - 60_000),
            model: "claude-opus-5",
          }),
          costUsd: null,
        },
      ]);
    }
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/windows/current?profile_id=claude-official",
      headers: AUTH,
    });
    const five = res.json().windows.find((w: { window_kind: string }) => w.window_kind === "five_hour");
    expect(five.attribution.other_pct_lower_bound).toBe(0);
    expect(five.attribution.ambiguous_pct).toBe(12);
  });

  it("tags every burn_curve point with its source so nothing passes as official by accident", () => {
    return app.fastify
      .inject({
        method: "GET",
        url: "/v1/windows/current?profile_id=claude-official",
        headers: AUTH,
      })
      .then((res) => {
        const five = res
          .json()
          .windows.find((w: { window_kind: string }) => w.window_kind === "five_hour");
        expect(five.burn_curve.length).toBeGreaterThan(1);
        // v1 只有官方快照点；插值尚未实现，实现后必须标 "interpolated"
        for (const p of five.burn_curve) {
          expect(p.source).toBe("official");
          expect(Object.keys(p).sort()).toEqual(["pct", "source", "ts"]);
        }
      });
  });

  it("gives an exhaust ETA when the current rate hits 100% before the reset", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/windows/current?profile_id=claude-official",
      headers: AUTH,
    });
    const five = res
      .json()
      .windows.find((w: { window_kind: string }) => w.window_kind === "five_hour");
    // (100-62)/0.4 = 95min < 108min 剩余 → 会耗尽
    expect(new Date(five.exhaust_eta).getTime()).toBe(NOW.getTime() + 95 * 60_000);
  });

  it("marks a stale profile when no snapshot arrived recently", async () => {
    store.quota.length = 0;
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: new Date(NOW.getTime() - 60 * 60_000),
      windows: [{ windowKind: "five_hour", utilizationPct: 5, resetsAt: null }],
      raw: {},
    });
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/windows/current?profile_id=claude-official",
      headers: AUTH,
    });
    expect(res.json().windows[0].stale).toBe(true);
  });

  it("reports the local window offset once events exist", async () => {
    await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload: ingestBody([
        toWire(makeEvent({ ts: new Date(NOW.getTime() - 60 * 60_000) })),
      ]),
    });
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/windows/current?profile_id=claude-official",
      headers: AUTH,
    });
    const five = res
      .json()
      .windows.find((w: { window_kind: string }) => w.window_kind === "five_hour");
    // §2.1：四个重叠度指标都在 metrics 里，local_window_offset_min 也在其中
    expect(typeof five.metrics.local_window_offset_min).toBe("number");
    // 比例字段一律 _pct 结尾、0..100（CONTRACT §4）
    expect(five.metrics).toHaveProperty("multi_machine_overlap_pct");
    expect(five.metrics).toHaveProperty("session_cut_rate_pct");
    expect(five.metrics).toHaveProperty("window_waste_pct");
    expect(five.metrics).not.toHaveProperty("multi_machine_overlap");
    expect(five.metrics).not.toHaveProperty("session_cut_rate");
    expect(five.metrics.window_waste_pct).toBe(38);
  });

  it("leaves metrics null for the 7d window (the block algorithm is a 5h notion)", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/windows/current?profile_id=claude-official",
      headers: AUTH,
    });
    const seven = res
      .json()
      .windows.find((w: { window_kind: string }) => w.window_kind === "seven_day");
    expect(seven.metrics).toBeNull();
  });

  it("requires profile_id when several profiles exist", async () => {
    await store.ensureProfiles(["another"]);
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/windows/current",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });
});

describe("GET /v1/summary", () => {
  const summary = () =>
    app.fastify.inject({
      method: "GET",
      url: "/v1/summary?profile_id=claude-official",
      headers: AUTH,
    });

  beforeEach(seedQuota);

  it("matches CONTRACT §2.2 exactly — no more, no fewer top-level keys", async () => {
    const body = (await summary()).json();
    expect(Object.keys(body).sort()).toEqual([
      "captured_at",
      "dashboard_url",
      "profile_id",
      "rate_pct_per_min",
      "soonest_exhaust",
      "stale",
      "tray_title_pct",
      "windows",
    ]);
    expect(Object.keys(body.windows[0]).sort()).toEqual([
      "exhaust_eta",
      "label",
      "pct",
      "projected_pct",
      "resets_at",
      "window_kind",
    ]);
  });

  it("echoes profile_id so a misconfigured client cannot read someone else's numbers", async () => {
    expect((await summary()).json().profile_id).toBe("claude-official");

    // 配了一个不存在的 profile：回显该 id + 空窗口 + stale，而不是静默返回默认 profile
    const other = await app.fastify.inject({
      method: "GET",
      url: "/v1/summary?profile_id=typo-profile",
      headers: AUTH,
    });
    expect(other.json().profile_id).toBe("typo-profile");
    expect(other.json().windows).toEqual([]);
    expect(other.json().stale).toBe(true);
    expect(other.json().tray_title_pct).toBe("--%");
    expect(other.json().captured_at).toBeNull();
  });

  it("renders only the percentage in tray_title_pct — the countdown is the client's job", async () => {
    const body = (await summary()).json();
    expect(body.tray_title_pct).toBe("62%");
    expect(body.tray_title_pct).not.toContain("·");
    expect(body).not.toHaveProperty("tray_title");
  });

  it("carries a stable window_kind key alongside the display label", async () => {
    const body = (await summary()).json();
    expect(body.windows.map((w: { window_kind: string }) => w.window_kind)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(body.windows.map((w: { label: string }) => w.label)).toEqual(["5h", "7d"]);
    expect(body.windows[0].pct).toBe(62);
    expect(body.windows[0].projected_pct).toBeGreaterThan(62);
  });

  it("puts exhaust_eta on each window and names the soonest one at the top level", async () => {
    const body = (await summary()).json();
    const five = body.windows[0];
    const seven = body.windows[1];
    // 5h: (100-62)/0.4 = 95min < 108min 剩余 → 会耗尽
    expect(new Date(five.exhaust_eta).getTime()).toBe(NOW.getTime() + 95 * 60_000);
    // 7d 走日历模式（§7.2）：41% 花了 4 天，剩 3 天推不到 100%，所以本窗口打不满。
    // 线性外推会拿「最近 30 分钟的速率」去乘 3 天，得出 295 分钟后耗尽 —— 正是 §7.2 警告的系统性高估。
    expect(seven.exhaust_eta).toBeNull();
    // 只有一个窗口会耗尽时，顶层就指向它
    expect(body.soonest_exhaust).toEqual({
      window_kind: "five_hour",
      eta: five.exhaust_eta,
    });
  });

  it("trays the window that will bite first, not simply the shortest one", async () => {
    store.quota.length = 0;
    for (let i = 6; i >= 0; i--) {
      await store.insertQuotaSnapshot({
        profileId: "claude-official",
        capturedAt: new Date(NOW.getTime() - i * 5 * 60_000),
        windows: [
          // 5h 一直没动 → 不会耗尽
          {
            windowKind: "five_hour",
            utilizationPct: 10,
            resetsAt: new Date(NOW.getTime() + 60 * 60_000),
          },
          // 7d 涨得很凶 → 半小时后打满
          {
            windowKind: "seven_day",
            utilizationPct: 88 - i * 0.5,
            resetsAt: new Date(NOW.getTime() + 2 * 24 * 3600_000),
          },
        ],
        raw: {},
      });
    }
    const body = (await summary()).json();
    expect(body.soonest_exhaust.window_kind).toBe("seven_day");
    // 托盘显示 7d 的 88%，而不是排在前面的 5h 的 10%
    expect(body.tray_title_pct).toBe("88%");
    // 列表顺序仍按窗口长度，客户端的排序 key 不受影响
    expect(body.windows.map((w: { window_kind: string }) => w.window_kind)).toEqual([
      "five_hour",
      "seven_day",
    ]);
  });

  it("returns soonest_exhaust null when no window will be exhausted", async () => {
    store.quota.length = 0;
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: NOW,
      windows: [
        { windowKind: "five_hour", utilizationPct: 3, resetsAt: new Date(NOW.getTime() + 60_000) },
      ],
      raw: {},
    });
    const body = (await summary()).json();
    expect(body.soonest_exhaust).toBeNull();
    expect(body.windows[0].exhaust_eta).toBeNull();
    // 没有窗口会耗尽时，托盘退回最短窗口的百分比
    expect(body.tray_title_pct).toBe("3%");
  });

  it("reports captured_at as the snapshot time, not the request time", async () => {
    const body = (await summary()).json();
    expect(body.captured_at).toBe(NOW.toISOString());
    expect(body.stale).toBe(false);

    // 快照老了：captured_at 仍是采集时刻，stale 翻转
    store.quota.length = 0;
    const old = new Date(NOW.getTime() - 23 * 60_000);
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: old,
      windows: [{ windowKind: "five_hour", utilizationPct: 62, resetsAt: NOW }],
      raw: {},
    });
    const stale = (await summary()).json();
    expect(stale.captured_at).toBe(old.toISOString());
    expect(stale.stale).toBe(true);
  });

  it("takes the oldest captured_at so 'data is N minutes old' matches the stale flag", async () => {
    store.quota.length = 0;
    const old = new Date(NOW.getTime() - 40 * 60_000);
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: old,
      windows: [{ windowKind: "seven_day", utilizationPct: 41, resetsAt: NOW }],
      raw: {},
    });
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: NOW,
      windows: [{ windowKind: "five_hour", utilizationPct: 62, resetsAt: NOW }],
      raw: {},
    });
    const body = (await summary()).json();
    // 一新一旧 → stale 为真，captured_at 必须跟着最旧的那份，否则客户端会谎报新鲜度
    expect(body.stale).toBe(true);
    expect(body.captured_at).toBe(old.toISOString());
  });
});

describe("GET /v1/timeline and /v1/distribution", () => {
  beforeEach(async () => {
    await seedQuota();
    await app.fastify.inject({
      method: "POST",
      url: "/v1/ingest/events",
      headers: { ...AUTH, "content-type": "application/x-ndjson" },
      payload: ingestBody([
        // 同一分钟里两台机器都在烧 → 落进同一个重叠桶
        toWire(makeEvent({ ts: new Date(NOW.getTime() - 30 * 60_000), machineId: "a" })),
        toWire(makeEvent({ ts: new Date(NOW.getTime() - 30 * 60_000), machineId: "b" })),
        toWire(
          makeEvent({
            ts: new Date(NOW.getTime() - 10 * 60_000),
            machineId: "a",
            model: "<synthetic>",
          }),
        ),
      ]),
    });
  });

  it("returns one lane per machine plus the §7.5 metrics", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/timeline?profile_id=claude-official",
      headers: AUTH,
    });
    const body = res.json();
    expect(body.lanes.map((l: { machine_id: string }) => l.machine_id)).toEqual(["a", "b"]);
    // <synthetic> 不进泳道
    expect(body.lanes.find((l: { machine_id: string }) => l.machine_id === "a").events).toBe(1);
    expect(Object.keys(body.metrics).sort()).toEqual([
      "local_window_offset_min",
      "multi_machine_overlap_pct",
      "session_cut_rate_pct",
      "window_waste_pct",
    ]);
    // 300 分钟的窗口里有 1 分钟是两台机器同时在烧 = 1/300。
    // 线格式是 0..100，所以必须是 0.333…，不是 core 原样返回的 0.00333…
    expect(body.metrics.multi_machine_overlap_pct).toBeCloseTo(100 / 300, 9);
    expect(body.metrics.session_cut_rate_pct).toBeGreaterThanOrEqual(0);
    expect(body.metrics.session_cut_rate_pct).toBeLessThanOrEqual(100);
    expect(body.window_boundaries.length).toBeGreaterThan(0);
  });

  it("aggregates by machine / model / project / hour", async () => {
    for (const by of ["machine", "model", "project", "hour"]) {
      const res = await app.fastify.inject({
        method: "GET",
        url: `/v1/distribution?profile_id=claude-official&by=${by}`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().by).toBe(by);
      expect(res.json().buckets.length).toBeGreaterThan(0);
    }
  });

  it("keeps <synthetic> out of the distribution and flags unpriced events", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/distribution?profile_id=claude-official&by=model",
      headers: AUTH,
    });
    const keys = res.json().buckets.map((b: { key: string }) => b.key);
    expect(keys).not.toContain("<synthetic>");
    expect(res.json().buckets[0].cost_usd).toBeGreaterThan(0);
  });

  it("labels lanes with the enrolled hostname, falling back to the id", async () => {
    await store.createMachine({
      id: "a",
      provisionalMachineId: null,
      hostname: "mbp-local",
      os: "darwin",
      tokenSha256: "aaa",
    });
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/timeline?profile_id=claude-official",
      headers: AUTH,
    });
    const lanes = res.json().lanes as { machine_id: string; machine_label: string }[];
    expect(lanes.find((l) => l.machine_id === "a")!.machine_label).toBe("mbp-local");
    // b 没 enroll 过 → 退回 id，而不是显示空串
    expect(lanes.find((l) => l.machine_id === "b")!.machine_label).toBe("b");
  });

  it("buckets by attribution level so 归属可信度 is visible", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/distribution?profile_id=claude-official&by=attribution",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().by).toBe("attribution");
    expect(res.json().buckets.map((b: { key: string }) => b.key)).toEqual(["timeline"]);
  });

  it("omits series unless bucket is requested", async () => {
    const none = await app.fastify.inject({
      method: "GET",
      url: "/v1/distribution?profile_id=claude-official&by=machine",
      headers: AUTH,
    });
    expect(none.json().bucket).toBe("none");
    expect(none.json().buckets[0]).not.toHaveProperty("series");

    const hourly = await app.fastify.inject({
      method: "GET",
      url: "/v1/distribution?profile_id=claude-official&by=machine&bucket=hour",
      headers: AUTH,
    });
    expect(hourly.json().bucket).toBe("hour");
    const bucket = hourly.json().buckets[0];
    expect(bucket.series.length).toBeGreaterThan(0);
    expect(Object.keys(bucket.series[0]).sort()).toEqual([
      "cost_usd",
      "events",
      "total_tokens",
      "ts",
      "unpriced_events",
    ]);
    // series 的事件数必须与桶总数对得上，否则堆叠柱和总量会打架
    expect(
      bucket.series.reduce((s: number, p: { events: number }) => s + p.events, 0),
    ).toBe(bucket.events);
    // 成本同理：逐点求和必须等于桶成本，否则「费用趋势」与「总费用」会对不上。
    // 缺价点的 cost_usd 是 null（不是 0），求和时跳过 —— 与桶的口径一致。
    const seriesCost = bucket.series.reduce(
      (s: number | null, p: { cost_usd: number | null }) =>
        p.cost_usd === null ? s : (s ?? 0) + p.cost_usd,
      null as number | null,
    );
    if (bucket.cost_usd === null) expect(seriesCost).toBeNull();
    else expect(seriesCost).toBeCloseTo(bucket.cost_usd, 9);
    expect(
      bucket.series.reduce((s: number, p: { unpriced_events: number }) => s + p.unpriced_events, 0),
    ).toBe(bucket.unpriced_events);
  });

  it("keys by=hour on the full RFC3339 hour, not a 0..23 index", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/distribution?profile_id=claude-official&by=hour",
      headers: AUTH,
    });
    for (const b of res.json().buckets as { key: string }[]) {
      // 热力图靠它分星期几
      expect(b.key).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);
    }
  });

  it("rejects an unknown by/bucket value", async () => {
    for (const url of [
      "/v1/distribution?profile_id=claude-official&by=nonsense",
      "/v1/distribution?profile_id=claude-official&bucket=minute",
    ]) {
      const res = await app.fastify.inject({ method: "GET", url, headers: AUTH });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects an inverted range", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: `/v1/distribution?profile_id=claude-official&from=${NOW.toISOString()}&to=2026-01-01T00:00:00Z`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });
});

describe("GET /v1/windows/current > projected_curve", () => {
  beforeEach(seedQuota);

  const windows = async () =>
    (
      await app.fastify.inject({
        method: "GET",
        url: "/v1/windows/current?profile_id=claude-official",
        headers: AUTH,
      })
    ).json().windows as Record<string, never>[];

  it("runs from now to the window end and lands exactly on projected_pct", async () => {
    const five = (await windows()).find(
      (w: Record<string, never>) => w["window_kind"] === "five_hour",
    )! as unknown as {
      projected_pct: { p25: number; mid: number; p75: number };
      projected_curve: { ts: string; p25: number; mid: number; p75: number }[];
      resets_at: string;
      utilization_pct: number;
    };
    const curve = five.projected_curve;
    expect(curve.length).toBeGreaterThan(2);
    expect(curve[0]!.ts).toBe(NOW.toISOString());
    expect(curve[0]!.mid).toBe(five.utilization_pct);
    expect(curve[curve.length - 1]!.ts).toBe(five.resets_at);
    // 终点与 projected_pct 必须完全一致，否则前端会看到曲线和数字打架
    expect(curve[curve.length - 1]!.mid).toBeCloseTo(five.projected_pct.mid, 9);
    expect(curve[curve.length - 1]!.p25).toBeCloseTo(five.projected_pct.p25, 9);
    expect(curve[curve.length - 1]!.p75).toBeCloseTo(five.projected_pct.p75, 9);
    for (const p of curve) {
      expect(Object.keys(p).sort()).toEqual(["mid", "p25", "p75", "ts"]);
      expect(p.p25).toBeLessThanOrEqual(p.p75);
    }
  });

  it("is linear for the 5h window (§7.1)", async () => {
    const five = (await windows()).find(
      (w: Record<string, never>) => w["window_kind"] === "five_hour",
    )! as unknown as {
      projected_curve: { ts: string; mid: number }[];
      utilization_pct: number;
    };
    const c = five.projected_curve;
    const half = c[Math.floor((c.length - 1) / 2)]!;
    const end = c[c.length - 1]!;
    const midpoint = five.utilization_pct + (end.mid - five.utilization_pct) / 2;
    expect(half.mid).toBeCloseTo(midpoint, 1);
  });

  it("does not straight-line the 7d window — it uses the calendar model (§7.2)", async () => {
    const seven = (await windows()).find(
      (w: Record<string, never>) => w["window_kind"] === "seven_day",
    )! as unknown as {
      projected_pct: { mid: number };
      projected_curve: { mid: number }[];
      rate_pct_per_min: number;
    };
    // 41% 用了 4 天，剩 3 天 → 41/4*3 = 30.75 的增量，终点 71.75。
    // 线性外推最近 30 分钟的 0.2 %/min 会给出 41 + 0.2*4320 = 100（打满），高得离谱。
    expect(seven.projected_pct.mid).toBeCloseTo(71.75, 6);
    expect(seven.projected_curve[seven.projected_curve.length - 1]!.mid).toBeCloseTo(71.75, 6);
    expect(seven.rate_pct_per_min).toBeCloseTo(30.75 / (3 * 24 * 60), 9);
  });
});

describe("GET /v1/machines", () => {
  it("lists machines with a readable label", async () => {
    await store.createMachine({
      id: "m-1",
      provisionalMachineId: null,
      hostname: "mbp-local",
      os: "darwin",
      tokenSha256: "aaa",
    });
    await store.createMachine({
      id: "m-2",
      provisionalMachineId: null,
      hostname: "",
      os: "linux",
      tokenSha256: "bbb",
    });
    store.machines.get("m-2")!.revokedAt = new Date();

    const res = await app.fastify.inject({ method: "GET", url: "/v1/machines", headers: AUTH });
    expect(Object.keys(res.json())).toEqual(["machines"]);
    expect(res.json().machines).toEqual([
      {
        machine_id: "m-1",
        label: "mbp-local",
        hostname: "mbp-local",
        os: "darwin",
        last_seen_at: null,
        revoked: false,
      },
      {
        // 没有 hostname 就退回 machine_id，不做前 8 位截断
        machine_id: "m-2",
        label: "m-2",
        hostname: "",
        os: "linux",
        last_seen_at: null,
        // 吊销的机器照样列出来，带标记 —— 隐藏它会让人以为机器凭空消失了
        revoked: true,
      },
    ]);
  });
});

describe("GET /v1/profiles and /v1/calibration", () => {
  it("lists profiles in the wire shape", async () => {
    await store.ensureProfiles(["claude-official"]);
    const res = await app.fastify.inject({ method: "GET", url: "/v1/profiles", headers: AUTH });
    // 顶层是 { profiles: [...] }，且键是 id 不是 profile_id
    expect(Object.keys(res.json())).toEqual(["profiles"]);
    expect(Object.keys(res.json().profiles[0]).sort()).toEqual([
      "account_uuid",
      "base_url",
      "id",
      "kind",
      "label",
      "plan",
    ]);
    expect(res.json().profiles[0]).toMatchObject({ id: "claude-official", kind: "oauth" });
  });

  it("returns an empty calibration list while still calibrating", async () => {
    await store.ensureProfiles(["claude-official"]);
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/calibration?profile_id=claude-official",
      headers: AUTH,
    });
    expect(res.json()).toEqual({ profile_id: "claude-official", calibrations: [] });
  });
});

describe("distribution bucket label（CONTRACT §2.1a）", () => {
  it("by=machine 的 bucket 带可读 label，key 仍是 machine_id", async () => {
    await store.createMachine({
      id: "machine-a", provisionalMachineId: null,
      hostname: "mbp-local", os: "darwin", tokenSha256: "x",
    });
    await store.insertEvents([{ event: makeEvent({ machineId: "machine-a" }), costUsd: null }]);
    const r = await app.fastify.inject({
      method: "GET", url: "/v1/distribution?profile_id=claude-official&by=machine", headers: AUTH,
    });
    expect(r.statusCode).toBe(200);
    const b = (r.json() as { buckets: { key: string; label?: string }[] }).buckets[0]!;
    // key 必须是稳定 id —— 分类色板按它登记，主机改名不该让全图颜色乱跳
    expect(b.key).toBe("machine-a");
    expect(b.label).toBe("mbp-local");
  });

  it("没有可读名时不硬塞 label（前端退回显示 key）", async () => {
    await store.insertEvents([{ event: makeEvent({ machineId: "no-name" }), costUsd: null }]);
    const r = await app.fastify.inject({
      method: "GET", url: "/v1/distribution?profile_id=claude-official&by=machine", headers: AUTH,
    });
    const b = (r.json() as { buckets: { key: string; label?: string }[] }).buckets[0]!;
    expect(b.key).toBe("no-name");
    expect(b.label).toBeUndefined();
  });
});

describe("看板静态托管（ARCHITECTURE §3：与 API 同源）", () => {
  it("未配置 UA_WEB_DIR 时根路径是契约错误形状的 404，不是崩溃", async () => {
    const r = await app.fastify.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("目录不存在时只告警、不影响 API", async () => {
    const bad = buildApp({
      store: new MemoryStore(),
      config: { ...testConfig(), webDir: "/definitely/not/here" },
      now: () => NOW,
    });
    await bad.fastify.ready();
    const r = await bad.fastify.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    await bad.fastify.close();
  });
});

describe("非 Anthropic 模型不计入额度", () => {
  it("Claude 家族全部计入，包括裸家族名与将来的新型号", () => {
    for (const m of [
      "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5-20251001",
      "opus", "fable-9", "sonnet-7-pro", "claude-未来型号",
    ]) {
      expect(countsTowardQuota(m), m).toBe(true);
    }
  });

  it("套壳路由到的第三方模型不计入", () => {
    // 公司 Mac 上实测到 qwen3.7-plus：那些 token 不消耗 Claude 额度
    for (const m of ["qwen3.7-plus", "gpt-5", "gemini-3-pro", "deepseek-v4", ""]) {
      expect(countsTowardQuota(m), m).toBe(false);
    }
  });

  it("<synthetic> 仍然排除", () => {
    expect(countsTowardQuota("<synthetic>")).toBe(false);
  });
});

describe("GET /v1/quota/history", () => {
  it("按区间返回原始百分比序列，用于按周回看", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/quota/history?profile_id=claude-official&window_kind=seven_day",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window_kind).toBe("seven_day");
    expect(Array.isArray(body.samples)).toBe(true);
    for (const x of body.samples) {
      expect(Object.keys(x).sort()).toEqual(["ts", "utilization_pct"]);
      // 契约 §4：百分比一律 0..100
      expect(x.utilization_pct).toBeGreaterThanOrEqual(0);
      expect(x.utilization_pct).toBeLessThanOrEqual(100);
    }
  });

  it("区间颠倒时是 400，不是 5xx", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/v1/quota/history?profile_id=claude-official&from=2026-09-10T00:00:00Z&to=2026-09-01T00:00:00Z",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });
});
