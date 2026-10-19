import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexClient, CodexClientError, normalizeCodexQuota } from "../src/codex-client.js";
import { codexIngestSchema } from "../../ua-server/src/codex-wire.js";

const EMAIL = "collector@example.test";
const QUOTA = {
  accountId: "account-a",
  access_token: "SECRET-RAW-RESPONSE",
  rateLimits: { limitId: "legacy", primary: { usedPercent: 99, windowDurationMins: 300 } },
  rateLimitsByLimitId: {
    codex: {
      limitName: null, planType: "pro", primary: { usedPercent: 44, windowDurationMins: 10080, resetsAt: 1_792_649_600 },
      secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0", token: "SECRET-CREDITS" },
    },
    another: { limitName: "Other limit", primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null }, secondary: null },
  },
};

const roots: string[] = [];
const clients: CodexClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real local pipes/process lifecycle, with a fake executable; never starts Codex or uses the network. */
function fixture(overrides: Record<string, unknown> = {}, timeoutMs = 2_000) {
  const root = mkdtempSync(join(tmpdir(), "ua-codex-client-"));
  roots.push(root);
  const binary = join(root, "fake-codex");
  const requestsPath = join(root, "requests.jsonl");
  const config = {
    email: EMAIL.toUpperCase(), quota: QUOTA,
    usage: { summary: { lifetimeTokens: 321, secret: "SECRET-SUMMARY" }, dailyUsageBuckets: [{ startDate: "2026-10-01", tokens: 123 }] },
    threads: {
      good: { threadUsage: { threadId: "good", estimatedUsageCreditsMicros: 42, estimatedUsageUsdMicros: 17, groups: [{ secret: "SECRET-GROUP" }] } },
      missing: { threadUsage: null },
      nullable: { threadUsage: { threadId: "nullable", estimatedUsageCreditsMicros: 0, estimatedUsageUsdMicros: null } },
      wrong: { threadUsage: { threadId: "someone-else", estimatedUsageCreditsMicros: 99 } },
    },
    ...overrides,
  };
  writeFileSync(binary, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const readline = require('node:readline');
const config = ${JSON.stringify(config)};
const path = ${JSON.stringify(requestsPath)};
let quotaReads = 0;
fs.writeFileSync(${JSON.stringify(join(root, "process.json"))}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), home: process.env.CODEX_HOME }));
process.stderr.write('SECRET-STDERR-NEVER-LOG');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  fs.appendFileSync(path, JSON.stringify(req) + '\\n');
  if (!('id' in req)) return;
  if (config.hangMethod === req.method) return;
  if (config.exitMethod === req.method) { process.exit(7); return; }
  if (config.invalidMethod === req.method) { process.stdout.write('SECRET-invalid-json\\n'); return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ id: req.id, result }) + '\\n');
  if (config.failMethod === req.method) {
    process.stdout.write(JSON.stringify({ id: req.id, error: { code: config.failCode ?? -32000, message: 'SECRET-RPC-MESSAGE', data: { token: 'SECRET-RPC-DATA' } } }) + '\\n'); return;
  }
  if (req.method === 'initialize') { reply({ userAgent: 'test' }); return; }
  if (req.method === 'account/read') { reply({ account: { type: config.accountType ?? 'chatgpt', email: quotaReads && config.afterQuotaEmail ? config.afterQuotaEmail : config.email, planType: config.planType === undefined ? 'pro' : config.planType, token: 'SECRET-ACCOUNT' } }); return; }
  if (req.method === 'account/rateLimits/read') {
    quotaReads++;
    const quota = structuredClone(config.quota);
    if (quotaReads > 1 && config.secondAccountId) quota.accountId = config.secondAccountId;
    process.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 999 } } } }) + '\\n');
    reply(quota); return;
  }
  if (req.method === 'account/usage/read') { reply(req.params?.threadId ? config.threads[req.params.threadId] ?? { threadUsage: null } : config.usage); return; }
  process.exit(9);
});
if (config.stubborn) {
  process.on('SIGTERM', () => {});
  rl.on('close', () => setInterval(() => {}, 1000));
}
`, { mode: 0o755 });
  const client = new CodexClient({ binaryPath: binary, codexHome: root, timeoutMs });
  clients.push(client);
  return {
    client,
    requests: () => readFileSync(requestsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    metadata: () => JSON.parse(readFileSync(join(root, "process.json"), "utf8")) as { pid: number; args: string[]; home: string },
    root,
  };
}

describe("normalizeCodexQuota", () => {
  it("uses the multi-bucket full snapshot, retains a 7-day primary and unknown durations, and skips null secondary", () => {
    const quota = normalizeCodexQuota(QUOTA, "2026-10-18T00:00:00.000Z");
    expect(quota.windows).toHaveLength(2);
    expect(quota.windows[0]).toMatchObject({ window_id: "codex:primary", limit_id: "codex", used_percent: 44, duration_minutes: 10080 });
    expect(quota.windows[1]).toMatchObject({ duration_minutes: null, resets_at: null, used_percent: 0 });
    expect(quota.limits[0]?.credits).toEqual({ has_credits: false, unlimited: false, balance: "0" });
    expect(JSON.stringify(quota)).not.toContain("SECRET");
    expect(JSON.stringify(quota)).not.toContain("legacy");
    expect(codexIngestSchema.shape.quota.unwrap().safeParse(quota).success).toBe(true);
  });

  it("falls back to legacy only when the multi-bucket map is unavailable, not when explicitly empty", () => {
    expect(normalizeCodexQuota({ rateLimits: QUOTA.rateLimits, rateLimitsByLimitId: null }).windows[0]?.duration_minutes).toBe(300);
    expect(normalizeCodexQuota({ rateLimits: QUOTA.rateLimits, rateLimitsByLimitId: {} }).windows).toEqual([]);
    expect(() => normalizeCodexQuota({ unrelated: true })).toThrow("INVALID_RESPONSE");
  });

  it.each([-1, 101, Number.NaN, Infinity, -Infinity, "44", null, undefined])("rejects the whole snapshot for invalid usedPercent=%s without clamping or dropping a window", (usedPercent) => {
    const value = { rateLimitsByLimitId: {
      valid: { primary: { usedPercent: 25, windowDurationMins: 300 } },
      invalid: { primary: { usedPercent, windowDurationMins: 300 } },
    } };
    expect(() => normalizeCodexQuota(value)).toThrow(CodexClientError);
    expect(() => normalizeCodexQuota(value)).toThrow("INVALID_RESPONSE");
  });

  it("normalizes a zero duration to unknown and accepts the wire contract's percentage/duration boundaries", () => {
    const quota = normalizeCodexQuota({ rateLimitsByLimitId: {
      zero: { primary: { usedPercent: 0, windowDurationMins: 0 } },
      maximum: { primary: { usedPercent: 100, windowDurationMins: 5_256_000 } },
      fractional: { primary: { usedPercent: 0.5, windowDurationMins: null } },
    } });
    expect(quota.windows.map((window) => window.duration_minutes)).toEqual([null, 5_256_000, null]);
    expect(quota.windows.map((window) => window.used_percent)).toEqual([0, 100, 0.5]);
    expect(codexIngestSchema.shape.quota.unwrap().safeParse(quota).success).toBe(true);
  });

  it.each([-1, 1.5, 5_256_001, "300", Infinity])("rejects an invalid supplied duration %s rather than queueing a wire-invalid snapshot", (windowDurationMins) => {
    expect(() => normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 1, windowDurationMins } } })).toThrow("INVALID_RESPONSE");
  });

  it.each([
    ["too many buckets", { rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), {}])) }],
    ["empty limit ID", { rateLimitsByLimitId: { "": {} } }],
    ["long limit ID", { rateLimitsByLimitId: { ["x".repeat(257)]: {} } }],
    ["encoded window ID exceeds 256", { rateLimitsByLimitId: { ["宽".repeat(40)]: { primary: { usedPercent: 1 } } } }],
    ["invalid Unicode ID", { rateLimitsByLimitId: { "\ud800": { primary: { usedPercent: 1 } } } }],
    ["long label", { rateLimits: { limitName: "x".repeat(257), primary: { usedPercent: 1 } } }],
    ["long plan", { rateLimits: { planType: "x".repeat(257) } }],
    ["long reached label", { rateLimits: { rateLimitReachedType: "x".repeat(257) } }],
    ["long credit balance", { rateLimits: { credits: { hasCredits: true, unlimited: false, balance: "1".repeat(101) } } }],
    ["invalid credit flag", { rateLimits: { credits: { hasCredits: "true", unlimited: false, balance: "1" } } }],
    ["malformed bucket", { rateLimitsByLimitId: { codex: null } }],
    ["malformed map", { rateLimitsByLimitId: [], rateLimits: {} }],
    ["expanded timestamp year", { rateLimits: { primary: { usedPercent: 1, resetsAt: 253402300800 } } }],
  ])("rejects unsupported metadata before durable enqueue: %s", (_name, value) => {
    expect(() => normalizeCodexQuota(value)).toThrow("INVALID_RESPONSE");
  });

  it("validates capture timestamps and allows all 100 buckets / 200 windows within the wire bounds", () => {
    expect(() => normalizeCodexQuota(QUOTA, "not-an-iso-date")).toThrow("INVALID_RESPONSE");
    const quota = normalizeCodexQuota({ rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), {
      primary: { usedPercent: 0 }, secondary: { usedPercent: 100 },
    }])) });
    expect(quota.windows).toHaveLength(200);
    expect(codexIngestSchema.shape.quota.unwrap().safeParse(quota).success).toBe(true);
  });
});

describe("CodexClient read-only stdio protocol", () => {
  it("verifies email and stable account ID, sends only approved reads, and normalizes complete snapshots", async () => {
    const { client, requests, metadata, root } = fixture();
    await Promise.all([client.start(), client.start()]);
    const { account, quota } = await client.readAccount(EMAIL);
    const usage = await client.readUsage(["good", "nullable", "missing", "wrong", "good"]);
    await client.close();
    expect(account).toEqual({ account_id: "account-a", email: EMAIL, plan_type: "pro" });
    expect(quota.windows[0]?.used_percent).toBe(44); // Never the sparse notification's 999.
    expect(usage.daily).toEqual([{ date: "2026-10-01", tokens: 123 }]);
    expect(usage.lifetime_tokens).toBe(321);
    expect(usage.threads).toEqual([
      { session_id: "good", estimated_credits_micros: 42, estimated_usd_micros: 17 },
      { session_id: "nullable", estimated_credits_micros: 0, estimated_usd_micros: null },
    ]);
    expect(client.usageErrors).toEqual([
      { session_id: "missing", code: "THREAD_USAGE_UNAVAILABLE" },
      { session_id: "wrong", code: "INVALID_RESPONSE" },
    ]);
    expect(JSON.stringify({ account, quota, usage, errors: client.usageErrors })).not.toContain("SECRET");
    expect(codexIngestSchema.shape.account.safeParse(account).success).toBe(true);
    expect(codexIngestSchema.shape.account_usage.unwrap().safeParse(usage).success).toBe(true);
    const seen = requests();
    expect(seen.filter((req) => req.method === "initialize")).toHaveLength(1);
    expect(seen[1]?.method).toBe("initialized");
    expect(new Set(seen.map((req) => req.method))).toEqual(new Set(["initialize", "initialized", "account/read", "account/rateLimits/read", "account/usage/read"]));
    expect(seen.filter((req) => req.method === "account/read").every((req) => req.params.refreshToken === false)).toBe(true);
    expect(metadata()).toMatchObject({ args: ["app-server", "--listen", "stdio://"], home: root });
    expect(() => process.kill(metadata().pid, 0)).toThrow();
  });

  it("does not query quota or usage for a mismatching login", async () => {
    const { client, requests } = fixture({ email: "other@example.test" });
    await expect(client.readAccount(EMAIL)).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(requests().some((req) => req.method === "account/rateLimits/read")).toBe(false);
    await expect(client.readUsage()).rejects.toMatchObject({ code: "NOT_VERIFIED" });
  });

  it("rejects non-subscription authentication and a missing stable account ID", async () => {
    const first = fixture({ accountType: "apiKey" });
    await expect(first.client.readAccount(EMAIL)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    const second = fixture({ quota: { ...QUOTA, accountId: null } });
    await expect(second.client.readAccount(EMAIL)).rejects.toMatchObject({ code: "ACCOUNT_ID_UNAVAILABLE" });
  });

  it("detects account changes during and between reads", async () => {
    const during = fixture({ afterQuotaEmail: "other@example.test" });
    await expect(during.client.readAccount(EMAIL)).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    const between = fixture({ secondAccountId: "account-b" });
    await between.client.readAccount(EMAIL);
    await expect(between.client.readAccount(EMAIL)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
  });

  it("lets an unavailable usage endpoint degrade independently of a successful quota snapshot", async () => {
    const { client } = fixture({ failMethod: "account/usage/read", failCode: -32601 });
    const { quota } = await client.readAccount(EMAIL);
    await expect(client.readUsage()).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });
    expect(quota.windows[0]?.duration_minutes).toBe(10080);
  });

  it("preserves unavailable token data as null rather than zero", async () => {
    const { client } = fixture({ usage: { summary: {}, dailyUsageBuckets: null } });
    await client.readAccount(EMAIL);
    expect(await client.readUsage()).toMatchObject({ daily: null, lifetime_tokens: null, threads: [] });
  });

  it.each([
    ["account ID length", { quota: { ...QUOTA, accountId: "x".repeat(257) } }, EMAIL],
    ["plan length", { planType: "x".repeat(257) }, EMAIL],
    ["email format", { email: "invalid-email" }, "invalid-email"],
  ])("rejects wire-invalid account metadata: %s", async (_name, config, email) => {
    const { client } = fixture(config as Record<string, unknown>);
    await expect(client.readAccount(email as string)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    ["too many days", { summary: {}, dailyUsageBuckets: Array.from({ length: 10_001 }, () => ({ startDate: "2026-10-01", tokens: 1 })) }],
    ["invalid daily counter", { summary: {}, dailyUsageBuckets: [{ startDate: "2026-10-01", tokens: -1 }] }],
    ["invalid daily date", { summary: {}, dailyUsageBuckets: [{ startDate: "SECRET-BAD-DATE", tokens: 1 }] }],
    ["invalid lifetime counter", { summary: { lifetimeTokens: Number.MAX_SAFE_INTEGER + 1 }, dailyUsageBuckets: null }],
  ])("rejects malformed official usage without manufacturing an empty history: %s", async (_name, usage) => {
    const { client } = fixture({ usage });
    const { quota } = await client.readAccount(EMAIL);
    await expect(client.readUsage()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(codexIngestSchema.shape.quota.unwrap().safeParse(quota).success).toBe(true);
  });

  it("rejects oversized thread requests before RPC and withholds invalid thread monetary estimates", async () => {
    const { client, requests } = fixture({ threads: {
      invalid: { threadUsage: { threadId: "invalid", estimatedUsageCreditsMicros: 1, estimatedUsageUsdMicros: -1 } },
    } });
    await client.readAccount(EMAIL);
    const before = requests().length;
    await expect(client.readUsage(Array.from({ length: 50_001 }, (_, i) => String(i)))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client.readUsage(["x".repeat(257)])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(requests()).toHaveLength(before);
    const usage = await client.readUsage(["invalid"]);
    expect(usage.threads).toEqual([]);
    expect(client.usageErrors).toEqual([{ session_id: "invalid", code: "INVALID_RESPONSE" }]);
    expect(codexIngestSchema.shape.account_usage.unwrap().safeParse(usage).success).toBe(true);
  });

  it.each([
    [{ failMethod: "initialize" }, "RPC_ERROR"],
    [{ exitMethod: "initialize" }, "PROCESS_EXIT"],
    [{ invalidMethod: "initialize" }, "PROTOCOL"],
    [{ hangMethod: "initialize", stubborn: true }, "TIMEOUT"],
  ])("returns safe failure codes and terminates its child: %j", async (config, code) => {
    const { client, metadata } = fixture(config as Record<string, unknown>, 1_500);
    let caught: unknown;
    try { await client.start(); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code });
    expect(String(caught)).not.toContain("SECRET");
    await client.close();
    expect(() => process.kill(metadata().pid, 0)).toThrow();
  });

  it("handles missing executables without leaking spawn diagnostics", async () => {
    const client = new CodexClient({ binaryPath: "/missing/SECRET-codex-binary", timeoutMs: 100 });
    clients.push(client);
    await expect(client.start()).rejects.toMatchObject({ code: "PROCESS_START" });
    await client.close();
    await expect(client.start()).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("close interrupts an outstanding read and kills a child that ignores EOF and SIGTERM", async () => {
    const { client, metadata } = fixture({ hangMethod: "account/usage/read", stubborn: true });
    await client.readAccount(EMAIL);
    const pending = client.readUsage();
    const assertion = expect(pending).rejects.toMatchObject({ code: "CLOSED" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await client.close();
    await assertion;
    expect(() => process.kill(metadata().pid, 0)).toThrow();
  });
});
