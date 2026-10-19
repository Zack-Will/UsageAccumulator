import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { CodexAccount, CodexAccountUsageSnapshot, CodexQuotaSnapshot } from "@ua/core";

export type CodexClientErrorCode =
  | "AUTH_REQUIRED" | "ACCOUNT_MISMATCH" | "ACCOUNT_CHANGED" | "ACCOUNT_ID_UNAVAILABLE"
  | "NOT_VERIFIED" | "RPC_UNAVAILABLE" | "RPC_ERROR" | "TIMEOUT" | "PROCESS_START"
  | "PROCESS_EXIT" | "PROTOCOL" | "CLOSED" | "INVALID_RESPONSE" | "THREAD_USAGE_UNAVAILABLE";

/** Deliberately never retain an upstream error message, stderr, or error.data. */
export class CodexClientError extends Error {
  constructor(public readonly code: CodexClientErrorCode) {
    super(`Codex read-only client: ${code}`);
    this.name = "CodexClientError";
  }
}

export interface CodexClientOptions {
  binaryPath?: string;
  codexHome?: string;
  timeoutMs?: number;
}

type ReadMethod = "initialize" | "account/read" | "account/rateLimits/read" | "account/usage/read";
const READ_METHODS = new Set<ReadMethod>(["initialize", "account/read", "account/rateLimits/read", "account/usage/read"]);
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Keep normalized output inside the ingestion contract before it enters a durable outbox.
// Tests validate these boundaries against the server's actual codexIngestSchema.
const isoTimestamp = z.string().datetime({ offset: true });
const emailAddress = z.string().email().max(320);
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new CodexClientError("INVALID_RESPONSE");
  return value;
}
function nullableText(value: unknown, max = 256): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > max) throw new CodexClientError("INVALID_RESPONSE");
  return value;
}
function nullableCount(value: unknown): number | null {
  if (value == null) return null;
  const number = count(value);
  if (number === null) throw new CodexClientError("INVALID_RESPONSE");
  return number;
}
function capturedTimestamp(value: string): string {
  if (!isoTimestamp.safeParse(value).success) throw new CodexClientError("INVALID_RESPONSE");
  return new Date(value).toISOString();
}

function timestamp(seconds: unknown): string | null {
  if (seconds == null) return null;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) throw new CodexClientError("INVALID_RESPONSE");
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) throw new CodexClientError("INVALID_RESPONSE");
  return capturedTimestamp(date.toISOString());
}

function duration(value: unknown): number | null {
  if (value == null || value === 0) return null; // No meaningful duration was supplied.
  const minutes = count(value);
  if (minutes === null || minutes > 5_256_000) throw new CodexClientError("INVALID_RESPONSE");
  return minutes;
}

/** Only call with a complete account/rateLimits/read result, never a sparse notification. */
export function normalizeCodexQuota(value: unknown, capturedAt = new Date().toISOString()): CodexQuotaSnapshot {
  const response = object(value);
  if (!response) throw new CodexClientError("INVALID_RESPONSE");
  const byLimitId = object(response.rateLimitsByLimitId);
  if (response.rateLimitsByLimitId != null && !byLimitId) throw new CodexClientError("INVALID_RESPONSE");
  const legacy = object(response.rateLimits);
  if (!byLimitId && !legacy) throw new CodexClientError("INVALID_RESPONSE");
  // An explicitly empty multi-bucket map is authoritative; do not revive a stale legacy bucket.
  const buckets = byLimitId ? Object.entries(byLimitId) : [[string(legacy?.limitId) ?? "codex", legacy]] as const;
  if (buckets.length > 100) throw new CodexClientError("INVALID_RESPONSE");
  const snapshot: CodexQuotaSnapshot = { captured_at: capturedTimestamp(capturedAt), windows: [], limits: [] };
  for (const [key, raw] of buckets) {
    const limit = object(raw);
    if (!limit) throw new CodexClientError("INVALID_RESPONSE");
    const limitId = text(key);
    const credit = object(limit.credits);
    if (limit.credits != null && (!credit || typeof credit.hasCredits !== "boolean" || typeof credit.unlimited !== "boolean")) {
      throw new CodexClientError("INVALID_RESPONSE");
    }
    const balance = nullableText(credit?.balance, 100);
    snapshot.limits.push({
      limit_id: limitId,
      plan_type: nullableText(limit.planType),
      credits: credit ? {
        has_credits: credit.hasCredits as boolean,
        unlimited: credit.unlimited as boolean,
        balance: balance && /^-?\d+(?:\.\d+)?$/.test(balance) ? balance : null,
      } : null,
      limit_reached: nullableText(limit.rateLimitReachedType),
    });
    for (const slot of ["primary", "secondary"] as const) {
      if (limit[slot] == null) continue;
      const window = object(limit[slot]);
      if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)
        || window.usedPercent < 0 || window.usedPercent > 100) throw new CodexClientError("INVALID_RESPONSE");
      let windowId: string;
      try { windowId = text(`${encodeURIComponent(limitId)}:${slot}`); }
      catch { throw new CodexClientError("INVALID_RESPONSE"); }
      snapshot.windows.push({
        window_id: windowId,
        limit_id: limitId,
        slot,
        label: nullableText(limit.limitName),
        used_percent: window.usedPercent,
        duration_minutes: duration(window.windowDurationMins),
        resets_at: timestamp(window.resetsAt),
      });
    }
  }
  return snapshot;
}

