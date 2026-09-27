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
import {
  QuotaAuthError,
  planFromTier,
  unambiguousOrg,
  type ClaudeOrg,
  type ClaudeWebClient,
  type HttpGet,
  type QuotaSnapshot,
} from "@ua/core";
import type { SessionVault } from "./quota-vault.js";

/**
 * none     还没保存会话
 * pending  存了会话，还没抓过（刚启动 / 刚换了会话）
 * ok       最近一次成功
 * auth     claude.ai 不认这个会话 —— 要重新登录
 * blocked  被 Cloudflare 质询 —— 换会话也没用
 * org      会话有效，但不知道该抓哪个组织（账号下有多个、或绑定的那个不在了）—— 要在看板上选
 * error    其余失败（网络、5xx、响应变形），下一轮照常重试
 * disabled 服务端没开采集（UA_QUOTA_SAMPLING=false，退回探针代抓）
 */
export type SamplerState = "none" | "pending" | "ok" | "auth" | "blocked" | "org" | "error" | "disabled";

/** 给看板选组织用的一行：不含任何凭证 */
export interface OrgChoice {
  uuid: string;
  name: string;
  plan: string | null;
  /** 已绑在哪个 profile 上；没绑为 null */
  boundTo: string | null;
}

export interface SamplerStatus {
  profileId: string;
  state: SamplerState;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  /** 给人看的失败原因；绝不含凭证 */
  error: string | null;
  /** 这个 profile 绑定的组织；没绑为 null */
  orgUuid: string | null;
  /** 这个会话能看到的组织。还没问过 claude.ai 时为 null（不是空数组） */
  orgs: OrgChoice[] | null;
}

interface Slot {
  keyHash: string;
  /** 本会话能看到的组织，每换一次会话问一次 */
  orgs: ClaudeOrg[] | null;
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
  client: Pick<ClaudeWebClient, "organizations" | "snapshot">;
  /** profile 当前绑定的组织（profiles.org_uuid） */
  profileOrg: (profileId: string) => Promise<string | null>;
  /** 自动绑定唯一候选时调用；该组织已被别的 profile 占用时返回那个 profile 的 id */
  bindOrg: (profileId: string, org: ClaudeOrg) => Promise<string | null>;
  /** 列出所有 profile 的绑定，用来标注候选组织「已绑在哪」 */
  orgBindings: () => Promise<Map<string, string>>;
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
    const orgUuid = await this.opts.profileOrg(profileId);
    const blank = { profileId, lastOkAt: null, lastAttemptAt: null, nextAttemptAt: null, error: null, orgUuid, orgs: null };
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
      orgUuid,
      orgs: slot.orgs ? await this.choices(slot.orgs) : null,
    };
  }

  private async choices(orgs: ClaudeOrg[]): Promise<OrgChoice[]> {
    const bound = await this.opts.orgBindings();
    return orgs.map((o) => ({ uuid: o.uuid, name: o.name, plan: planFromTier(o.rateLimitTier), boundTo: bound.get(o.uuid) ?? null }));
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
      // 新会话（看板保存，或在机器上直接覆盖了文件）：退避和组织列表一起作废
      slot = {
        keyHash,
        orgs: null,
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
      // 每个会话先问一次有哪些组织：既用来自动绑定唯一候选，也给看板的选择框
      if (!slot.orgs) slot.orgs = await this.opts.client.organizations(key);
      const orgUuid = await this.resolveOrg(profileId, slot);
      if (!orgUuid) {
        // 不知道抓哪个组织就不抓 —— 抓错了没有任何迹象，只会看到一份始终对不上的数字
        slot.state = "org";
        slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs);
        if (was !== "org") this.opts.log.warn({ profileId, orgs: slot.orgs.length, reason: slot.error }, "额度采集等待选择组织");
        return;
      }
      let snap: QuotaSnapshot;
      try {
        snap = await this.opts.client.snapshot(key, orgUuid, profileId, now);
      } catch (err) {
        // usage 被拒可能只是「这个账号已经不在那个组织里了」—— 会话本身还好好的
        if (err instanceof QuotaAuthError && err.reason === "session") {
          slot.orgs = await this.opts.client.organizations(key);
          if (!slot.orgs.some((o) => o.uuid === orgUuid)) {
            slot.state = "org";
            slot.error = "绑定的组织不在这个会话的账号下";
            slot.nextAttemptAt = new Date(now.getTime() + this.intervalMs);
            this.opts.log.warn({ profileId }, slot.error);
            return;
          }
        }
        throw err;
      }
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
        // 可能换了账号，组织列表下次重新问
        slot.orgs = null;
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

  /**
   * 这个 profile 该抓哪个组织。已绑定且还在列表里 → 用它；没绑定且只有一个无歧义候选 → 自动绑上；
   * 其余情况返回 null 并在 slot.error 里写明原因，**绝不按顺序或能力去猜**。
   */
  private async resolveOrg(profileId: string, slot: Slot): Promise<string | null> {
    const orgs = slot.orgs ?? [];
    const bound = await this.opts.profileOrg(profileId);
    if (bound) {
      if (orgs.some((o) => o.uuid === bound)) return bound;
      slot.error = "绑定的组织不在这个会话的账号下";
      return null;
    }
    const pick = unambiguousOrg(orgs);
    if (!pick) {
      slot.error = orgs.length === 0 ? "这个会话下没有组织" : `这个账号下有 ${orgs.length} 个组织，需要选一个`;
      return null;
    }
    const taken = await this.opts.bindOrg(profileId, pick);
    if (taken) {
      slot.error = `唯一的组织已绑定到 ${taken}`;
      return null;
    }
    this.opts.log.info({ profileId, org: pick.name }, "额度采集自动绑定组织");
    return pick.uuid;
  }
}
