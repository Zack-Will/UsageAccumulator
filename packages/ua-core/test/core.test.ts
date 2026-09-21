import { describe, expect, it } from "vitest";
import { calibrate, type CalibObservation } from "../src/calibration.js";
import { dedupKey, semanticId } from "../src/dedup.js";
import { parseLine } from "../src/jsonl.js";
import { FIVE_HOURS_MS, multiMachineOverlap, projectWindow, segmentBlocks, sessionCutRate } from "../src/windows.js";
import type { UsageEvent } from "../src/types.js";

const CTX = { machineId: "m1", profileId: "p1", attributionLevel: "timeline" as const };

function line(over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-01T16:04:45.751Z",
    requestId: "req_1",
    sessionId: "s1",
    gitBranch: "main",
    entrypoint: "cli",
    isSidechain: false,
    message: {
      id: "msg_1",
      model: "claude-opus-5",
      usage: {
        input_tokens: 2,
        output_tokens: 726,
        cache_read_input_tokens: 38256,
        cache_creation_input_tokens: 31626,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 31626 },
        output_tokens_details: { thinking_tokens: 295 },
        service_tier: "standard",
        ...usage,
      },
    },
    ...over,
  });
}

describe("parseLine", () => {
  it("拆开 5m / 1h 缓存写入", () => {
    const { event, warnings } = parseLine(line(), CTX);
    expect(event).not.toBeNull();
    expect(event!.cacheWrite1hTokens).toBe(31626);
    expect(event!.cacheWrite5mTokens).toBe(0);
    expect(event!.thinkingTokens).toBe(295);
    expect(warnings).toHaveLength(0);
  });

  it("非 assistant 行返回 null", () => {
    expect(parseLine(JSON.stringify({ type: "user" }), CTX).event).toBeNull();
    expect(parseLine("", CTX).event).toBeNull();
    expect(parseLine("{ 坏 json", CTX).event).toBeNull();
  });

  it("cache_creation 缺失时退化计入 5m 并告警，绝不静默按 1h 计价", () => {
    const raw = JSON.parse(line()) as any;
    delete raw.message.usage.cache_creation;
    const { event, warnings } = parseLine(JSON.stringify(raw), CTX);
    expect(event!.cacheWrite5mTokens).toBe(31626);
    expect(event!.cacheWrite1hTokens).toBe(0);
    expect(warnings.map((w) => w.kind)).toContain("missing-cache-breakdown");
  });

  it("5m + 1h 与 cache_creation_input_tokens 不符时告警", () => {
    const { warnings } = parseLine(
      line({}, { cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 } }),
      CTX,
    );
    expect(warnings.map((w) => w.kind)).toContain("cache-sum-mismatch");
  });

  it("requestId 缺失时用 semanticId 兜底去重", () => {
    const raw = JSON.parse(line()) as any;
    delete raw.requestId;
    const { event, warnings } = parseLine(JSON.stringify(raw), CTX);
    expect(warnings.map((w) => w.kind)).toContain("missing-request-id");
    expect(dedupKey(event!)).toBe(`sem|${event!.semanticId}`);
  });

  it("相同内容产生相同 semanticId（ssh 双写去重的基础）", () => {
    const a = parseLine(line(), CTX).event!;
    const b = parseLine(line(), { ...CTX, machineId: "m2" }).event!;
    expect(a.semanticId).toBe(b.semanticId);
    expect(dedupKey(a)).toBe(dedupKey(b));
  });
});

function ev(tsIso: string, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    messageId: "m", requestId: "r", semanticId: semanticId({ sessionId: "s", tsMs: 0, model: "x", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }),
    machineId: "m1", appType: "claude", profileId: "p1", attributionLevel: "timeline",
    ts: new Date(tsIso), model: "claude-opus-5", inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
    cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, sessionId: "s1",
    projectSlug: null, gitBranch: null, entrypoint: null, serviceTier: null, isSidechain: false, backfill: false,
    ...over,
  };
}

describe("segmentBlocks", () => {
  it("块起点向下取整到整点，块长 5h", () => {
    const [b] = segmentBlocks([ev("2026-09-01T13:37:00Z"), ev("2026-09-01T15:00:00Z")]);
    expect(b!.startsAt.toISOString()).toBe("2026-09-01T13:00:00.000Z");
    expect(b!.endsAt.getTime() - b!.startsAt.getTime()).toBe(FIVE_HOURS_MS);
    expect(b!.events).toHaveLength(2);
  });

  it("间隔超过 5h 另起新块", () => {
    const blocks = segmentBlocks([ev("2026-09-01T01:00:00Z"), ev("2026-09-01T09:00:00Z")]);
    expect(blocks).toHaveLength(2);
  });

  it("空输入返回空", () => expect(segmentBlocks([])).toEqual([]));
});