function normalizeAccountUsage(value: unknown): Pick<CodexAccountUsageSnapshot, "daily" | "lifetime_tokens"> {
  const response = object(value);
  const summary = object(response?.summary);
  if (!response || !summary) throw new CodexClientError("INVALID_RESPONSE");
  const rawDaily = response.dailyUsageBuckets;
  if (rawDaily != null && (!Array.isArray(rawDaily) || rawDaily.length > 10_000)) throw new CodexClientError("INVALID_RESPONSE");
  const daily = Array.isArray(rawDaily) ? rawDaily.map((raw) => {
    const bucket = object(raw);
    const date = string(bucket?.startDate);
    const tokens = count(bucket?.tokens);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || tokens === null) throw new CodexClientError("INVALID_RESPONSE");
    return { date, tokens };
  }) : null;
  return { daily, lifetime_tokens: nullableCount(summary.lifetimeTokens) };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: CodexClientError): void;
  timer: NodeJS.Timeout;
}

/** Owns one short-lived app-server process. No login, refresh, reset, or model requests. */
export class CodexClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private account: CodexAccount | null = null;
  private boundAccountId: string | null = null;
  private expectedEmail: string | null = null;
  /** Partial thread-estimate failures; safe codes only, never server messages. */
  readonly usageErrors: Array<{ session_id: string; code: CodexClientErrorCode }> = [];

  constructor(private readonly options: CodexClientOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new CodexClientError("INVALID_RESPONSE");
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new CodexClientError("CLOSED");
    if (this.starting) return this.starting;
    this.starting = this.initialize();
    return this.starting;
  }

  private async initialize(): Promise<void> {
    try {
      const child = spawn(this.options.binaryPath ?? "codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(this.options.codexHome ? { CODEX_HOME: this.options.codexHome } : {}) },
        windowsHide: true,
      });
      this.process = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.receive(chunk));
      // Drain without collecting or logging diagnostics, which can contain credentials.
      child.stderr.resume();
      child.stdin.on("error", () => this.fail(new CodexClientError("PROCESS_EXIT")));
      child.on("error", () => this.fail(new CodexClientError("PROCESS_START")));
      child.on("exit", () => this.fail(new CodexClientError("PROCESS_EXIT")));
      await this.request("initialize", {
        clientInfo: { name: "usage-accumulator", title: "UsageAccumulator read-only collector", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      });
      // Required protocol handshake notification; it does not start a thread or model turn.
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    } catch (error) {
      await this.close();
      throw error instanceof CodexClientError ? error : new CodexClientError("PROCESS_START");
    }
  }

  private fail(error: CodexClientError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    // Bound malformed/no-newline output without ever exposing it to diagnostics.
    if (Buffer.byteLength(this.buffer, "utf8") > 4 * 1024 * 1024) {
      this.fail(new CodexClientError("PROTOCOL"));
      void this.close();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: ObjectValue | null;
      try { message = object(JSON.parse(line)); } catch {
        this.fail(new CodexClientError("PROTOCOL"));
        void this.close();
        return;
      }
      // Notifications, including sparse quota updates, never enter complete snapshots.
      if (!message || typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        const code = object(message.error)?.code;
        pending.reject(new CodexClientError(code === -32601 ? "RPC_UNAVAILABLE" : code === 401 || code === 403 ? "AUTH_REQUIRED" : "RPC_ERROR"));
      } else if (Object.hasOwn(message, "result")) {
        pending.resolve(message.result);
      } else {
        pending.reject(new CodexClientError("PROTOCOL"));
      }
    }
  }

  private request(method: ReadMethod, params: unknown): Promise<unknown> {
    if (!READ_METHODS.has(method)) return Promise.reject(new CodexClientError("PROTOCOL"));
    const child = this.process;
    if (this.closed || !child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new CodexClientError("CLOSED"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexClientError("TIMEOUT"));
        void this.close();
      }, this.options.timeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.fail(new CodexClientError("PROCESS_EXIT"));
      });
    });
  }

  private async checkEmail(expectedEmail: string): Promise<{ email: string; planType: string | null }> {
    const response = object(await this.request("account/read", { refreshToken: false }));
    const account = object(response?.account);
    if (account?.type !== "chatgpt" || !string(account.email)) {
      this.account = null;
      throw new CodexClientError("AUTH_REQUIRED");
    }
    const email = (account.email as string).trim().toLowerCase();
    if (!emailAddress.safeParse(email).success) throw new CodexClientError("INVALID_RESPONSE");
    if (!expectedEmail.trim() || email !== expectedEmail.trim().toLowerCase()) {
      this.account = null;
      throw new CodexClientError("ACCOUNT_MISMATCH");
    }
    return { email, planType: nullableText(account.planType) };
  }

  async readAccount(expectedEmail: string): Promise<{ account: CodexAccount; quota: CodexQuotaSnapshot }> {
    await this.start();
    const identity = await this.checkEmail(expectedEmail);
    const response = object(await this.request("account/rateLimits/read", null));
    const accountId = string(response?.accountId);
    if (!accountId) throw new CodexClientError("ACCOUNT_ID_UNAVAILABLE");
    text(accountId);
    if (this.boundAccountId && this.boundAccountId !== accountId) {
      this.account = null;
      throw new CodexClientError("ACCOUNT_CHANGED");
    }
    // Catch an account switch while the quota request was in flight.
    await this.checkEmail(expectedEmail);
    const quota = normalizeCodexQuota(response);
    this.account = { account_id: accountId, email: identity.email, plan_type: identity.planType };
    this.boundAccountId = accountId;
    this.expectedEmail = identity.email;
    return { account: { ...this.account }, quota };
  }

  async readUsage(threadIds: string[] = []): Promise<CodexAccountUsageSnapshot> {
    if (!this.account || !this.expectedEmail) throw new CodexClientError("NOT_VERIFIED");
    this.usageErrors.length = 0;
    const uniqueThreadIds = [...new Set(threadIds)];
    if (uniqueThreadIds.length > 50_000) throw new CodexClientError("INVALID_RESPONSE");
    for (const sessionId of uniqueThreadIds) text(sessionId);
    await this.checkEmail(this.expectedEmail);
    const summary = normalizeAccountUsage(await this.request("account/usage/read", null));
    const snapshot: CodexAccountUsageSnapshot = { captured_at: new Date().toISOString(), ...summary, threads: [] };
    for (const sessionId of uniqueThreadIds) {
      try {
        const response = object(await this.request("account/usage/read", { threadId: sessionId }));
        const usage = object(response?.threadUsage);
        if (!usage) throw new CodexClientError("THREAD_USAGE_UNAVAILABLE");
        const credits = count(usage.estimatedUsageCreditsMicros);
        if (usage.threadId !== sessionId || credits === null) throw new CodexClientError("INVALID_RESPONSE");
        snapshot.threads.push({
          session_id: sessionId,
          estimated_credits_micros: credits,
          estimated_usd_micros: nullableCount(usage.estimatedUsageUsdMicros),
        });
      } catch (error) {
        const code = error instanceof CodexClientError ? error.code : "RPC_ERROR";
        this.usageErrors.push({ session_id: sessionId, code });
        if (this.closed) break;
      }
    }
    return snapshot;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.account = null;
    this.buffer = "";
    this.fail(new CodexClientError("CLOSED"));
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    this.closing = new Promise<void>((resolve) => {
      let termTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve();
      };
      child.once("close", done);
      child.stdin.end();
      termTimer = setTimeout(() => child.kill("SIGTERM"), 150);
      killTimer = setTimeout(() => child.kill("SIGKILL"), 650);
    });
    return this.closing;
  }
}
