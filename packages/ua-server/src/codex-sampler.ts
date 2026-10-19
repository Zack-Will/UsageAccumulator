/**
 * 服务端直接抓 Codex 额度（与 quota-sampler.ts 抓 claude.ai 同一套节奏与退避）。
 *
 * 凭证放在 SessionVault 的 `codex` 一格里（0600 文件，不进库），内容是 CodexCredential 的 JSON。
 * 每一轮都重读文件：看板保存了新登录、或在机器上直接覆盖了文件，退避立即作废。
 *
 * 抓到的快照与探针上报走同一个入库口（store.codex.ingest），machine_id 记为 `ua-server`：
 * 采集器卡上多一行「服务端」，它挂了也看得见。本地用量明细仍由探针上报 —— 那是本机日志，服务端读不到。
 */
import { createHash } from "node:crypto";
import type { CodexIngestBatch } from "@ua/core";
import {
  CodexAuthError,
  codexAccessStale,
  codexIdentity,
  fetchCodexResetCredits,
  fetchCodexUsage,
  normalizeWhamUsage,
  parseCodexCredentialInput,
  refreshCodexCredential,
  type CodexCredential,
  type CodexFetch,
} from "./codex-web.js";
import { CodexHttpError, normalizeCodexEmail } from "./codex-store.js";
import type { SessionVault } from "./quota-vault.js";

export const CODEX_VAULT_ID = "codex";
export const CODEX_SERVER_MACHINE_ID = "ua-server";

/**
 * none     还没保存登录
 * pending  存了，还没抓过
 * ok       最近一次成功
 * auth     登录失效（refresh token 过期 / 被用过 / 被吊销）—— 要重新登录一份
 * blocked  被 Cloudflare 拦下
 * account  登录的不是 UA_CODEX_ACCOUNT_EMAIL 配置的那个账号（或服务端没配）
 * error    其余失败，下一轮照常重试
 * disabled 服务端没开 Codex 采集
 */
export type CodexSamplerState = "none" | "pending" | "ok" | "auth" | "blocked" | "account" | "error" | "disabled";

export interface CodexSamplerStatus {
  state: CodexSamplerState;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  /** 给人看的原因；绝不含 token */
  error: string | null;
  email: string | null;
  planType: string | null;
  /** access token 上次换新的时刻 */
  refreshedAt: Date | null;
}

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface CodexSamplerOptions {
  vault: SessionVault;
  http: CodexFetch;
  /** UA_CODEX_ACCOUNT_EMAIL；空 = 没配，拒绝采集（与探针上报同一道门） */
  configuredEmail: () => string;
  /** 入库：失败时 CodexHttpError(409) 表示账号绑定冲突 */
  record: (batch: CodexIngestBatch) => Promise<void>;
  log: Log;
  intervalMs?: number;
  jitterMs?: number;
  authBackoffMs?: number[];
  pollMs?: number;
  now?: () => Date;
  random?: () => number;
}

interface Slot {
  hash: string;
  state: CodexSamplerState;
  failures: number;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  error: string | null;
}

