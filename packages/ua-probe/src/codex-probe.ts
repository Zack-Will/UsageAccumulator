import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createCodexParserState, parseCodexLine, type CodexAccount, type CodexIngestBatch, type CodexUsageEvent } from "@ua/core";
import type { ProbeConfig } from "./config.js";
import { CodexClient } from "./codex-client.js";
import { CodexProbeStore } from "./codex-store.js";
import { expandHome } from "./paths.js";
import { readNewLines, walkScanRoots } from "./scanner.js";
import { hashProjectSlug } from "./wire.js";
import { createLogger, type Logger } from "./logger.js";

interface AccountReader {
  start(): Promise<void>;
  readAccount(expectedEmail: string): Promise<{ account: CodexAccount; quota: NonNullable<CodexIngestBatch["quota"]> }>;
  readUsage(threadIds?: string[]): Promise<NonNullable<CodexIngestBatch["account_usage"]>>;
  close(): void | Promise<void>;
}

/** HTTP status is structured: an arbitrary network error message must never trigger quarantine. */
export class CodexIngestHttpError extends Error {
  constructor(readonly status: number) { super(`codex_ingest_http_${status}`); }
}

export class CodexProbe {
  readonly store: CodexProbeStore;
  readonly log: Logger;
  private readonly roots: string[];
  private readonly from: number;
  private stopped = false;
  private client: AccountReader | null = null;
  private wake: (() => void) | null = null;
  private readonly makeClient: () => AccountReader;
  private readonly fetcher: typeof fetch;
  constructor(private readonly cfg: ProbeConfig, opts: { logger?: Logger; makeClient?: () => AccountReader; fetcher?: typeof fetch } = {}) {
    if (!cfg.codex.enabled) throw new Error("codex_not_enabled");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.codex.expected_email)) throw new Error("codex_expected_email_required");
    this.from = Date.parse(cfg.codex.backfill_from);
    if (!Number.isFinite(this.from)) throw new Error("codex_backfill_from_required");
    const home = expandHome(cfg.codex.home);
    this.roots = cfg.codex.scan_roots.length ? cfg.codex.scan_roots.map(expandHome) : [join(home, "sessions"), join(home, "archived_sessions")];
    this.log = opts.logger ?? createLogger(cfg.log_level);
    this.store = new CodexProbeStore(expandHome(cfg.codex.state_db));
    this.makeClient = opts.makeClient ?? (() => new CodexClient({ binaryPath: cfg.codex.binary_path, codexHome: home, timeoutMs: cfg.codex.request_timeout_ms }));
    this.fetcher = opts.fetcher ?? fetch;
  }

  async scan(): Promise<{ files: number; events: number; warnings: number }> {
    const stats = { files: 0, events: 0, warnings: 0 };
    const paths = await walkScanRoots(this.roots);
    for (const path of paths) {
      if (this.stopped) break;
      try {
        const prev = this.store.checkpoint(path);
        const info = await stat(path);
        const reset = !prev || prev.cursor.inode !== String(info.ino) || info.size < prev.cursor.offset;
        let state = reset ? createCodexParserState() : prev.state;
        const events: CodexUsageEvent[] = [];
        const outcome = await readNewLines(path, reset ? null : prev.cursor, (line) => {
          const parsed = parseCodexLine(line, state);
          state = parsed.state;
          stats.warnings += parsed.warnings.length;
          const event = parsed.event;
          if (!event || Date.parse(event.ts) < this.from) return;
          if (event.project && this.cfg.hash_project_paths) event.project = hashProjectSlug(event.project, this.cfg.project_hash_secret);
          // Historical attribution is an explicit operator binding, not proof of past billing route.
          event.quality_flags = [...new Set([...event.quality_flags, "configured_account_history"])];
          events.push(event);
        }, true);
        stats.events += this.store.commitFile({ cursor: outcome.cursor, state }, events);
        stats.files++;
      } catch {
        // Neither filenames nor arbitrary parser errors may contain transcript fragments in logs.
        stats.warnings++;
        this.log.warn({ code: "codex_file_scan_failed" }, "Codex 文件扫描失败，保留游标等待重试");
      }
    }
    return stats;
  }

  private collector(stats: { files: number; warnings: number }, state: "ok" | "auth" | "error" = "ok", error: string | null = null): CodexIngestBatch["collector"] {
    return this.withSnapshotRejection({ captured_at: new Date().toISOString(), state, error_code: error, backfill_from: new Date(this.from).toISOString(),
      scanned_files: stats.files, parse_warnings: stats.warnings, account_binding: "verified_login_configured_history" });
  }
  private withSnapshotRejection(collector: CodexIngestBatch["collector"]): CodexIngestBatch["collector"] {
    // An active login failure remains the most actionable state. A recovered/normal sync
    // continues to disclose quarantined history until an operator repairs that evidence.
    if (collector.state === "auth" || this.store.stats().rejected_snapshots === 0) return collector;
    return { ...collector, state: "error", error_code: "codex_snapshot_rejected" };
  }
  private async post(batch: CodexIngestBatch): Promise<void> {
    const response = await this.fetcher(`${this.cfg.server.url.replace(/\/$/, "")}/v1/codex/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.server.machine_token}` },
      body: JSON.stringify({ ...batch, collector: this.withSnapshotRejection(batch.collector) }),
      signal: AbortSignal.timeout(this.cfg.server.request_timeout_ms),
    });
    if (!response.ok) throw new CodexIngestHttpError(response.status);
    const receipt = await response.json() as { accepted?: number; deduped?: number };
    if (batch.events.length && (receipt.accepted ?? 0) + (receipt.deduped ?? 0) !== batch.events.length) throw new Error("codex_ingest_receipt_mismatch");
  }
  async drain(account: CodexAccount, collector: CodexIngestBatch["collector"]): Promise<number> {
    let sent = 0;
    let rejectionStatusQueued = false;
    // Preserve every offline complete snapshot. Server orders by captured_at, never arrival time.
    for (;;) {
      const snapshots = this.store.pendingSnapshots();
      if (!snapshots.length || this.stopped) break;
      for (const row of snapshots) {
        try { await this.post(row.batch); this.store.ackSnapshot(row.id); }
        catch (error) {
          if (!(error instanceof CodexIngestHttpError) || ![400, 413, 422].includes(error.status)) throw error;
          this.store.quarantineSnapshot(row.id, error.status);
          this.log.warn({ code: "codex_snapshot_rejected", http_status: error.status }, "Codex 快照被永久拒绝，已保留并隔离，继续处理队列");
          // Even if no later snapshots/events exist, report the degraded collector state.
          // Queue at most one minimal status per drain: rejection of that status cannot loop.
          if (!rejectionStatusQueued) {
            this.store.enqueueSnapshot({ schema_version: 1, account, events: [],
              collector: this.withSnapshotRejection({ ...collector, captured_at: new Date().toISOString() }) });
            rejectionStatusQueued = true;
          }
        }
      }
    }
    while (!this.stopped) {
      const events = this.store.pendingEvents(Math.min(this.cfg.server.batch_size, 1000));
      if (!events.length) break;
      await this.post({ schema_version: 1, account, events, collector });
      this.store.ackEvents(events.map((e) => e.event_id));
      sent += events.length;
    }
    return sent;
  }
  async sync(): Promise<{ files: number; events: number; warnings: number; sent: number; rejected_snapshots: number }> {
    this.client = this.makeClient();
    let account: CodexAccount;
    let quota: NonNullable<CodexIngestBatch["quota"]>;
    let accountUsage: CodexIngestBatch["account_usage"];
    let usageError = false;
    try {
      await this.client.start();
      ({ account, quota } = await this.client.readAccount(this.cfg.codex.expected_email));
      this.store.bind(account, JSON.stringify({ version: 1, roots: this.roots, from: this.from }));
      if (this.cfg.codex.account_usage) {
        try { accountUsage = await this.client.readUsage(); }
        catch { usageError = true; this.log.warn({ code: "codex_account_usage_unavailable" }, "Codex 官方汇总不可用，继续额度与本地明细采集"); }
      }
    } catch {
      const previous = this.store.meta("account");
      if (previous) {
        this.store.enqueueSnapshot({ schema_version: 1, account: JSON.parse(previous) as CodexAccount, events: [],
          collector: this.collector({ files: 0, warnings: 0 }, "auth", "codex_account_read_failed") });
        // Ship old account's already-bound outbox; never scan new logs on an unverified login.
        try { await this.drain(JSON.parse(previous) as CodexAccount, this.collector({ files: 0, warnings: 0 }, "auth", "codex_account_read_failed")); } catch { /* queued for retry */ }
      }
      throw new Error("codex_account_read_failed");
    } finally {
      await this.client.close(); this.client = null;
    }
    const stats = await this.scan();
    const collector = this.collector(stats, usageError ? "error" : "ok", usageError ? "codex_account_usage_unavailable" : null);
    this.store.enqueueSnapshot({ schema_version: 1, account, events: [], quota, ...(accountUsage ? { account_usage: accountUsage } : {}), collector });
    const sent = await this.drain(account, collector);
    const local = this.store.stats();
    if (local.rejected_snapshots > 0) this.log.warn({ ...stats, sent, ...local, code: "codex_snapshot_rejected" }, "Codex 同步完成，仍有隔离快照需要处理");
    else this.log.info({ ...stats, sent, ...local }, "Codex 同步完成");
    return { ...stats, sent, rejected_snapshots: local.rejected_snapshots };
  }
  async run(): Promise<void> {
    while (!this.stopped) {
      try { await this.sync(); }
      catch { this.log.error({ code: "codex_sync_failed", ...this.store.stats() }, "Codex 同步失败，保留队列并等待重试"); }
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.wake = null; resolve(); }, this.cfg.codex.interval_secs * 1000);
        this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
      });
    }
  }
  async stop(): Promise<void> { this.stopped = true; this.wake?.(); await this.client?.close(); }
  close(): void { this.store.close(); }
}
