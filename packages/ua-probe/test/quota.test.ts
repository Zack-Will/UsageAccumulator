import { describe, expect, it, vi } from "vitest";
import {
  ClaudeWebSource,
  extractOrgId,
  parseUsageResponse,
  QuotaAuthError,
  type HttpGet,
  type QuotaSource,
} from "../src/quota.js";
import { QuotaFetcher, noopNotifier } from "../src/quota-fetcher.js";
import { ProbeStore } from "../src/store.js";
import { makeConfig, silentLog } from "./helpers.js";
import type { CredentialStore } from "../src/credentials.js";

/** 官方 usage 响应的假 fixture（字段名未经实测确认，刻意混入未知窗口与非窗口对象）。 */
const USAGE_FIXTURE = {
  five_hour: { utilization_pct: 62.0, resets_at: "2026-09-21T10:30:00Z" },
  seven_day: { utilization_pct: 41.5, resets_at: "2026-09-24T01:00:00Z" },
  // 官方很可能已经改名（ARCHITECTURE §2.2），探针必须原样透传而不是丢掉
  seven_day_fable: { utilization_pct: 73.25, resets_at: "2026-09-24T01:00:00Z" },
  extra_usage: { budget_usd: 50, spent_usd: 12.5 },
  account_uuid: "not-an-object",
};

const ORGS_FIXTURE = [{ uuid: "org-123", name: "Personal" }];

const fakeCreds: CredentialStore = {
  kind: "test",
  async read() {
    return "SECRET-SESSION-KEY";
  },
  hint() {
    return "test";
  },
};

function fakeHttp(routes: Record<string, { status: number; body: unknown }>): { get: HttpGet; seen: string[]; headers: Record<string, string>[] } {
  const seen: string[] = [];
  const headers: Record<string, string>[] = [];
  const get: HttpGet = async (url, h) => {
    seen.push(url);
    headers.push(h);
    const r = routes[url];
    if (!r) return { status: 404, text: "{}" };
    return { status: r.status, text: JSON.stringify(r.body) };
  };
  return { get, seen, headers };
}

describe("parseUsageResponse", () => {
  it("window_kind 按返回的 key 原样透传，不硬编码枚举", () => {
    const windows = parseUsageResponse(USAGE_FIXTURE);
    expect(windows.map((w) => w.windowKind)).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
    expect(windows[0]?.utilizationPct).toBe(62.0);
    expect(windows[0]?.resetsAt?.toISOString()).toBe("2026-09-21T10:30:00.000Z");
  });

  it("没有利用率的对象（extra_usage）不当窗口，只进 raw", () => {
    const windows = parseUsageResponse(USAGE_FIXTURE);
    expect(windows.find((w) => w.windowKind === "extra_usage")).toBeUndefined();
  });

  // ★ 这条断言原本是 0.62 → 62，把「小于 1 就当成比例」的启发式写进了契约。
  // 2026-09-21 实测：body 里的 utilization 本来就是 0..100，该启发式会把 1% 读成 100%。
  it("utilization 原样保留量纲，不做 0..1 推断；兼容 reset_at 旧字段名", () => {
    const windows = parseUsageResponse({ five_hour: { utilization: 0.62, reset_at: "2026-09-21T10:30:00Z" } });
    expect(windows[0]?.utilizationPct).toBeCloseTo(0.62, 6);
    expect(windows[0]?.resetsAt?.toISOString()).toBe("2026-09-21T10:30:00.000Z");
  });

  it("utilization > 1 视为已经是百分比", () => {
    expect(parseUsageResponse({ w: { utilization: 62 } })[0]?.utilizationPct).toBe(62);
  });

  it("没有 resets_at 时为 null，不猜", () => {
    expect(parseUsageResponse({ w: { utilization_pct: 1 } })[0]?.resetsAt).toBeNull();
  });

  it("垃圾输入不抛", () => {
    expect(parseUsageResponse(null)).toEqual([]);
    expect(parseUsageResponse([1, 2])).toEqual([]);
    expect(parseUsageResponse("x")).toEqual([]);
  });
});

describe("extractOrgId", () => {
  it("从数组或对象里取 uuid", () => {
    expect(extractOrgId(ORGS_FIXTURE)).toBe("org-123");
    expect(extractOrgId({ uuid: "org-9" })).toBe("org-9");
    expect(extractOrgId([])).toBeNull();
  });
});

