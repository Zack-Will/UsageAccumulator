import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type UaApp } from "../src/app.js";
import { isScratchWorkspace } from "../src/aggregate.js";
import { MemoryStore } from "../src/store-memory.js";
import { AUTH, makeEvent, testConfig } from "./helpers.js";

const NOW = new Date("2026-09-23T08:00:00.000Z");
const SCRATCH =
  "-Users-me-Library-Application-Support-Claude-scratch-workspaces-org-user-scratch-2026-09-22-105cae";

let store: MemoryStore;
let app: UaApp;
let machineAuth: { authorization: string };
let machineId: string;

beforeEach(async () => {
  store = new MemoryStore();
  app = buildApp({ store, config: testConfig(), now: () => NOW });
  await app.fastify.ready();
  const res = await app.fastify.inject({
    method: "POST",
    url: "/v1/enroll",
    payload: { enroll_token: "enroll-token", hostname: "company-mac", os: "darwin" },
  });
  const body = res.json() as { machine_id: string; machine_token: string };
  machineAuth = { authorization: `Bearer ${body.machine_token}` };
  machineId = body.machine_id;
});
afterEach(async () => {
  await app.fastify.close();
});

async function seed(): Promise<void> {
  await store.insertEvents([
    // 临时工作区里的一个会话
    { event: makeEvent({ machineId, sessionId: "s-scratch", projectSlug: SCRATCH, ts: new Date("2026-09-23T07:00:00Z") }), costUsd: 1.5 },
    { event: makeEvent({ machineId, sessionId: "s-scratch", projectSlug: SCRATCH, ts: new Date("2026-09-23T07:10:00Z") }), costUsd: 2 },
    // 普通项目里的两个会话，一个有标题一个没有
    { event: makeEvent({ machineId, sessionId: "s-cleave", projectSlug: "-Users-me-Repos-Cleave", ts: new Date("2026-09-23T06:00:00Z") }), costUsd: 3 },
    { event: makeEvent({ machineId, sessionId: "s-untitled", projectSlug: "-Users-me-Repos-Cleave", ts: new Date("2026-09-23T06:30:00Z") }), costUsd: 0.5 },
  ]);
}

async function postTitles(sessions: { session_id: string; title: string }[], headers = machineAuth) {
  return app.fastify.inject({ method: "POST", url: "/v1/ingest/sessions", headers, payload: { sessions } });
}

async function dist(by: string) {
  const res = await app.fastify.inject({
    method: "GET",
    url: `/v1/distribution?profile_id=claude-official&by=${by}&from=2026-09-23T00:00:00Z`,
    headers: AUTH,
  });
  expect(res.statusCode).toBe(200);
  return res.json().buckets as Array<Record<string, unknown>>;
}

