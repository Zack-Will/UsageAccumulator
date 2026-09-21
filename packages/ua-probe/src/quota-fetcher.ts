import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RawConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { QuotaAuthError, type QuotaSource } from "./quota.js";
import type { ProbeStore } from "./store.js";
import { toWireQuota } from "./wire.js";

const exec = promisify(execFile);

export interface Notifier {
  notify(title: string, message: string): Promise<void>;
}

/** macOS 上弹一条通知提示重新登录。消息里**绝不**包含凭证。 */
export const macNotifier: Notifier = {
  async notify(title, message) {
    if (process.platform !== "darwin") return;
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      await exec("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`]);
    } catch {
      /* 通知失败不影响主流程 */
    }
  },
};

export const noopNotifier: Notifier = { async notify() {} };

export type TickOutcome = { ok: true; windows: number } | { ok: false; kind: "auth" | "error"; message: string };

/**
 * 额度采集调度（ARCHITECTURE §5.3）。
 * 5 分钟一次 + 随机抖动；401 时走退避阶梯并提示重新登录，**不重试到被风控**。
 */
export class QuotaFetcher {
  private timer: NodeJS.Timeout | null = null;
  private authFailures = 0;
  private stopped = false;
  lastOutcome: TickOutcome | null = null;
  lastSuccessAt: number | null = null;

  constructor(
    private readonly cfg: RawConfig["quota"],
    private readonly source: QuotaSource,
    private readonly store: ProbeStore,
    private readonly log: Logger,
    private readonly notifier: Notifier = macNotifier,
    private readonly rand: () => number = Math.random,
  ) {}

  async tick(now = new Date()): Promise<TickOutcome> {
    try {
      const snap = await this.source.fetch(this.cfg.profile_id, now);
      this.store.enqueueQuota(JSON.stringify(toWireQuota(snap)));
      if (this.authFailures > 0) this.log.info("额度凭证恢复正常");
      this.authFailures = 0;
      this.lastSuccessAt = now.getTime();
      this.lastOutcome = { ok: true, windows: snap.windows.length };
      this.log.debug(
        { windows: snap.windows.map((w) => w.windowKind) },
        "额度快照入队",
      );
      return this.lastOutcome;
    } catch (err) {
      if (err instanceof QuotaAuthError) {
        this.authFailures++;
        const waitSecs = this.authBackoffSecs();
        this.log.warn(
          { status: err.status, failures: this.authFailures, nextRetrySecs: waitSecs },
          "额度接口鉴权失败，退避等待并提示重新登录",
        );
        if (this.cfg.notify_on_auth_error) {
          await this.notifier.notify(
            "UsageAccumulator",
            `Claude 额度采集鉴权失败（${err.status}），请重新登录 claude.ai 并更新本机 sessionKey。${Math.round(waitSecs / 60)} 分钟后重试。`,
          );
        }
        this.lastOutcome = { ok: false, kind: "auth", message: err.message };
        return this.lastOutcome;
      }
      this.log.warn({ err: (err as Error).message }, "额度采集失败");
      this.lastOutcome = { ok: false, kind: "error", message: (err as Error).message };
      return this.lastOutcome;
    }
  }

  private authBackoffSecs(): number {
    const ladder = this.cfg.auth_backoff_secs;
    if (ladder.length === 0) return 900;
    const idx = Math.min(this.authFailures - 1, ladder.length - 1);
    return ladder[Math.max(0, idx)] ?? 900;
  }

  /** 下一次采集的等待时间。鉴权失败时走退避阶梯，否则是 interval + 随机抖动。 */
  nextDelayMs(): number {
    if (this.authFailures > 0) {
      const secs = this.authBackoffSecs();
      // 退避也加抖动，避免多台机器在同一秒重试
      return Math.round(secs * 1000 * (1 + this.rand() * 0.1));
    }
    const jitter = this.cfg.jitter_secs > 0 ? this.rand() * this.cfg.jitter_secs : 0;
    return Math.round((this.cfg.interval_secs + jitter) * 1000);
  }

  start(): void {
    if (!this.cfg.enabled) {
      this.log.info("QuotaFetcher 未启用（只在指定的一台机器上开）");
      return;
    }
    this.stopped = false;
    const loop = async (): Promise<void> => {
      if (this.stopped) return;
      await this.tick();
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), this.nextDelayMs());
      this.timer.unref?.();
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
