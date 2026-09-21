import { describe, expect, it } from "vitest";
import { runCalibrationOnce } from "../src/calibration-job.js";
import { MemoryStore } from "../src/store-memory.js";
import { makeEvent } from "./helpers.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const BASE = new Date(NOW.getTime() - 5 * 3600_000);

/** 造一组「限额 L、opus 权重 1、fable 权重 0.5」的合成数据，看能不能反解回来。 */
const L = 1_000_000;
const W_FABLE = 0.5;

async function seed(store: MemoryStore, intervals: number, machines = ["machine-a"]): Promise<void> {
  await store.ensureProfiles(["claude-official"]);
  let pct = 5;
  await store.insertQuotaSnapshot({
    profileId: "claude-official",
    capturedAt: BASE,
    windows: [{ windowKind: "five_hour", utilizationPct: pct, resetsAt: NOW }],
    raw: {},
  });

  const rows = [];
  for (let i = 1; i <= intervals; i++) {
    const opus = 2000 + (i % 7) * 500;
    const fable = 1000 + (i % 5) * 300;
    const at = new Date(BASE.getTime() + i * 5 * 60_000);
    const evAt = new Date(at.getTime() - 4 * 60_000);

    rows.push(
      makeEvent({
        ts: evAt,
        model: "claude-opus-5",
        machineId: machines[i % machines.length]!,
        inputTokens: opus,
        outputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      }),
      makeEvent({
        ts: new Date(evAt.getTime() + 60_000),
        model: "claude-fable-5-1",
        machineId: machines[0]!,
        inputTokens: fable,
        outputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      }),
    );

    pct += ((opus + W_FABLE * fable) / L) * 100;
    await store.insertQuotaSnapshot({
      profileId: "claude-official",
      capturedAt: at,
      windows: [{ windowKind: "five_hour", utilizationPct: pct, resetsAt: NOW }],
      raw: {},
    });
  }
  await store.insertEvents(rows.map((event) => ({ event, costUsd: null })));
}

describe("calibration job (§7.0)", () => {
  it("recovers the limit and the model weights from percentage deltas", async () => {
    const store = new MemoryStore();
    await seed(store, 40);

    const written = await runCalibrationOnce(store, { now: NOW });
    expect(written).toHaveLength(1);
    const rec = written[0]!;
    expect(rec.windowKind).toBe("five_hour");
    expect(rec.observations).toBeGreaterThanOrEqual(30);
    expect(rec.baseModel).toBe("claude-opus-5");
    expect(rec.limitWeightedTokens).toBeCloseTo(L, -3);
    expect(rec.weights["claude-opus-5"]).toBeCloseTo(1, 2);
    expect(rec.weights["claude-fable-5-1"]).toBeCloseTo(W_FABLE, 2);
    expect(rec.residual).toBeLessThan(0.05);
    expect(store.calibrations).toHaveLength(1);
  });

  it("stores the scatter points the fit was actually computed on", async () => {
    const store = new MemoryStore();
    await seed(store, 40);
    const rec = (await runCalibrationOnce(store, { now: NOW }))[0]!;

    // 点数与 observations 对得上：散点就是参与回归的那批，不能混进被丢弃的点
    expect(rec.points).toHaveLength(rec.observations);
    for (const p of rec.points) {
      expect(p.weighted_tokens).toBeGreaterThan(0);
      expect(p.delta_pct).toBeGreaterThan(0);
      // 拟合得好的话，fitted 应当贴着 delta
      expect(p.fitted_pct).toBeCloseTo(p.delta_pct, 2);
    }
  });

  it("writes nothing while there are too few clean observations", async () => {
    const store = new MemoryStore();
    await seed(store, 5);
    const written = await runCalibrationOnce(store, { now: NOW });
    // 看板据此显示「标定中」，所有指标退回百分比口径
    expect(written).toHaveLength(0);
    expect(store.calibrations).toHaveLength(0);
  });

  it("drops multi-machine intervals — they would poison the regression", async () => {
    const store = new MemoryStore();
    await seed(store, 40, ["machine-a", "machine-b"]);
    // 一半区间变成多机并发，干净观测掉到 30 以下
    const written = await runCalibrationOnce(store, { now: NOW });
    expect(written).toHaveLength(0);
  });

  it("does nothing for a profile with no quota snapshots", async () => {
    const store = new MemoryStore();
    await store.ensureProfiles(["gw-openrouter"]);
    expect(await runCalibrationOnce(store, { now: NOW })).toHaveLength(0);
  });
});
