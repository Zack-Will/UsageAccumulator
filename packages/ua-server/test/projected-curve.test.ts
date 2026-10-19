import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store-memory.js";
import { computeCurrentWindows } from "../src/windows-service.js";

describe("projected_curve 与 exhaust_eta 一致", () => {
  it("提前耗尽时，曲线在 ETA 处到 100，之后保持 100", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-10-18T10:00:00Z");
    const resetsAt = new Date("2026-10-18T11:40:00Z");
    for (const [at, pct] of [
      ["2026-10-18T09:50:00Z", 40],
      ["2026-10-18T10:00:00Z", 50],
    ] as const) {
      await store.insertQuotaSnapshot({
        profileId: "claude-official",
        capturedAt: new Date(at),
        windows: [{ windowKind: "five_hour", utilizationPct: pct, resetsAt }],
        raw: {},
      });
    }

    const w = (await computeCurrentWindows(store, "claude-official", { now, maxBurnPoints: 11 })).windows[0]!;
    // 每分钟 1 点，还差 50 点 → 50 分钟后满
    expect(w.exhaust_eta).toBe("2026-10-18T10:50:00.000Z");
    const atEta = w.projected_curve.find((p) => p.ts === w.exhaust_eta)!;
    expect(atEta.mid).toBeCloseTo(100, 9);
    // ETA 之前按速率线性上涨，不被摊薄
    const halfway = w.projected_curve.find((p) => p.ts === "2026-10-18T10:20:00.000Z")!;
    expect(halfway.mid).toBeCloseTo(70, 9);
    const last = w.projected_curve[w.projected_curve.length - 1]!;
    expect(last.mid).toBe(100);
    expect(last.mid).toBe(w.projected_pct.mid);
  });
});
