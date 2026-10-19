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
  CodexQuotaResponse,
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

export function buildCodexQuota(accountId: string, nowMs: number): CodexQuotaResponse {
  const capturedAt = nowMs - 3 * 60_000;
  return {
    account_id: accountId,
    age_seconds: 180,
    stale: false,
    snapshot: {
      captured_at: iso(capturedAt),
      windows: [
        {
          window_id: "codex:secondary",
          limit_id: "codex",
          slot: "secondary",
          label: null,
          used_percent: 51,
          duration_minutes: 10_080,
          resets_at: iso(nowMs + 2.6 * DAY),
        },
        {
          window_id: "codex:primary",
          limit_id: "codex",
          slot: "primary",
          label: null,
          used_percent: 34,
          duration_minutes: 300,
          resets_at: iso(nowMs + 2.2 * HOUR),
        },
      ],
      limits: [{ limit_id: "codex", plan_type: "pro", credits: null, limit_reached: null }],
    },
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
  return [collector("mock-mac", "Mac", 2), collector("mock-home", "home-center", 47)];
}
