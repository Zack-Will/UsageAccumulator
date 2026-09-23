/**
 * 服务端直接抓 claude.ai 额度（ARCHITECTURE §5.3）。
 *
 * 以前由某一台机器上的探针代抓再上报：那台机器一合盖、一出门，额度曲线就断档，
 * 燃尽、耗尽预估和「其他来源」归因跟着失真。服务端 7×24 在线，自己抓才干净。
 *
 * 节奏和探针一致：约 5 分钟一次、带抖动；会话失效 / 被 Cloudflare 质询时按阶梯退避
 * （15 分钟 → 1 小时 → 6 小时），**不重试到被风控**。
 * 会话本身放在 SessionVault 里，这里每一轮都重新读 —— 换了会话，退避与 org 缓存一起作废。
 */
import { createHash } from "node:crypto";
import { QuotaAuthError, type ClaudeWebClient, type HttpGet, type QuotaSnapshot } from "@ua/core";
import type { SessionVault } from "./quota-vault.js";

/**
 * none     还没保存会话
 * pending  存了会话，还没抓过（刚启动 / 刚换了会话）
 * ok       最近一次成功
 * auth     claude.ai 不认这个会话 —— 要重新登录
 * blocked  被 Cloudflare 质询 —— 换会话也没用
 * error    其余失败（网络、5xx、响应变形），下一轮照常重试
 * disabled 服务端没开采集（UA_QUOTA_SAMPLING=false，退回探针代抓）
 */
export type SamplerState = "none" | "pending" | "ok" | "auth" | "blocked" | "error" | "disabled";

export interface SamplerStatus {
  profileId: string;
  state: SamplerState;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  /** 给人看的失败原因；绝不含凭证 */
  error: string | null;
}

interface Slot {
  keyHash: string;
  orgId: string | null;
  state: SamplerState;
  failures: number;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  error: string | null;
}

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface QuotaSamplerOptions {
  vault: SessionVault;
  client: Pick<ClaudeWebClient, "orgId" | "snapshot">;
  /** 入库 + 推送，与探针上报走同一条路（app.ts recordQuota） */
  record: (snapshot: QuotaSnapshot) => Promise<void>;
  log: Log;
  intervalMs?: number;
  jitterMs?: number;
  authBackoffMs?: number[];
  /** 轮询粒度：多久看一次谁到点了。远小于 intervalMs，抖动才落得准 */
  pollMs?: number;
  now?: () => Date;
  random?: () => number;
}

const DEFAULT_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Node 自带 fetch（底层同样是 undici，过得了 Cloudflare）。20 秒超时，与探针一致。 */
export const fetchGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  return { status: res.status, text: await res.text() };
};

export class QuotaSampler {
  private readonly slots = new Map<string, Slot>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly backoffMs: number[];
  private readonly pollMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(private readonly opts: QuotaSamplerOptions) {
    this.intervalMs = opts.intervalMs ?? 300_000;
    this.jitterMs = opts.jitterMs ?? 60_000;
    this.backoffMs = opts.authBackoffMs?.length ? opts.authBackoffMs : DEFAULT_BACKOFF_MS;
    this.pollMs = opts.pollMs ?? 30_000;
    this.now = opts.now ?? (() => new Date());
    this.random = opts.random ?? Math.random;
  }

  /** 跑一轮：到点的 profile 各抓一次，返回时本轮全部结束（测试直接调它，不碰定时器）。 */
  async tickAll(): Promise<void> {
    const ids = await this.opts.vault.list();
    // 会话被删掉的 profile，旧状态不能留着冒充「正常」
    for (const id of [...this.slots.keys()]) if (!ids.includes(id)) this.slots.delete(id);
    await Promise.all(ids.map((id) => this.run(id, false)));
  }

  /** 立刻抓一次、无视退避 —— 刚保存了新会话时用，看板几秒内就能看到结果。 */
  async kick(profileId: string): Promise<SamplerStatus> {
    await this.run(profileId, true);
    return this.status(profileId);
  }

