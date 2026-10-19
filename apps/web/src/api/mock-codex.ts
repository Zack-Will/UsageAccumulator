/**
 * Codex 的 mock（docs/CODEX-API.md）。刻意保留真实账本里「难看」的几种状态：
 *   · codex-auto-review 没有报价 → 金额永远带缺价标记，不能显示成完整总额
 *   · 一部分事件带缺口标记 → usage_complete = false
 *   · 两个采集器里有一个快照过期
 */
import type {
  CodexAccount,
  CodexAggregate,
  CodexCollector,
  CodexPeriodRecord,
  CodexPeriods,
  CodexQuotaResponse,
  CodexQuotaWindow,
  CodexSessionStatus,
  CodexWindowAnalysis,
  CodexUsage,
  CodexUsageBucket,
  CodexUsageParams,
} from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

export const MOCK_CODEX_ACCOUNT: CodexAccount = {
  account_id: "mock-codex-account",
  email: "codex@example.test",
  plan_type: "pro",
  first_seen_at: iso(Date.now() - 9 * DAY),
  last_seen_at: iso(Date.now() - 2 * 60_000),
};

/** 模型 → 每小时用量与单价（$/MTok，按输入侧总量粗算即可，mock 不追求真实账单） */
const MODELS = [
  { key: "gpt-6-astra", weight: 0.55, usdPerMTok: 0.42 },
  { key: "gpt-6.1-sol", weight: 0.2, usdPerMTok: 0.95 },
  { key: "codex-auto-review", weight: 0.25, usdPerMTok: null },
] as const;
const PROJECTS = ["UsageAccumulator", "home-infra", "paper-draft", "(unknown)"] as const;

interface MockEvent {
  ts: number;
  model: string;
  project: string;
  machine: string;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  usd: number | null;
  gap: boolean;
}

/** 每小时若干次调用；夜里少、白天多。同一时刻永远生成同一批事件，刷新不跳 */
function events(fromMs: number, toMs: number): MockEvent[] {
  const out: MockEvent[] = [];
  const start = Math.floor(fromMs / HOUR) * HOUR;
  for (let h = start; h < toMs; h += HOUR) {
    const hour = new Date(h).getHours();
    const busy = hour >= 9 && hour <= 23 ? 1 : 0.15;
    const seed = Math.floor(h / HOUR);
    const calls = Math.round(busy * (3 + (seed % 5)));
    for (let i = 0; i < calls; i++) {
      const ts = h + ((i * 7 + seed) % 60) * 60_000;
      if (ts < fromMs || ts >= toMs) continue;
      const pick = (seed + i) % 20;
      const model = pick < 11 ? MODELS[0] : pick < 15 ? MODELS[1] : MODELS[2];
      const input = 60_000 + ((seed * 31 + i * 17) % 140) * 1_000;
      const cached = Math.round(input * 0.86);
      const output = 600 + ((seed + i * 13) % 40) * 60;
      out.push({
        ts,
        model: model.key,
        project: PROJECTS[(seed + i) % PROJECTS.length]!,
        machine: (seed + i) % 4 === 0 ? "mock-home" : "mock-mac",
        input,
        cached,
        output,
        reasoning: Math.round(output * 0.4),
        usd: model.usdPerMTok === null ? null : ((input + output) / 1e6) * model.usdPerMTok,
        gap: (seed + i) % 97 === 0,
      });
    }
  }
  return out;
}