const DEFAULT_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export class CodexSampler {
  private slot: Slot | null = null;
  private inflight: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly backoffMs: number[];
  private readonly pollMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(private readonly opts: CodexSamplerOptions) {
    this.intervalMs = opts.intervalMs ?? 300_000;
    this.jitterMs = opts.jitterMs ?? 60_000;
    this.backoffMs = opts.authBackoffMs?.length ? opts.authBackoffMs : DEFAULT_BACKOFF_MS;
    this.pollMs = opts.pollMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
  }

  private async readCredential(): Promise<{ raw: string; cred: CodexCredential } | null> {
    const raw = await this.opts.vault.read(CODEX_VAULT_ID);
    if (!raw) return null;
    try {
      const doc = JSON.parse(raw) as Partial<CodexCredential>;
      if (typeof doc.refresh_token !== "string" || !doc.refresh_token) return null;
      return {
        raw,
        cred: {
          refresh_token: doc.refresh_token,
          access_token: typeof doc.access_token === "string" ? doc.access_token : null,
          id_token: typeof doc.id_token === "string" ? doc.id_token : null,
          refreshed_at: typeof doc.refreshed_at === "string" ? doc.refreshed_at : null,
        },
      };
    } catch {
      // 有人在机器上直接写了一行 refresh token：也认
      try {
        return { raw, cred: parseCodexCredentialInput(raw) };
      } catch {
        return null;
      }
    }
  }

  private persist(cred: CodexCredential): Promise<void> {
    return this.opts.vault.write(CODEX_VAULT_ID, JSON.stringify(cred));
  }

  /** 看板保存一份新登录：先校验格式与账号，再落盘，然后立刻抓一次 */
  async save(input: string): Promise<CodexSamplerStatus> {
    const cred = parseCodexCredentialInput(input);
    const who = codexIdentity(cred);
    const configured = normalizeCodexEmail(this.opts.configuredEmail());
    if (who.email && configured && who.email !== configured) {
      throw new CodexHttpError(409, "account_binding_conflict", "这份登录的邮箱与 UA_CODEX_ACCOUNT_EMAIL 不一致");
    }
    await this.persist(cred);
    this.slot = null;
    return this.kick();
  }

  async clear(): Promise<CodexSamplerStatus> {
    await this.opts.vault.remove(CODEX_VAULT_ID);
    this.slot = null;
    return this.status();
  }

  async kick(): Promise<CodexSamplerStatus> {
    await this.run(true);
    return this.status();
  }

  async tick(): Promise<void> {
    await this.run(false);
  }

  async status(): Promise<CodexSamplerStatus> {
    const stored = await this.readCredential();
    const blank = { lastOkAt: null, lastAttemptAt: null, nextAttemptAt: null, error: null, email: null, planType: null, refreshedAt: null };
    if (!stored) return { ...blank, state: "none" };
    const who = codexIdentity(stored.cred);
    const refreshedAt = stored.cred.refreshed_at ? new Date(stored.cred.refreshed_at) : null;
    const slot = this.slot;
    if (!slot || slot.hash !== sha256(stored.cred.refresh_token)) {
      return { ...blank, state: "pending", email: who.email, planType: who.plan_type, refreshedAt };
    }
    return {
      state: slot.state,
      lastOkAt: slot.lastOkAt,
      lastAttemptAt: slot.lastAttemptAt,
      nextAttemptAt: slot.nextAttemptAt,
      error: slot.error,
      email: who.email,
      planType: who.plan_type,
      refreshedAt,
    };
  }

  start(): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    const loop = async (): Promise<void> => {
      if (stopped) return;
      try {
        await this.tick();
      } catch (err) {
        this.opts.log.error({ err: (err as Error).message }, "Codex 额度采样轮询异常");
      }
      if (stopped) return;
      timer = setTimeout(() => void loop(), this.pollMs);
      timer.unref?.();
    };
    timer = setTimeout(() => void loop(), 3_000);
    timer.unref?.();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  private async run(force: boolean): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      if (!force) return;
    }
    const p = this.attempt(force).finally(() => {
      this.inflight = null;
    });
    this.inflight = p;
    await p;
  }

  private async attempt(force: boolean): Promise<void> {
    const stored = await this.readCredential();
    if (!stored) {
      this.slot = null;
      return;
    }
    let cred = stored.cred;
    // 槽位跟着 refresh token 走：轮换后是同一条登录链，也算「新」—— 但这时退避已经清零，没有副作用
    const hash = sha256(cred.refresh_token);
    let slot = this.slot;
    if (!slot || slot.hash !== hash) {
      slot = { hash, state: "pending", failures: 0, lastOkAt: slot?.lastOkAt ?? null, lastAttemptAt: null, nextAttemptAt: null, error: null };
      this.slot = slot;
    }
    const now = this.now();
    if (!force && slot.nextAttemptAt && now < slot.nextAttemptAt) return;
    slot.lastAttemptAt = now;
    const was = slot.state;

    const rotate = async (): Promise<void> => {
      cred = await refreshCodexCredential(cred, this.opts.http, now);
      // ★ 先落盘再用：新 token 一旦换出来，旧 refresh token 就作废了
      await this.persist(cred);
      slot.hash = sha256(cred.refresh_token);
    };

    try {
      const configured = normalizeCodexEmail(this.opts.configuredEmail());
      if (!configured) {
        slot.state = "account";
        slot.error = "服务端没有配置 UA_CODEX_ACCOUNT_EMAIL";
        slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs);
        return;
      }
      let rotated = false;
      if (codexAccessStale(cred, now)) {
        await rotate();
        rotated = true;
      }
      let who = codexIdentity(cred);
      let usage;
      try {
        usage = await fetchCodexUsage(cred, who.account_id, this.opts.http);
      } catch (err) {
        // access token 被拒：没刚换过就换一次再试，换过了还被拒才算登录失效
        if (!(err instanceof CodexAuthError) || err.reason !== "rejected" || rotated) throw err;
        await rotate();
        who = codexIdentity(cred);
        usage = await fetchCodexUsage(cred, who.account_id, this.opts.http);
      }
      const details = await fetchCodexResetCredits(cred, who.account_id, this.opts.http);
      const { snapshot, plan_type, account_id } = normalizeWhamUsage(usage, details, now);
      const accountId = who.account_id ?? account_id;
      if (!who.email || !accountId) throw new Error("从这份登录里读不出账号邮箱或账号 id");
      if (who.email !== configured) {
        slot.state = "account";
        slot.error = "这份登录的邮箱与 UA_CODEX_ACCOUNT_EMAIL 不一致";
        slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs);
        this.opts.log.warn({}, slot.error);
        return;
      }
      await this.opts.record({
        schema_version: 1,
        account: { account_id: accountId, email: who.email, plan_type: plan_type ?? who.plan_type },
        events: [],
        quota: snapshot,
        collector: this.heartbeat(now, "ok", null),
      });
      if (was !== "ok") this.opts.log.info({ windows: snapshot.windows.length }, "Codex 额度采集正常");
      slot.state = "ok";
      slot.failures = 0;
      slot.lastOkAt = now;
      slot.error = null;
      slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs + Math.round(this.random() * this.jitterMs));
    } catch (err) {
      if (err instanceof CodexHttpError && err.status === 409) {
        slot.state = "account";
        slot.error = err.message;
        slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs);
        this.opts.log.warn({}, "Codex 账号绑定冲突");
      } else if (err instanceof CodexAuthError) {
        slot.failures++;
        const wait = this.backoffMs[Math.min(slot.failures, this.backoffMs.length) - 1] ?? this.intervalMs;
        slot.state = err.reason === "challenge" ? "blocked" : "auth";
        slot.error = err.message;
        slot.nextAttemptAt = new Date(now.getTime() + wait);
        this.opts.log.warn({ reason: err.reason, status: err.status, retryInSecs: Math.round(wait / 1000) }, "Codex 额度采集被拒，退避等待");
        await this.reportFailure(cred, now, err.reason === "challenge" ? "codex_server_blocked" : "codex_server_auth");
      } else {
        slot.state = "error";
        slot.error = (err as Error).message;
        slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs);
        this.opts.log.warn({ err: (err as Error).message }, "Codex 额度采集失败");
      }
    }
  }

  private heartbeat(now: Date, state: "ok" | "auth" | "error", code: string | null): CodexIngestBatch["collector"] {
    return {
      captured_at: now.toISOString(),
      state,
      error_code: code,
      backfill_from: now.toISOString(),
      scanned_files: 0,
      parse_warnings: 0,
      warning_scope: "withheld_records",
      account_binding: "verified_login_configured_history",
    };
  }

  /** 让采集器卡上的「服务端」一行变红；账号读不出来就算了 —— 状态接口照样说明原因 */
  private async reportFailure(cred: CodexCredential, now: Date, code: string): Promise<void> {
    const who = codexIdentity(cred);
    if (!who.email || !who.account_id) return;
    try {
      await this.opts.record({
        schema_version: 1,
        account: { account_id: who.account_id, email: who.email, plan_type: who.plan_type },
        events: [],
        collector: this.heartbeat(now, "auth", code),
      });
    } catch {
      /* 心跳失败不影响状态 */
    }
  }
}
