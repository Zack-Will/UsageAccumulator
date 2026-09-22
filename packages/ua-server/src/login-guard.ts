/**
 * 登录限速。
 *
 * ★ 换成「记得住的密码」之后这个东西就是必需品，不是锦上添花：
 *   token 有 128 位随机熵，猜不动；一个人记得住的密码可能只有二三十位熵，
 *   没有限速的话「好记」直接等价于「好猜」。
 *
 * 策略：按来源分桶，连续失败后指数退避（1s、2s、4s…封顶 15 分钟），
 * 成功即清零。纯内存 —— 服务端重启会清空，但重启本身不是攻击者能触发的动作。
 */
export interface LoginGuardOptions {
  /** 第一次失败后的等待，之后逐次翻倍 */
  baseDelayMs?: number;
  /** 退避上限 */
  maxDelayMs?: number;
  /** 多久没有新失败就忘掉这个来源 */
  forgetAfterMs?: number;
  /** 桶数量上限，防止被大量伪造来源撑爆内存 */
  maxEntries?: number;
}

interface Entry {
  failures: number;
  /** 在此之前不接受新的尝试 */
  blockedUntil: number;
  lastSeen: number;
}

export interface GuardVerdict {
  allowed: boolean;
  /** allowed=false 时，还要等多少秒 */
  retryAfterSec: number;
}

export class LoginGuard {
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly forgetAfterMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();

  constructor(o: LoginGuardOptions = {}) {
    this.baseDelayMs = o.baseDelayMs ?? 1_000;
    this.maxDelayMs = o.maxDelayMs ?? 15 * 60_000;
    this.forgetAfterMs = o.forgetAfterMs ?? 60 * 60_000;
    this.maxEntries = o.maxEntries ?? 10_000;
  }

  check(key: string, nowMs: number): GuardVerdict {
    const e = this.entries.get(key);
    if (!e || e.blockedUntil <= nowMs) return { allowed: true, retryAfterSec: 0 };
    return { allowed: false, retryAfterSec: Math.ceil((e.blockedUntil - nowMs) / 1000) };
  }

  fail(key: string, nowMs: number): void {
    this.prune(nowMs);
    const e = this.entries.get(key) ?? { failures: 0, blockedUntil: 0, lastSeen: nowMs };
    e.failures += 1;
    // 2^(n-1) 倍基准延时，封顶；用位移会在 n>31 时溢出，所以用 Math.pow 再 clamp
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, e.failures - 1));
    e.blockedUntil = nowMs + delay;
    e.lastSeen = nowMs;
    this.entries.set(key, e);
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  /** 当前被挡住的来源数，给日志/诊断用 */
  get size(): number {
    return this.entries.size;
  }

  private prune(nowMs: number): void {
    for (const [k, e] of this.entries) {
      if (nowMs - e.lastSeen > this.forgetAfterMs) this.entries.delete(k);
    }
    if (this.entries.size < this.maxEntries) return;
    // 还是太多：丢掉最久没动过的一半，保留正在被退避的那些（lastSeen 新）
    const sorted = [...this.entries].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (let i = 0; i < Math.floor(sorted.length / 2); i++) this.entries.delete(sorted[i]![0]);
  }
}