  forget(profileId: string): void {
    this.slots.delete(profileId);
  }

  async status(profileId: string): Promise<SamplerStatus> {
    const key = await this.opts.vault.read(profileId);
    const blank = { profileId, lastOkAt: null, lastAttemptAt: null, nextAttemptAt: null, error: null };
    if (!key) return { ...blank, state: "none" };
    const slot = this.slots.get(profileId);
    if (!slot || slot.keyHash !== sha256(key)) return { ...blank, state: "pending" };
    return {
      profileId,
      state: slot.state,
      lastOkAt: slot.lastOkAt,
      lastAttemptAt: slot.lastAttemptAt,
      nextAttemptAt: slot.nextAttemptAt,
      error: slot.error,
    };
  }

  /** 启动轮询，返回停止函数。 */
  start(): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    const loop = async (): Promise<void> => {
      if (stopped) return;
      try {
        await this.tickAll();
      } catch (err) {
        this.opts.log.error({ err: (err as Error).message }, "额度采样轮询异常");
      }
      if (stopped) return;
      timer = setTimeout(() => void loop(), this.pollMs);
      timer.unref?.();
    };
    // 启动后稍等一下再抓第一次：先让 HTTP 服务起来
    timer = setTimeout(() => void loop(), 2_000);
    timer.unref?.();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  /** 同一个 profile 不并发：强制那次要等手上这次跑完再跑一遍（它可能还拿着旧会话）。 */
  private async run(profileId: string, force: boolean): Promise<void> {
    const running = this.inflight.get(profileId);
    if (running) {
      await running;
      if (!force) return;
    }
    const p = this.attempt(profileId, force).finally(() => this.inflight.delete(profileId));
    this.inflight.set(profileId, p);
    await p;
  }

  private async attempt(profileId: string, force: boolean): Promise<void> {
    const key = await this.opts.vault.read(profileId);
    if (!key) {
      this.slots.delete(profileId);
      return;
    }
    const keyHash = sha256(key);
    let slot = this.slots.get(profileId);
    if (!slot || slot.keyHash !== keyHash) {
      // 新会话（看板保存，或在机器上直接覆盖了文件）：退避和 org 缓存一起作废
      slot = {
        keyHash,
        orgId: null,
        state: "pending",
        failures: 0,
        lastOkAt: slot?.lastOkAt ?? null,
        lastAttemptAt: null,
        nextAttemptAt: null,
        error: null,
      };
      this.slots.set(profileId, slot);
    }
    const now = this.now();
    if (!force && slot.nextAttemptAt && now < slot.nextAttemptAt) return;

    slot.lastAttemptAt = now;
    const was = slot.state;
    try {
      if (!slot.orgId) slot.orgId = await this.opts.client.orgId(key);
      const snap = await this.opts.client.snapshot(key, slot.orgId, profileId, now);
      await this.opts.record(snap);
      if (was !== "ok") this.opts.log.info({ profileId, windows: snap.windows.length }, "额度采集正常");
      slot.state = "ok";
      slot.failures = 0;
      slot.lastOkAt = now;
      slot.error = null;
      slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs + Math.round(this.random() * this.jitterMs));
    } catch (err) {
      if (err instanceof QuotaAuthError) {
        slot.failures++;
        const wait = this.backoffMs[Math.min(slot.failures, this.backoffMs.length) - 1] ?? this.intervalMs;
        slot.state = err.reason === "challenge" ? "blocked" : "auth";
        slot.error = err.message;
        // 可能换了账号，org 下次重新解析
        slot.orgId = null;
        slot.nextAttemptAt = new Date(now.getTime() + wait);
        this.opts.log.warn(
          { profileId, status: err.status, reason: err.reason, failures: slot.failures, retryInSecs: Math.round(wait / 1000) },
          "额度采集被拒，退避等待",
        );
      } else {
        slot.state = "error";
        slot.error = (err as Error).message;
        slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs);
        this.opts.log.warn({ profileId, err: (err as Error).message }, "额度采集失败");
      }
    }
  }
}