describe("ClaudeWebSource（假 HTTP，不发真实请求）", () => {
  const base = "https://claude.ai";
  const routes = {
    [`${base}/api/organizations`]: { status: 200, body: ORGS_FIXTURE },
    [`${base}/api/organizations/org-123/usage`]: { status: 200, body: USAGE_FIXTURE },
  };

  it("先拿 org_id 再拉 usage，raw 原文保留", async () => {
    const http = fakeHttp(routes);
    const src = new ClaudeWebSource(fakeCreds, base, http.get);
    const snap = await src.fetch("claude-official", new Date("2026-09-21T02:30:00Z"));

    expect(http.seen).toEqual([`${base}/api/organizations`, `${base}/api/organizations/org-123/usage`]);
    expect(snap.profileId).toBe("claude-official");
    expect(snap.capturedAt.toISOString()).toBe("2026-09-21T02:30:00.000Z");
    expect(snap.windows).toHaveLength(3);
    expect(snap.raw).toEqual(USAGE_FIXTURE);
  });

  it("org_id 缓存，第二次不再打 organizations", async () => {
    const http = fakeHttp(routes);
    const src = new ClaudeWebSource(fakeCreds, base, http.get);
    await src.fetch("p");
    await src.fetch("p");
    expect(http.seen.filter((u) => u.endsWith("/organizations"))).toHaveLength(1);
  });

  it("sessionKey 只出现在 Cookie 头里，不进 snapshot", async () => {
    const http = fakeHttp(routes);
    const src = new ClaudeWebSource(fakeCreds, base, http.get);
    const snap = await src.fetch("p");
    expect(http.headers[0]?.["cookie"]).toBe("sessionKey=SECRET-SESSION-KEY");
    expect(JSON.stringify(snap)).not.toContain("SECRET-SESSION-KEY");
  });

  it("401 → QuotaAuthError", async () => {
    const http = fakeHttp({ [`${base}/api/organizations`]: { status: 401, body: {} } });
    const src = new ClaudeWebSource(fakeCreds, base, http.get);
    await expect(src.fetch("p")).rejects.toBeInstanceOf(QuotaAuthError);
  });

  it("凭证读不到 → QuotaAuthError，且一次 HTTP 都不发", async () => {
    const http = fakeHttp(routes);
    const empty: CredentialStore = { kind: "none", async read() { return null; }, hint() { return "放进去"; } };
    const src = new ClaudeWebSource(empty, base, http.get);
    await expect(src.fetch("p")).rejects.toBeInstanceOf(QuotaAuthError);
    expect(http.seen).toHaveLength(0);
  });
});

