import chokidar, { type FSWatcher } from "chokidar";
import { shareSessionTitles, type ProbeConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { Attributor } from "./attributor.js";
import { Ingestor, emptyStats, type IngestStats } from "./ingest.js";
import { walkScanRoots } from "./scanner.js";
import { ProbeStore } from "./store.js";
import { backoffMs, Shipper } from "./shipper.js";
import { ClaudeWebSource } from "./quota.js";
import { createCredentialStore } from "./credentials.js";
import { QuotaFetcher, macNotifier } from "./quota-fetcher.js";
import { expandHome } from "./paths.js";
import { scanFileTitles } from "./session-titles.js";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export interface ProbeOptions {
  /** backfill 模式：全量解析 + 限速上报，事件打 backfill: true */
  backfill?: boolean;
  logger?: Logger;
}

/** 探针主体：扫描 → 解析 → 归属 → 队列 → 上报 → 额度。 */
export class Probe {
  readonly store: ProbeStore;
  readonly log: Logger;
  private readonly attributor: Attributor;
  private readonly ingestor: Ingestor;
  private readonly shipper: Shipper;
  private watcher: FSWatcher | null = null;
  private quota: QuotaFetcher | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly abort = new AbortController();
  private dirty = new Set<string>();
  private dirtyTimer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly cfg: ProbeConfig,
    opts: ProbeOptions = {},
  ) {
    this.log = opts.logger ?? createLogger(cfg.log_level);
    this.store = new ProbeStore(cfg.resolvedStateDb);
    this.attributor = new Attributor(cfg, this.store, this.log);
    this.ingestor = new Ingestor(cfg, this.store, this.attributor, this.log);
    this.shipper = new Shipper({
      serverUrl: cfg.server.url,
      machineToken: cfg.server.machine_token,
      timeoutMs: cfg.server.request_timeout_ms,
    });
  }

  get attributionStats(): Record<string, number> {
    return { ...this.attributor.stats };
  }

  /** 扫一遍全部 scan_roots。backfill 与兜底轮询都走它。 */
  async scanAll(backfill = false): Promise<IngestStats> {
    const stats = emptyStats();
    const files = await walkScanRoots(this.cfg.resolvedScanRoots);
    for (const f of files) {
      if (this.abort.signal.aborted) break;
      await this.ingestor.ingestFile(f, { backfill }, stats);
    }
    return stats;
  }

  private async ingestDirty(): Promise<void> {
    if (this.dirty.size === 0) return;
    const batch = [...this.dirty];
    this.dirty.clear();
    const stats = emptyStats();
    for (const f of batch) await this.ingestor.ingestFile(f, { backfill: false }, stats);
    if (stats.events > 0) {
      this.log.debug({ files: stats.files, events: stats.events, enqueued: stats.enqueued }, "增量解析");
    }
  }

  private markDirty(path: string): void {
    if (!path.endsWith(".jsonl")) return;
    this.dirty.add(path);
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      void this.ingestDirty();
    }, this.cfg.watch.debounce_ms);
    this.dirtyTimer.unref?.();
  }

  /**
   * 把队列里的事件发出去。成功才删，失败保留并指数退避。
   * `rateLimit` 用于 backfill：每批之间停一会儿，避免首次接入把服务端打满。
   */
  async drainQueue(opts: { batchSize: number; rateLimitMs: number; maxBatches?: number } = {
    batchSize: this.cfg.server.batch_size,
    rateLimitMs: 0,
  }): Promise<{ sent: number; batches: number; dropped: number }> {
    if (this.draining) return { sent: 0, batches: 0, dropped: 0 };
    this.draining = true;
    let sent = 0;
    let batches = 0;
    let dropped = 0;
    let attempt = 0;
    try {
      for (;;) {
        if (this.abort.signal.aborted) break;
        if (opts.maxBatches !== undefined && batches >= opts.maxBatches) break;
        const rows = this.store.takeEvents(opts.batchSize);
        if (rows.length === 0) break;

        const res = await this.shipper.sendEvents(rows.map((r) => r.payload));
        if (res.ok) {
          this.store.ackEvents(rows.map((r) => r.id));
          sent += rows.length;
          batches++;
          attempt = 0;
          this.log.debug({ accepted: res.accepted, deduped: res.deduped }, "上报成功");
          if (opts.rateLimitMs > 0) await sleep(opts.rateLimitMs, this.abort.signal);
          continue;
        }
        if (res.verdict === "drop") {
          // 4xx 不可恢复：留着会永久堵住队列头，丢弃并高声告警
          this.store.ackEvents(rows.map((r) => r.id));
          dropped += rows.length;
          this.log.error({ status: res.status, message: res.message, dropped: rows.length }, "★ 服务端拒收且不可重试，丢弃该批");
          continue;
        }
        const wait = backoffMs(attempt, this.cfg.server.retry_base_ms, this.cfg.server.retry_max_ms);
        this.log.warn({ status: res.status, message: res.message, attempt, waitMs: wait }, "上报失败，退避重试");
        attempt++;
        await sleep(wait, this.abort.signal);
        if (this.abort.signal.aborted) break;
      }
      await this.drainQuotaQueue();
      await this.drainSessionTitles();
    } finally {
      this.draining = false;
    }
    return { sent, batches, dropped };
  }

  /**
   * 上报会话标题。开了 hash_project_paths 的机器一律不报（见 shareSessionTitles）。
   * 服务端拒收（4xx）的一批标记为已处理，免得每轮都重发同一批；可重试的留到下一轮。
   */
  private async drainSessionTitles(): Promise<void> {
    if (!shareSessionTitles(this.cfg)) return;
    for (let round = 0; round < 20; round++) {
      const rows = this.store.pendingSessionTitles(500);
      if (rows.length === 0) return;
      const res = await this.shipper.sendSessionTitles(rows);
      if (res.ok || res.verdict === "drop") {
        this.store.markSessionTitlesShipped(rows);
        if (!res.ok) this.log.error({ status: res.status, message: res.message }, "会话标题被拒收，跳过这一批");
        else this.log.debug({ titles: rows.length }, "会话标题已上报");
      } else {
        return;
      }
    }
  }

  /**
   * 老会话补标题：只做一次。
   *
   * 增量解析只读游标之后的新内容，而老会话的标题行早就在游标之前了 ——
   * 不补的话，只有「装探针之后还在用的会话」才有名字。
   * 全部日志扫一遍（本机实测 83 个文件 605MB），只挑标题行，不碰游标、不产生事件。
   */
  async backfillSessionTitles(): Promise<number> {
    const DONE = "session_titles_backfilled_v1";
    if (this.store.getMeta(DONE)) return 0;
    const started = Date.now();
    const files = await walkScanRoots(this.cfg.resolvedScanRoots);
    let changed = 0;
    for (const f of files) {
      if (this.abort.signal.aborted) return changed;
      try {
        for (const t of await scanFileTitles(f)) {
          if (this.store.putSessionTitle(t.sessionId, t.title, t.kind)) changed++;
        }
      } catch (err) {
        this.log.warn({ path: f, err: (err as Error).message }, "补标题时读取文件失败，跳过");
      }
    }
    this.store.setMeta(DONE, new Date().toISOString());
    this.log.info({ files: files.length, titles: changed, ms: Date.now() - started }, "老会话标题补齐");
    return changed;
  }

  private async drainQuotaQueue(): Promise<void> {
    for (;;) {
      const rows = this.store.takeQuota(10);
      if (rows.length === 0) return;
      for (const r of rows) {
        const res = await this.shipper.sendQuota(r.payload);
        if (res.ok || res.verdict === "drop") {
          this.store.ackQuota([r.id]);
          if (!res.ok) this.log.error({ status: res.status }, "额度快照被拒收，丢弃");
        } else {
          return; // 可重试：留在队列里，下一轮再说
        }
      }
    }
  }

  /** backfill：首次全量解析 + 限速上报（每批 1000、间隔 200ms）。 */
  async runBackfill(): Promise<IngestStats> {
    this.log.info({ roots: this.cfg.resolvedScanRoots }, "backfill 开始：全量解析历史 JSONL");
    const started = Date.now();
    const stats = await this.scanAll(true);
    this.log.info(
      {
        files: stats.files,
        lines: stats.lines,
        events: stats.events,
        enqueued: stats.enqueued,
        warnings: stats.warnings,
        ms: Date.now() - started,
      },
      "backfill 解析完成，开始限速上报",
    );
    const drained = await this.drainQueue({
      batchSize: this.cfg.backfill.batch_size,
      rateLimitMs: this.cfg.backfill.interval_ms,
    });
    this.log.info({ ...drained, attribution: this.attributionStats }, "backfill 上报完成");
    return stats;
  }

  /** 常驻模式：chokidar 监听 + 60s 兜底轮询 + 定时 flush + 额度采集。 */
  async start(): Promise<void> {
    this.attributor.refreshTimeline();

    const first = await this.scanAll(false);
    this.log.info({ files: first.files, events: first.events, enqueued: first.enqueued }, "启动扫描完成");
    // 老会话补标题放后台：几百 MB 的日志要扫几秒，不该挡住启动
    void this.backfillSessionTitles().catch((err: unknown) =>
      this.log.warn({ err: String(err) }, "补标题失败，下次启动再试"),
    );

    this.watcher = chokidar.watch(this.cfg.resolvedScanRoots, {
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true,
    });
    this.watcher.on("add", (p) => this.markDirty(p));
    this.watcher.on("change", (p) => this.markDirty(p));
    this.watcher.on("error", (err) => this.log.warn({ err: String(err) }, "watcher 错误，兜底轮询仍在跑"));

    // ★ 兜底轮询：FSEvents 在网络盘 / 容器挂载下会静默失效，不能只靠 watcher
    this.every(this.cfg.watch.poll_interval_ms, async () => {
      const s = await this.scanAll(false);
      if (s.events > 0) this.log.debug({ events: s.events }, "兜底轮询捞到事件（watcher 可能失效）");
    });

    this.every(this.cfg.queue.flush_interval_ms, async () => {
      await this.drainQueue({ batchSize: this.cfg.server.batch_size, rateLimitMs: 0 });
    });

    this.every(this.cfg.attribution.poll_interval_ms, async () => {
      this.attributor.refreshTimeline();
    });

    if (this.cfg.quota.enabled) {
      const creds = createCredentialStore(this.cfg.quota, (msg) => this.log.warn(msg));
      const source = new ClaudeWebSource(creds, this.cfg.quota.base_url);
      this.quota = new QuotaFetcher(this.cfg.quota, source, this.store, this.log, macNotifier);
      this.quota.start();
      this.log.info({ profileId: this.cfg.quota.profile_id, credential: creds.kind }, "QuotaFetcher 已启用");
    }

    this.log.info(
      { machineId: this.cfg.machine_id, roots: this.cfg.resolvedScanRoots, server: this.cfg.server.url },
      "ua-probe 运行中",
    );
  }

  private every(ms: number, fn: () => Promise<void>): void {
    const t = setInterval(() => {
      void fn().catch((err: unknown) => this.log.warn({ err: String(err) }, "定时任务失败"));
    }, ms);
    t.unref?.();
    this.timers.push(t);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.quota?.stop();
    await this.watcher?.close();
    this.watcher = null;
    this.attributor.close();
    this.store.close();
  }

  /** status 子命令用。 */
  snapshot(): Record<string, unknown> {
    const last = this.store.latestTimeline();
    return {
      machine_id: this.cfg.machine_id,
      server: this.cfg.server.url,
      scan_roots: this.cfg.resolvedScanRoots,
      state_db: this.cfg.resolvedStateDb,
      cursors: this.store.cursorCount(),
      queue_depth: this.store.queueDepth(),
      session_titles: this.store.sessionTitleCount(),
      share_session_titles: shareSessionTitles(this.cfg),
      quota_queue_depth: this.store.quotaDepth(),
      installed_at: new Date(this.attributor.installedAt).toISOString(),
      current_profile: last ? { profile_id: last.profileId, since: new Date(last.changedAt).toISOString(), source: last.source } : null,
      timeline_points: this.store.allTimeline().length,
      quota_enabled: this.cfg.quota.enabled,
      cc_switch_db: expandHome(this.cfg.attribution.cc_switch_db),
    };
  }
}