describe("POST /v1/ingest/sessions", () => {
  it("探针用 machine token 上报标题", async () => {
    const res = await postTitles([{ session_id: "s-scratch", title: "糖果形状口味组合问题" }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, received: 1, updated: 1 });
  });

  it("★ 看板身份（只读）不能写标题 —— 403 forbidden 而不是假装成功", async () => {
    const res = await postTitles([{ session_id: "s-scratch", title: "x" }], AUTH);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("同一个标题重复上报不算改动；改名后以新名字为准", async () => {
    await postTitles([{ session_id: "s-cleave", title: "Cleave" }]);
    const again = await postTitles([{ session_id: "s-cleave", title: "Cleave" }]);
    expect(again.json().updated).toBe(0);
    await postTitles([{ session_id: "s-cleave", title: "Cleave 架构图优化" }]);
    expect((await store.sessionTitles(["s-cleave"])).get("s-cleave")).toBe("Cleave 架构图优化");
  });

  it("空标题、超长标题、缺字段 → 400", async () => {
    expect((await postTitles([{ session_id: "s", title: "  " }])).statusCode).toBe(400);
    expect((await postTitles([{ session_id: "s", title: "x".repeat(301) }])).statusCode).toBe(400);
    expect((await postTitles([{ session_id: "", title: "x" }])).statusCode).toBe(400);
  });
});

describe("GET /v1/distribution?by=session", () => {
  it("每个会话一桶：有标题的带 label，并附上项目与机器", async () => {
    await seed();
    await postTitles([
      { session_id: "s-scratch", title: "糖果形状口味组合问题" },
      { session_id: "s-cleave", title: "Cleave 架构图优化" },
    ]);
    const buckets = await dist("session");
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    expect(byKey.get("s-scratch")?.label).toBe("糖果形状口味组合问题");
    expect(byKey.get("s-scratch")?.project_slug).toBe(SCRATCH);
    expect(byKey.get("s-scratch")?.machine_label).toBe("company-mac");
    expect(byKey.get("s-cleave")?.label).toBe("Cleave 架构图优化");
  });

  it("没有标题的会话不硬塞 label（前端自己兜底显示），但照样给项目与机器", async () => {
    await seed();
    const b = (await dist("session")).find((x) => x.key === "s-untitled")!;
    expect(b.label).toBeUndefined();
    expect(b.project_slug).toBe("-Users-me-Repos-Cleave");
  });
});

describe("GET /v1/distribution?by=session：桌面端恢复会话产生的分叉合成一行", () => {
  const LARK = "-Users-me-Repos-Lark";
  const at = (m: number) => new Date(Date.UTC(2026, 8, 23, 3, m));

  it("同标题 + 同项目 + 同机器：合到最早的 id 上，事件与费用相加", async () => {
    await store.insertEvents([
      { event: makeEvent({ machineId, sessionId: "fork-b", projectSlug: LARK, ts: at(20) }), costUsd: 2 },
      { event: makeEvent({ machineId, sessionId: "fork-a", projectSlug: LARK, ts: at(10) }), costUsd: 1 },
      { event: makeEvent({ machineId, sessionId: "fork-c", projectSlug: LARK, ts: at(30) }), costUsd: 4 },
    ]);
    await postTitles(["fork-a", "fork-b", "fork-c"].map((id) => ({ session_id: id, title: "手绘架构图转飞书画板" })));
    const rows = (await dist("session")).filter((b) => b.label === "手绘架构图转飞书画板");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "fork-a", events: 3, cost_usd: 7, session_count: 3, project_slug: LARK });
  });

  it("同名但不在同一个项目的不合并；没有标题的不合并", async () => {
    await store.insertEvents([
      { event: makeEvent({ machineId, sessionId: "x1", projectSlug: LARK, ts: at(1) }), costUsd: 1 },
      { event: makeEvent({ machineId, sessionId: "x2", projectSlug: "-Users-me-Repos-Other", ts: at(2) }), costUsd: 1 },
      { event: makeEvent({ machineId, sessionId: "u1", projectSlug: LARK, ts: at(3) }), costUsd: 1 },
      { event: makeEvent({ machineId, sessionId: "u2", projectSlug: LARK, ts: at(4) }), costUsd: 1 },
    ]);
    await postTitles([
      { session_id: "x1", title: "同名" },
      { session_id: "x2", title: "同名" },
    ]);
    const keys = (await dist("session")).map((b) => b.key).sort();
    expect(keys).toEqual(["u1", "u2", "x1", "x2"]);
  });
});

describe("GET /v1/distribution?by=project：临时工作区用会话标题命名", () => {
  it("★ 以前显示的是目录名的随机后缀「105cae」，现在是里面那个会话的标题", async () => {
    await seed();
    await postTitles([{ session_id: "s-scratch", title: "糖果形状口味组合问题" }]);
    const b = (await dist("project")).find((x) => x.key === SCRATCH)!;
    expect(b.label).toBe("糖果形状口味组合问题");
  });

  it("普通项目不受影响（名字由前端从目录名取）", async () => {
    await seed();
    await postTitles([{ session_id: "s-cleave", title: "Cleave 架构图优化" }]);
    const b = (await dist("project")).find((x) => x.key === "-Users-me-Repos-Cleave")!;
    expect(b.label).toBeUndefined();
  });

  it("临时工作区还没有标题时不给 label，而不是给个假名字", async () => {
    await seed();
    const b = (await dist("project")).find((x) => x.key === SCRATCH)!;
    expect(b.label).toBeUndefined();
  });
});

describe("isScratchWorkspace", () => {
  it("认得出桌面端的临时工作区目录", () => {
    expect(isScratchWorkspace(SCRATCH)).toBe(true);
    expect(isScratchWorkspace("-Users-me-Repos-Cleave")).toBe(false);
    expect(isScratchWorkspace(null)).toBe(false);
  });
});