describe("QuotaFetcher", () => {
  const cfg = makeConfig().quota;

  function fetcherWith(source: QuotaSource, notifier = noopNotifier) {
    const store = new ProbeStore(":memory:");
    const f = new QuotaFetcher({ ...cfg, profile_id: "claude-official" }, source, store, silentLog, notifier, () => 0.5);
    return { f, store };
  }

  it("成功后快照进队列，内容是契约 §1.3 的线格式", async () => {
    const source: QuotaSource = {
      id: "fake",
      async fetch(profileId, now) {
        return {
          profileId,
          capturedAt: now ?? new Date(),
          windows: parseUsageResponse(USAGE_FIXTURE),
          raw: USAGE_FIXTURE,
        };
      },
    };
    const { f, store } = fetcherWith(source);
    const out = await f.tick(new Date("2026-09-21T02:30:00Z"));
    expect(out).toEqual({ ok: true, windows: 3 });

    const row = store.takeQuota(1)[0];
    const doc = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(doc["profile_id"]).toBe("claude-official");
    expect(doc["captured_at"]).toBe("2026-09-21T02:30:00.000Z");
    expect(doc["windows"]).toEqual([
      { window_kind: "five_hour", utilization_pct: 62, resets_at: "2026-09-21T10:30:00.000Z" },
      { window_kind: "seven_day", utilization_pct: 41.5, resets_at: "2026-09-24T01:00:00.000Z" },
      { window_kind: "seven_day_fable", utilization_pct: 73.25, resets_at: "2026-09-24T01:00:00.000Z" },
    ]);
    expect(doc["raw"]).toEqual(USAGE_FIXTURE);
    store.close();
  });

  it("401 走退避阶梯并弹窗提示，不是立刻重试（避免被风控）", async () => {
    const notify = vi.fn(async () => undefined);
    const source: QuotaSource = {
      id: "fake",
      async fetch() {
        throw new QuotaAuthError("expired", 401);
      },
    };
    const { f, store } = fetcherWith(source, { notify });

    expect(f.nextDelayMs()).toBe(330_000); // 正常节奏：300s + 0.5×60s 抖动

    await f.tick();
    expect(f.lastOutcome).toMatchObject({ ok: false, kind: "auth" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(f.nextDelayMs()).toBeGreaterThanOrEqual(900_000); // 第一级退避 15min

    await f.tick();
    expect(f.nextDelayMs()).toBeGreaterThanOrEqual(3_600_000); // 第二级 1h

    await f.tick();
    await f.tick();
    expect(f.nextDelayMs()).toBeGreaterThanOrEqual(21_600_000); // 封顶 6h，不再加速
    expect(store.quotaDepth()).toBe(0);
    store.close();
  });

  it("弹窗消息里没有凭证", async () => {
    const messages: string[] = [];
    const source: QuotaSource = {
      id: "fake",
      async fetch() {
        throw new QuotaAuthError("凭证 SECRET-SESSION-KEY 失效", 401);
      },
    };
    const { f, store } = fetcherWith(source, {
      async notify(_t, m) {
        messages.push(m);
      },
    });
    await f.tick();
    expect(messages.join()).not.toContain("SECRET-SESSION-KEY");
    store.close();
  });

  it("恢复成功后回到正常节奏", async () => {
    let fail = true;
    const source: QuotaSource = {
      id: "fake",
      async fetch(profileId, now) {
        if (fail) throw new QuotaAuthError("x", 401);
        return { profileId, capturedAt: now ?? new Date(), windows: [], raw: {} };
      },
    };
    const { f, store } = fetcherWith(source);
    await f.tick();
    expect(f.nextDelayMs()).toBeGreaterThan(600_000);
    fail = false;
    await f.tick();
    expect(f.nextDelayMs()).toBe(330_000);
    store.close();
  });

  it("非鉴权错误不升级退避", async () => {
    const source: QuotaSource = {
      id: "fake",
      async fetch() {
        throw new Error("ECONNRESET");
      },
    };
    const { f, store } = fetcherWith(source);
    await f.tick();
    expect(f.lastOutcome).toMatchObject({ ok: false, kind: "error" });
    expect(f.nextDelayMs()).toBe(330_000);
    store.close();
  });
});

/**
 * 2026-09-21 实测的真实响应形状（组织 uuid 已换成占位符，百分比保留量纲特征）。
 * 三个要点：老的 seven_day_* per-model 字段值是 null；per-model 改由 limits[] 承载；
 * utilization 与 limits[].percent 量纲一致，都是 0..100。
 */
const REAL_USAGE_FIXTURE = {
  five_hour: { utilization: 0, resets_at: "2026-09-21T17:39:59.943116+00:00" },
  seven_day: { utilization: 80, resets_at: "2026-09-21T23:00:00.943141+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, utilization: null },
  limits: [
    { group: "session", kind: "session", percent: 0, resets_at: "2026-09-21T17:39:59.943116+00:00", scope: null, severity: "normal" },
    { group: "weekly", kind: "weekly_all", percent: 80, resets_at: "2026-09-21T23:00:00.943141+00:00", scope: null, severity: "warning" },
    {
      group: "weekly",
      kind: "weekly_scoped",
      percent: 98,
      resets_at: "2026-09-21T22:59:59.943355+00:00",
      scope: { model: { display_name: "Fable", id: null }, surface: null },
      severity: "critical",
    },
  ],
};

describe("limits[] 与量纲", () => {
  it("utilization 是 0..100，1 不能被当成比例放大成 100", () => {
    const [w] = parseUsageResponse({ five_hour: { utilization: 1, resets_at: null } });
    expect(w?.utilizationPct).toBe(1);
  });

  it("从 limits[] 取出按模型细分的窗口", () => {
    const windows = parseUsageResponse(REAL_USAGE_FIXTURE);
    const byKind = new Map(windows.map((w) => [w.windowKind, w]));
    // 真正卡住用户的那一档：扁平 key 里完全没有
    expect(byKind.get("seven_day_fable")?.utilizationPct).toBe(98);
    expect(byKind.get("seven_day")?.utilizationPct).toBe(80);
    expect(byKind.get("five_hour")?.utilizationPct).toBe(0);
  });

  it("扁平 key 与 limits[] 指向同一窗口时不重复入列", () => {
    const windows = parseUsageResponse(REAL_USAGE_FIXTURE);
    const kinds = windows.map((w) => w.windowKind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.filter((k) => k === "seven_day")).toHaveLength(1);
  });

  it("值为 null 的老字段不产生窗口", () => {
    const kinds = parseUsageResponse(REAL_USAGE_FIXTURE).map((w) => w.windowKind);
    expect(kinds).not.toContain("seven_day_opus");
  });

  it("没见过的 kind 原样带出，不静默丢窗口", () => {
    const windows = parseUsageResponse({ limits: [{ kind: "monthly_whatever", percent: 12 }] });
    expect(windows[0]?.windowKind).toBe("monthly_whatever");
    expect(windows[0]?.utilizationPct).toBe(12);
  });
});

describe("多组织时选对 org", () => {
  it("优先带 raven capability 的组织，而不是列表里的第一个", () => {
    const orgs = [
      { uuid: "org-personal", name: "personal", capabilities: ["chat"], rate_limit_tier: "default_claude_ai" },
      { uuid: "org-code", name: "work", capabilities: ["chat", "raven"], rate_limit_tier: "default_raven" },
    ];
    expect(extractOrgId(orgs)).toBe("org-code");
  });

  it("没有 raven 时回退到第一个有 uuid 的", () => {
    expect(extractOrgId([{ name: "no uuid" }, { uuid: "org-a" }, { uuid: "org-b" }])).toBe("org-a");
  });
});