describe("projectWindow", () => {
  const now = new Date("2026-09-01T16:42:00Z");
  const windowEnd = new Date("2026-09-01T18:30:00Z");

  it("按速率外推，并给出 p25/mid/p75 三条线", () => {
    const samples = Array.from({ length: 7 }, (_, i) => ({
      ts: new Date(now.getTime() - (6 - i) * 5 * 60000),
      pct: 50 + i * 2,
    }));
    const p = projectWindow({ samples, now, windowEnd });
    expect(p.ratePctPerMin).toBeCloseTo(0.4, 2);
    expect(p.projected.mid).toBeGreaterThan(62);
    expect(p.projected.p25).toBeLessThanOrEqual(p.projected.p75);
    expect(p.projected.mid).toBeLessThanOrEqual(100);
  });

  it("百分比归零（跨窗口边界）的区间不计入速率", () => {
    const p = projectWindow({
      samples: [
        { ts: new Date(now.getTime() - 20 * 60000), pct: 95 },
        { ts: new Date(now.getTime() - 15 * 60000), pct: 2 },
        { ts: new Date(now.getTime() - 10 * 60000), pct: 4 },
      ],
      now,
      windowEnd,
    });
    expect(p.ratePctPerMin).toBeGreaterThan(0);
    expect(p.ratePctPerMin).toBeLessThan(1);
  });

  it("速率为 0 时不给耗尽时间", () => {
    const p = projectWindow({ samples: [{ ts: now, pct: 10 }], now, windowEnd });
    expect(p.exhaustEta).toBeNull();
  });

  it("本窗口内打不满时 exhaustEta 为 null，而不是给个窗口之后的假时间", () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({
      ts: new Date(now.getTime() - (4 - i) * 5 * 60000),
      pct: 10 + i * 0.1,
    }));
    const p = projectWindow({ samples, now, windowEnd });
    expect(p.exhaustEta).toBeNull();
  });
});

describe("重叠度指标", () => {
  it("会话切断率：跨边界的会话计入", () => {
    const boundary = new Date("2026-09-01T18:30:00Z");
    const events = [
      ev("2026-09-01T18:00:00Z", { sessionId: "a" }),
      ev("2026-09-01T19:00:00Z", { sessionId: "a" }),
      ev("2026-09-01T18:10:00Z", { sessionId: "b" }),
    ];
    expect(sessionCutRate(events, [boundary])).toBeCloseTo(0.5, 5);
  });

  it("多机重叠：同一分钟出现两台机器才算", () => {
    const start = new Date("2026-09-01T13:00:00Z");
    const end = new Date("2026-09-01T13:10:00Z");
    const r = multiMachineOverlap(
      [
        ev("2026-09-01T13:01:10Z", { machineId: "m1" }),
        ev("2026-09-01T13:01:40Z", { machineId: "m2" }),
        ev("2026-09-01T13:05:00Z", { machineId: "m1" }),
      ],
      start, end,
    );
    expect(r).toBeCloseTo(0.1, 5);
  });
});

describe("calibrate", () => {
  it("能从合成数据里把限额和模型权重反解回来", () => {
    const L = 5_810_000;
    const W: Record<string, number> = { "claude-opus-5": 3.1, "claude-fable-5-1": 1.8, "claude-sonnet-5": 1.0 };
    const obs: CalibObservation[] = [];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 60; i++) {
      const tokensByModel = {
        "claude-opus-5": Math.round(rnd() * 120000),
        "claude-fable-5-1": Math.round(rnd() * 90000),
        "claude-sonnet-5": Math.round(rnd() * 60000),
      };
      const weighted = Object.entries(tokensByModel).reduce((s, [m, t]) => s + (W[m] ?? 0) * t, 0);
      obs.push({ deltaPct: (weighted / L) * 100, tokensByModel, singleMachine: true });
    }
    const r = calibrate(obs, { baseModel: "claude-sonnet-5" });
    expect(r).not.toBeNull();
    expect(r!.limitWeightedTokens).toBeCloseTo(L, -5);
    expect(r!.weights["claude-opus-5"]!).toBeCloseTo(3.1, 1);
    expect(r!.weights["claude-fable-5-1"]!).toBeCloseTo(1.8, 1);
    expect(r!.residual).toBeLessThan(0.05);
  });

  it("观测点不足时返回 null（看板显示「标定中」）", () => {
    expect(calibrate([{ deltaPct: 1, tokensByModel: { a: 1 }, singleMachine: true }])).toBeNull();
  });

  it("剔除多机并发与零增量的区间", () => {
    const obs: CalibObservation[] = Array.from({ length: 40 }, () => ({
      deltaPct: 1, tokensByModel: { a: 1000 }, singleMachine: false,
    }));
    expect(calibrate(obs)).toBeNull();
  });
});
