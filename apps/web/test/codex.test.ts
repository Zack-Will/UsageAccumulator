import { describe, expect, it } from "vitest";
import {
  codexBucket,
  codexDaySeries,
  codexPace,
  codexWindowTitle,
  collectorStateLabel,
  collectorTone,
  durationLabel,
  localDayKey,
  localDayTicks,
  sortCodexWindows,
} from "../src/api/codex";
import { usageTotals } from "../src/api/derive";
import type { CodexAggregate, CodexCollector, CodexQuotaWindow, CodexUsageBucket } from "../src/api/types";

const agg = (over: Partial<CodexAggregate> = {}): CodexAggregate => ({
  events: 2,
  tokens: { input: 1000, cached_input: 800, cache_write_input: 50, output: 100, reasoning_output: 40, total: 1100 },
  cost_usd: 0.5,
  pricing_complete: true,
  usage_complete: true,
  usage_coverage_status: "no_known_gaps",
  incomplete_events: 0,
  priced_events: 2,
  unpriced_events: 0,
  ...over,
});
const win = (over: Partial<CodexQuotaWindow> = {}): CodexQuotaWindow => ({
  window_id: "codex:primary", limit_id: "codex", slot: "primary", label: null,
  used_percent: 30, duration_minutes: 300, resets_at: null, ...over,
});

describe("Codex → 看板形状", () => {
  it("把包含式的 input 拆成互斥的未缓存 / 缓存读 / 缓存写，total 不重复加", () => {
    const b = codexBucket("m", agg());
    expect(b).toMatchObject({ input_tokens: 150, cache_read_tokens: 800, cache_write_5m_tokens: 50, output_tokens: 100, total_tokens: 1100 });
    const totals = usageTotals([b]);
    expect(totals.totalTokens).toBe(1100);
    expect(totals.input + totals.cacheRead + totals.cacheWrite + totals.output).toBe(1100);
    expect(totals.cacheHitPct).toBeCloseTo(80, 6);
  });

  it("缺价保持 null，不变成 $0", () => {
    const b = codexBucket("codex-auto-review", agg({ cost_usd: null, priced_events: 0, unpriced_events: 2 }));
    expect(b.cost_usd).toBeNull();
    expect(usageTotals([b]).cost.usd).toBeNull();
  });

  it("窗口标题按时长，不按 primary/secondary；多个限额时带上限额名", () => {
    expect(durationLabel(300)).toBe("5h");
    expect(durationLabel(10080)).toBe("7d");
    expect(durationLabel(null)).toBeNull();
    expect(codexWindowTitle(win({ slot: "primary", duration_minutes: 10080 }), false)).toBe("7d 窗口");
    expect(codexWindowTitle(win({ duration_minutes: null }), false)).toBe("primary");
    expect(codexWindowTitle(win({ limit_id: "gpt-6" }), true)).toBe("gpt-6 · 5h 窗口");
    expect(sortCodexWindows([win({ window_id: "b", duration_minutes: 10080 }), win({ window_id: "a" })]).map((w) => w.window_id))
      .toEqual(["a", "b"]);
  });

  it("时间进度只在时长和重置时刻都已知时给出", () => {
    const now = Date.parse("2026-10-19T10:00:00Z");
    expect(codexPace(win({ resets_at: "2026-10-19T12:30:00Z" }), now)).toBeCloseTo(0.5, 9);
    expect(codexPace(win({ resets_at: null }), now)).toBeNull();
    expect(codexPace(win({ duration_minutes: null, resets_at: "2026-10-19T12:30:00Z" }), now)).toBeNull();
  });

  it("按天的序列对齐本地日期：空日为 0，有事件但全缺价为 null", () => {
    const from = new Date(2026, 9, 17, 15).getTime();
    const to = new Date(2026, 9, 19, 9).getTime();
    const ticks = localDayTicks(from, to);
    expect(ticks.map(localDayKey)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
    const buckets: CodexUsageBucket[] = [
      { key: "2026-10-17", ...agg() },
      { key: "2026-10-19", ...agg({ cost_usd: null, priced_events: 0, unpriced_events: 2 }) },
    ];
    expect(codexDaySeries(buckets, ticks, "cost", "Codex")[0]!.values).toEqual([0.5, 0, null]);
    expect(codexDaySeries(buckets, ticks, "tokens", "Codex")[0]!.values).toEqual([1100, 0, 1100]);
  });

  it("采集器：登录失效 / 出错为红，仅过期为黄", () => {
    const c = (state: "ok" | "auth" | "error", stale = false, error_code: string | null = null): CodexCollector => ({
      account_id: "a", machine_id: "m", hostname: "Mac", received_at: "", age_seconds: 0, stale,
      conflicting_observations: 0, parse_warnings_total: 0,
      collector: { captured_at: "", state, error_code, backfill_from: "", scanned_files: 0, parse_warnings: 0 },
    });
    expect(collectorTone(c("ok"))).toBe("ok");
    expect(collectorTone(c("ok", true))).toBe("warn");
    expect(collectorTone(c("auth"))).toBe("danger");
    expect(collectorStateLabel(c("error", false, "codex_events_rejected"))).toBe("有事件被拒收");
  });
});
