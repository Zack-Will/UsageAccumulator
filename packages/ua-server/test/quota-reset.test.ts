import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store-memory.js";
import { computeCurrentWindows, fullCostReference, loadNonCode } from "../src/windows-service.js";
import { makeEvent } from "./helpers.js";

const H = 3600_000;

async function snap(store: MemoryStore, at: Date, pct: number, resetsAt: Date, windowKind = "five_hour") {
  await store.insertQuotaSnapshot({
    profileId: "claude-official",
    capturedAt: at,
    windows: [{ windowKind, utilizationPct: pct, resetsAt }],
    raw: {},
  });
}

describe("重置卡：期内清零、resets_at 不变", () => {
  it("5h 用卡是提前开新窗口：名义起点里旧窗口的样本剔除，起点推到它们之后，不算期内重置", async () => {
    // 2026-10-20 实况：09:50 到期的窗口 91% 时用卡，新窗口 resets_at 13:10，名义起点 08:10 早于用卡
    const store = new MemoryStore();
    const oldEnd = new Date("2026-10-20T09:50:00Z");
    const newEnd = new Date("2026-10-20T13:09:59.871Z");
    await snap(store, new Date("2026-10-20T08:08:53Z"), 89, oldEnd);
    await snap(store, new Date("2026-10-20T08:11:38Z"), 91, oldEnd);
    await snap(store, new Date("2026-10-20T08:17:11Z"), 3, newEnd);
    await store.insertEvents([
      { event: makeEvent({ messageId: "before", ts: new Date("2026-10-20T08:11:00Z") }), costUsd: 9 },
      { event: makeEvent({ messageId: "after", ts: new Date("2026-10-20T08:15:00Z") }), costUsd: 1 },
    ]);
    const now = new Date("2026-10-20T08:18:00Z");
    const w = (await computeCurrentWindows(store, "claude-official", { now })).windows[0]!;
    expect(w.starts_at).toBe("2026-10-20T08:11:38.000Z");
    expect(w.resets).toEqual([]);
    expect(w.cumulative_pct).toBe(3);
    expect(w.burn_curve.map((p) => p.pct)).toEqual([3]);
  });

  it("当前窗口：预测只用重置之后的样本，累计与重置都给出，燃尽点按段编号", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-10-20T10:00:00Z");
    const resetsAt = new Date("2026-10-20T12:00:00Z");
    const t = (m: number) => new Date(now.getTime() + m * 60_000);
    // 重置前 1 点/分钟冲到 60%，用卡清零后 0.5 点/分钟
    for (const [m, pct] of [[-40, 40], [-30, 50], [-20, 60], [-10, 0], [0, 5]] as const) {
      await snap(store, t(m), pct, resetsAt);
    }
    const w = (await computeCurrentWindows(store, "claude-official", { now, maxBurnPoints: 50 })).windows[0]!;
    expect(w.utilization_pct).toBe(5);
    expect(w.cumulative_pct).toBe(65);
    expect(w.resets).toEqual([
      { after: t(-20).toISOString(), at: t(-10).toISOString(), from_pct: 60, to_pct: 0 },
    ]);
    expect(w.burn_curve.map((p) => p.segment)).toEqual([0, 0, 0, 1, 1]);
    // 重置前的速率（1 点/分钟）会让它 95 分钟内耗尽；重置后的 0.5 点/分钟到 12:00 只到 65%
    expect(w.rate_pct_per_min).toBeCloseTo(0.5, 6);
    expect(w.exhaust_eta).toBeNull();
    expect(w.projected_pct.mid).toBeCloseTo(65, 6);
  });

  it("满额参考：分母是本期累计，不是重置后的最后一个样本", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-10-20T12:00:00Z");
    const end = new Date(now.getTime() - 6 * H);
    const start = end.getTime() - 5 * H;
    // 前半段 1→30%、清零、后半段 1→10%：本期累计 40%，本地共花 $40 → 满额 $100
    for (let i = 1; i <= 29; i++) {
      const ts = new Date(start + i * 10 * 60_000);
      const pct = i <= 15 ? 2 * i : Math.round(((i - 15) * 10) / 14);
      await snap(store, ts, pct, end);
      await store.insertEvents([
        { event: makeEvent({ messageId: `r-${i}`, ts: new Date(ts.getTime() - 60_000) }), costUsd: 40 / 29 },
      ]);
    }
    const ref = await fullCostReference(store, "claude-official", now, await loadNonCode(store, "claude-official", now), {
      cache: false,
    });
    expect(ref).not.toBeNull();
    expect(ref!.usd).toBeCloseTo(100, 6);
  });
});
