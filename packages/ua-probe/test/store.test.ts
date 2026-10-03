import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProbeStore } from "../src/store.js";

function rows(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    dedupKey: `k${i + offset}`,
    payload: JSON.stringify({ i: i + offset }),
    backfill: false,
    rank: 0,
  }));
}

describe("ProbeStore / 缓冲队列", () => {
  it("入队后取出，ack 之后才真正删除", () => {
    const s = new ProbeStore(":memory:");
    expect(s.enqueueEvents(rows(3))).toBe(3);
    expect(s.queueDepth()).toBe(3);

    const batch = s.takeEvents(2);
    expect(batch.map((b) => b.dedupKey)).toEqual(["k0", "k1"]);
    // 还没 ack：仍在队列里（模拟上报失败 / 进程被杀）
    expect(s.queueDepth()).toBe(3);

    s.ackEvents(batch.map((b) => b.id));
    expect(s.queueDepth()).toBe(1);
    expect(s.takeEvents(10)[0]?.dedupKey).toBe("k2");
    s.close();
  });

  it("dedup_key 重复不会二次入队（游标回滚重读时本地就吃掉）", () => {
    const s = new ProbeStore(":memory:");
    expect(s.enqueueEvents(rows(3))).toBe(3);
    expect(s.enqueueEvents(rows(3))).toBe(0);
    expect(s.queueDepth()).toBe(3);
    s.close();
  });

  it("同一个键再来：用量更完整（rank 更大）就替换负载，否则不动", () => {
    const s = new ProbeStore(":memory:");
    const row = (out: number, rank: number) => ({
      dedupKey: "msg|req",
      payload: JSON.stringify({ output_tokens: out }),
      backfill: false,
      rank,
    });
    // 子代理的一条消息：前几行是流式中途值，最后一行才是最终用量
    expect(s.enqueueEvents([row(7, 22), row(7, 22), row(1500, 4502)])).toBe(2);
    expect(s.enqueueEvents([row(7, 22)])).toBe(0);
    const [only, ...rest] = s.takeEvents(10);
    expect(rest).toEqual([]);
    expect(JSON.parse(only!.payload)).toEqual({ output_tokens: 1500 });
    s.close();
  });

  it("老库补 usage_rank 列，并按已排队负载的 output_tokens 估分", () => {
    const dir = mkdtempSync(join(tmpdir(), "ua-store-"));
    const path = join(dir, "state.db");
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE event_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, dedup_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, backfill INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
      old.prepare("INSERT INTO event_queue (dedup_key, payload, created_at) VALUES (?, ?, 0)")
        .run("msg|req", JSON.stringify({ output_tokens: 1500 }));
      old.close();

      const s = new ProbeStore(path);
      // 排队中的最终值不能被一行流式中途值顶掉
      expect(s.enqueueEvents([{ dedupKey: "msg|req", payload: "{}", backfill: false, rank: 22 }])).toBe(0);
      expect(JSON.parse(s.takeEvents(1)[0]!.payload)).toEqual({ output_tokens: 1500 });
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("超上限丢最旧的并返回丢弃条数", () => {
    const s = new ProbeStore(":memory:");
    s.enqueueEvents(rows(10));
    const dropped = s.trimQueue(4);
    expect(dropped).toBe(6);
    expect(s.queueDepth()).toBe(4);
    // 丢的是最旧的
    expect(s.takeEvents(1)[0]?.dedupKey).toBe("k6");
    expect(s.trimQueue(4)).toBe(0);
    s.close();
  });

  it("游标读写往返", () => {
    const s = new ProbeStore(":memory:");
    expect(s.getCursor("/p")).toBeNull();
    s.putCursor({ path: "/p", inode: "42", size: 100, offset: 80, mtime: 5 });
    expect(s.getCursor("/p")).toEqual({ path: "/p", inode: "42", size: 100, offset: 80, mtime: 5 });
    s.putCursor({ path: "/p", inode: "42", size: 200, offset: 200, mtime: 9 });
    expect(s.getCursor("/p")?.offset).toBe(200);
    expect(s.cursorCount()).toBe(1);
    s.close();
  });

  it("时间线：同 profile 不重复落点，按 ts 查当时生效的 profile", () => {
    const s = new ProbeStore(":memory:");
    expect(s.appendTimeline(1000, "p-a", "settings")).toBe(true);
    expect(s.appendTimeline(2000, "p-a", "settings")).toBe(false);
    expect(s.appendTimeline(3000, "p-b", "settings")).toBe(true);

    expect(s.timelineAt(500)).toBeNull(); // 早于最早的点 → 没有时间线可依
    expect(s.timelineAt(1500)?.profileId).toBe("p-a");
    expect(s.timelineAt(3000)?.profileId).toBe("p-b");
    expect(s.timelineAt(9999)?.profileId).toBe("p-b");
    expect(s.allTimeline()).toHaveLength(2);
    s.close();
  });

  it("额度队列独立于事件队列", () => {
    const s = new ProbeStore(":memory:");
    s.enqueueQuota(JSON.stringify({ profile_id: "p" }));
    expect(s.quotaDepth()).toBe(1);
    const q = s.takeQuota(5);
    s.ackQuota(q.map((r) => r.id));
    expect(s.quotaDepth()).toBe(0);
    expect(s.queueDepth()).toBe(0);
    s.close();
  });

  it("installed_at 只生成一次", () => {
    const s = new ProbeStore(":memory:");
    const a = s.installedAt();
    const b = s.installedAt();
    expect(a).toBe(b);
    s.close();
  });
});