function aggregate(rows: MockEvent[]): CodexAggregate {
  const priced = rows.filter((e) => e.usd !== null);
  const incomplete = rows.filter((e) => e.gap).length;
  const tokens = { input: 0, cached_input: 0, cache_write_input: 0, output: 0, reasoning_output: 0, total: 0 };
  for (const e of rows) {
    tokens.input += e.input;
    tokens.cached_input += e.cached;
    tokens.output += e.output;
    tokens.reasoning_output += e.reasoning;
    tokens.total += e.input + e.output;
  }
  return {
    events: rows.length,
    tokens,
    cost_usd: priced.length > 0 ? priced.reduce((a, e) => a + (e.usd ?? 0), 0) : null,
    pricing_complete: rows.length > 0 && priced.length === rows.length,
    usage_complete: incomplete === 0,
    usage_coverage_status: rows.length === 0 ? "no_data" : incomplete > 0 ? "incomplete" : "no_known_gaps",
    incomplete_events: incomplete,
    priced_events: priced.length,
    unpriced_events: rows.length - priced.length,
  };
}

const pad = (n: number): string => String(n).padStart(2, "0");
const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function buildCodexUsage(p: CodexUsageParams): CodexUsage {
  const rows = events(Date.parse(p.from), Date.parse(p.to));
  const keyOf = (e: MockEvent): string => {
    switch (p.by) {
      case "day":
        return dayKey(e.ts);
      case "model":
        return e.model;
      case "project":
        return e.project;
      case "machine":
        return e.machine;
      case "session":
        return `mock-session-${Math.floor(e.ts / (3 * HOUR))}`;
    }
  };
  const groups = new Map<string, MockEvent[]>();
  for (const e of rows) {
    const k = keyOf(e);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const buckets: CodexUsageBucket[] = [...groups.entries()]
    .map(([key, g]) => ({ key, ...aggregate(g) }))
    .sort((a, b) => (p.by === "day" ? a.key.localeCompare(b.key) : b.tokens.total - a.tokens.total));
  return { account_id: p.account_id, from: p.from, to: p.to, by: p.by, timezone: p.timezone, totals: aggregate(rows), buckets };
}

const WEEK = 7 * DAY;

/**
 * 7d 窗口：本期开头用到 46%，两天前官方重置清零（期内重置，resets_at 没动），之后又用到 51%。
 * 本期累计就是 46 + 51 = 97 —— 只看现值的话会以为这周才用了一半。
 */
function weekSamples(nowMs: number, reset: number): { ts: number; pct: number; segment: number }[] {
  const start = reset - WEEK;
  const resetAt = nowMs - 2 * DAY;
  const out: { ts: number; pct: number; segment: number }[] = [];
  for (let t = start + HOUR; t <= nowMs; t += 2 * HOUR) {
    const before = t < resetAt;
    const pct = before
      ? Math.round(46 * ((t - start) / (resetAt - start)))
      : Math.round(51 * Math.min(1, (t - resetAt) / (nowMs - resetAt)));
    out.push({ ts: t, pct, segment: before ? 0 : 1 });
  }
  return out;
}

/** onlyWeek：只有 7d 一个窗口（真实账号常见的形态） */
export function buildCodexQuota(accountId: string, nowMs: number, onlyWeek = false): CodexQuotaResponse {
  const capturedAt = nowMs - 3 * 60_000;
  const weekReset = nowMs + 2.6 * DAY;
  const fiveReset = nowMs + 2.2 * HOUR;
  const windows: CodexQuotaWindow[] = [
    { window_id: "codex:secondary", limit_id: "codex", slot: "secondary", label: null, used_percent: 51,
      duration_minutes: 10_080, resets_at: iso(weekReset) },
    { window_id: "codex:primary", limit_id: "codex", slot: "primary", label: null, used_percent: 34,
      duration_minutes: 300, resets_at: iso(fiveReset) },
  ];
  const samples = weekSamples(nowMs, weekReset);
  const resetIdx = samples.findIndex((s) => s.segment === 1);
  const weekUsage = aggregate(events(weekReset - WEEK, nowMs));
  const fiveUsage = aggregate(events(fiveReset - 5 * HOUR, nowMs));
  const week: CodexWindowAnalysis = {
    local_usage: weekUsage,
    local_usage_from: iso(weekReset - WEEK),
    full_cost: weekUsage.cost_usd ? { usd: weekUsage.cost_usd / 0.97, basis: "current", reference_periods: null, lower_bound: true } : null,
    window_id: "codex:secondary",
    rate_pct_per_min: 51 / (2 * 24 * 60),
    projected_pct: { p25: 68, mid: 74, p75: 81 },
    exhaust_eta: null,
    period: {
      window_id: "codex:secondary", limit_id: "codex", slot: "secondary", label: null, duration_minutes: 10_080,
      starts_at: iso(weekReset - WEEK), scheduled_end: iso(weekReset), ended_at: null, end_reason: null,
      opened_by_reset: null,
      resets: resetIdx > 0
        ? [{ after: iso(samples[resetIdx - 1]!.ts), at: iso(samples[resetIdx]!.ts), from_pct: samples[resetIdx - 1]!.pct,
            to_pct: samples[resetIdx]!.pct, kind: "in_period" }]
        : [],
      first_sample_at: iso(samples[0]!.ts), last_sample_at: iso(samples.at(-1)!.ts),
      cumulative_pct: 97, final_pct: 51, has_gap: false,
      samples: samples.map((s) => ({ ts: iso(s.ts), pct: s.pct, segment: s.segment })),
    },
  };
  const fiveStart = fiveReset - 5 * HOUR;
  const fiveSamples = Array.from({ length: 34 }, (_, i) => fiveStart + (i + 1) * 5 * 60_000)
    .filter((t) => t <= nowMs)
    .map((t) => ({ ts: iso(t), pct: Math.round(34 * ((t - fiveStart) / (nowMs - fiveStart))), segment: 0 }));
  const five: CodexWindowAnalysis = {
    local_usage: fiveUsage,
    local_usage_from: iso(fiveReset - 5 * HOUR),
    // 5h 本期才 34%：外推仍可以，但演示一下「历史参考」那条分支
    full_cost: { usd: 18.4, basis: "reference", reference_periods: 6, lower_bound: false },
    window_id: "codex:primary",
    rate_pct_per_min: 0.2,
    projected_pct: { p25: 52, mid: 60, p75: 71 },
    exhaust_eta: null,
    period: {
      window_id: "codex:primary", limit_id: "codex", slot: "primary", label: null, duration_minutes: 300,
      starts_at: iso(fiveStart), scheduled_end: iso(fiveReset), ended_at: null, end_reason: null, opened_by_reset: null,
      resets: [], first_sample_at: fiveSamples[0]?.ts ?? iso(nowMs), last_sample_at: fiveSamples.at(-1)?.ts ?? iso(nowMs),
      cumulative_pct: 34, final_pct: 34, has_gap: false, samples: fiveSamples,
    },
  };
  return {
    account_id: accountId,
    age_seconds: 180,
    stale: false,
    snapshot: {
      captured_at: iso(capturedAt),
      windows: onlyWeek ? windows.filter((w) => w.window_id === "codex:secondary") : windows,
      limits: [{ limit_id: "codex", plan_type: "pro", credits: null, limit_reached: null }],
      reset_credits: {
        available_count: 2,
        credits: [
          { reset_type: "full", status: "available", granted_at: iso(nowMs - 3 * DAY), expires_at: iso(nowMs + 9 * DAY), title: "Usage reset" },
          { reset_type: "full", status: "available", granted_at: iso(nowMs - DAY), expires_at: iso(nowMs + 26 * DAY), title: "Usage reset" },
        ],
      },
    },
    analysis: onlyWeek ? [week] : [week, five],
  };
}

export function buildCodexPeriods(accountId: string, weeks: number, nowMs: number): CodexPeriods {
  const reset = nowMs + 2.6 * DAY;
  const local = (from: number, to: number) => aggregate(events(from, to));
  const record = (
    start: number, end: number, cumulative: number, final: number,
    extra: Partial<CodexPeriodRecord> = {},
  ): CodexPeriodRecord => ({
    window_id: "codex:secondary", limit_id: "codex", slot: "secondary", label: null, duration_minutes: 10_080,
    starts_at: iso(start), scheduled_end: iso(start + WEEK), ended_at: end >= nowMs ? null : iso(end),
    end_reason: end >= nowMs ? null : "scheduled", opened_by_reset: null, resets: [],
    first_sample_at: iso(start + HOUR), last_sample_at: iso(Math.min(end, nowMs)),
    cumulative_pct: cumulative, final_pct: final, has_gap: false,
    local_usage: local(start, Math.min(end, nowMs)), local_usage_from: iso(start), local_usage_to: iso(Math.min(end, nowMs)),
    ...extra,
  });
  const withFull = (p: CodexPeriodRecord): CodexPeriodRecord => ({
    ...p,
    full_cost_usd: p.local_usage.cost_usd && p.cumulative_pct > 0 ? p.local_usage.cost_usd / (p.cumulative_pct / 100) : null,
  });
  const p0Start = reset - WEEK;
  const p1Start = p0Start - WEEK;
  // 上上期被官方提前重置打断：旧期提前结束，新期从重置那一刻起算
  const earlyReset = p1Start - 2 * DAY;
  const p3Start = earlyReset - 5 * DAY;
  const periods: CodexPeriodRecord[] = [
    record(p0Start, nowMs, 97, 51, {
      resets: [{ after: iso(nowMs - 2 * DAY - 2 * HOUR), at: iso(nowMs - 2 * DAY), from_pct: 46, to_pct: 0, kind: "in_period" }],
    }),
    record(p1Start, p0Start, 88, 88),
    record(earlyReset, p1Start, 64, 64, {
      starts_at: iso(earlyReset),
      opened_by_reset: { after: iso(earlyReset - HOUR), at: iso(earlyReset), from_pct: 71, to_pct: 0, kind: "new_period" },
    }),
    record(p3Start, earlyReset, 71, 71, { end_reason: "reset", ended_at: iso(earlyReset), has_gap: true }),
  ];
  const full = periods.map(withFull);
  return { account_id: accountId, weeks, periods: full, full_cost_references: { "codex:secondary": { usd: 39.6, periods: 3 } } };
}

export function mockCodexSession(state: CodexSessionStatus["state"], nowMs: number): CodexSessionStatus {
  return {
    state,
    last_ok_at: state === "ok" ? iso(nowMs - 3 * 60_000) : null,
    last_attempt_at: state === "none" ? null : iso(nowMs - 3 * 60_000),
    next_attempt_at: state === "none" ? null : iso(nowMs + 2 * 60_000),
    error: state === "auth" ? "refresh token 已被用过（可能还在别处用着这份登录），需要重新登录一份" : null,
    email: state === "none" ? null : MOCK_CODEX_ACCOUNT.email,
    plan_type: state === "none" ? null : "pro",
    refreshed_at: state === "none" ? null : iso(nowMs - 2 * DAY),
  };
}

export function buildCodexCollectors(accountId: string, nowMs: number): CodexCollector[] {
  const collector = (machine: string, hostname: string, ageMin: number): CodexCollector => ({
    account_id: accountId,
    machine_id: machine,
    hostname,
    received_at: iso(nowMs - ageMin * 60_000),
    age_seconds: ageMin * 60,
    stale: ageMin > 15,
    conflicting_observations: 0,
    parse_warnings_total: 0,
    collector: {
      captured_at: iso(nowMs - ageMin * 60_000),
      state: "ok",
      error_code: null,
      backfill_from: iso(nowMs - 18 * DAY),
      scanned_files: machine === "mock-home" ? 105 : 24,
      parse_warnings: 0,
    },
  });
  return [collector("ua-server", "", 3), collector("mock-mac", "Mac", 2), collector("mock-home", "home-center", 47)]
    .map((c) => (c.machine_id === "ua-server" ? { ...c, hostname: null } : c));
}
