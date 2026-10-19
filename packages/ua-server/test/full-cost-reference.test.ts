import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store-memory.js";
import { fullCostReference, loadNonCode } from "../src/windows-service.js";
import { makeEvent } from "./helpers.js";

const H = 3600_000;
const NOW = new Date("2026-10-03T12:00:00Z");

/** 一个已结束的 5h 窗口：每 10 分钟一个快照线性涨到 finalPct，窗口中段有一笔本地花费 */
async function seedWindow(store: MemoryStore, end: Date, finalPct: number, costUsd: number, tag: string) {
  const start = end.getTime() - 5 * H;
  for (let i = 1; i <= 29; i++) {
    const ts = new Date(start + i * 10 * 60_000);
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: ts,
      windows: [{ windowKind: "five_hour", utilizationPct: Math.round((finalPct * i) / 29), resetsAt: end }],
      raw: {},
    });
    // 每个区间都有本地活动：差额法全判不了，不会把上涨算到别处
    await store.insertEvents([
      { event: makeEvent({ messageId: `${tag}-${i}`, ts: new Date(ts.getTime() - 60_000) }), costUsd: costUsd / 29 },
    ]);
  }
}

describe("fullCostReference", () => {
  it("用本地占比够大的已结束窗口算「已花 ÷ 本地占比」；小窗口不参与", async () => {
    const store = new MemoryStore();
    await seedWindow(store, new Date(NOW.getTime() - 12 * H), 40, 40, "big");
    await seedWindow(store, new Date(NOW.getTime() - 6 * H), 10, 30, "small"); // 10% 外推成 $300，不能当参考
    const ref = await fullCostReference(store, "claude-official", NOW, await loadNonCode(store, "claude-official", NOW), {
      cache: false,
    });
    expect(ref).not.toBeNull();
    expect(ref!.windows).toBe(1);
    expect(ref!.usd).toBeCloseTo(100, 6);
    expect(ref!.partial_output_events).toBe(0);
  });

  it("没有合格窗口时为 null，不编一个数", async () => {
    const store = new MemoryStore();
    await seedWindow(store, new Date(NOW.getTime() - 6 * H), 10, 30, "small");
    const ref = await fullCostReference(store, "claude-official", NOW, await loadNonCode(store, "claude-official", NOW), {
      cache: false,
    });
    expect(ref).toBeNull();
  });

  it("有缺价事件的窗口不参与：用量进了百分比，花费却是 0", async () => {
    const store = new MemoryStore();
    await seedWindow(store, new Date(NOW.getTime() - 18 * H), 40, 40, "ok");
    const end = new Date(NOW.getTime() - 12 * H);
    await seedWindow(store, end, 40, 20, "half");
    await store.insertEvents([
      { event: makeEvent({ messageId: "unpriced", ts: new Date(end.getTime() - 2 * H) }), costUsd: null },
    ]);
    const ref = await fullCostReference(store, "claude-official", NOW, await loadNonCode(store, "claude-official", NOW), {
      cache: false,
    });
    expect(ref!.windows).toBe(1);
    expect(ref!.usd).toBeCloseTo(100, 6);
  });

  it("最后一个快照离窗口结束太远的窗口不参与：尾段花费没有对应的百分比", async () => {
    const store = new MemoryStore();
    const end = new Date(NOW.getTime() - 12 * H);
    const start = end.getTime() - 5 * H;
    // 前 1 小时涨到 40%、花 $40，之后采样器停了，又花了 $40
    for (let i = 1; i <= 6; i++) {
      const ts = new Date(start + i * 10 * 60_000);
      await store.insertQuotaSnapshot({
        profileId: "claude-official",
        capturedAt: ts,
        windows: [{ windowKind: "five_hour", utilizationPct: Math.round((40 * i) / 6), resetsAt: end }],
        raw: {},
      });
      await store.insertEvents([
        { event: makeEvent({ messageId: `head-${i}`, ts: new Date(ts.getTime() - 60_000) }), costUsd: 40 / 6 },
      ]);
    }
    await store.insertEvents([
      { event: makeEvent({ messageId: "tail", ts: new Date(start + 3 * H) }), costUsd: 40 },
    ]);
    const ref = await fullCostReference(store, "claude-official", NOW, await loadNonCode(store, "claude-official", NOW), {
      cache: false,
    });
    expect(ref).toBeNull();
  });
});
