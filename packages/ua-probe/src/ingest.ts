import { dedupKey, parseLine, projectSlugFromPath, type ParseWarning } from "@ua/core";
import type { ProbeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { Attributor, extractOwnerAccountUuid } from "./attributor.js";
import { readNewLines } from "./scanner.js";
import type { ProbeStore } from "./store.js";
import { toWireEvent } from "./wire.js";
import { basename, dirname } from "node:path";

export interface IngestStats {
  files: number;
  lines: number;
  events: number;
  enqueued: number;
  resets: number;
  dropped: number;
  warnings: Record<string, number>;
}

export function emptyStats(): IngestStats {
  return { files: 0, lines: 0, events: 0, enqueued: 0, resets: 0, dropped: 0, warnings: {} };
}

/**
 * JSONL → UsageEvent → 归属打标 → 本地队列。
 * 解析全部复用 @ua/core 的 parseLine —— 探针侧不重新实现任何字段映射。
 */
export class Ingestor {
  constructor(
    private readonly cfg: ProbeConfig,
    private readonly store: ProbeStore,
    private readonly attributor: Attributor,
    private readonly log: Logger,
  ) {}

  async ingestFile(path: string, opts: { backfill: boolean }, stats: IngestStats): Promise<void> {
    const prev = this.store.getCursor(path);
    // project_slug 取所在目录名；scan_roots 可能不含 /projects/，退化成父目录名
    const slug = projectSlugFromPath(path) ?? basename(dirname(path));

    const pending: { dedupKey: string; payload: string; backfill: boolean }[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      stats.enqueued += this.store.enqueueEvents(pending);
      pending.length = 0;
    };

    let outcome;
    try {
      outcome = await readNewLines(path, prev, (raw) => {
        stats.lines++;
        const { event, warnings } = parseLine(raw, {
          machineId: this.cfg.machine_id,
          profileId: this.cfg.default_profile_id,
          attributionLevel: "unknown",
          appType: this.cfg.app_type,
          projectSlug: slug,
          backfill: opts.backfill,
        });
        for (const w of warnings) countWarning(stats.warnings, w);
        if (!event) return;

        const attr = this.attributor.attribute({
          requestId: event.requestId,
          tsMs: event.ts.getTime(),
          ownerAccountUuid: extractOwnerAccountUuid(raw),
        });
        event.profileId = attr.profileId;
        event.attributionLevel = attr.level;

        stats.events++;
        pending.push({
          dedupKey: dedupKey(event),
          payload: JSON.stringify(
            toWireEvent(event, {
              hashProjectPaths: this.cfg.hash_project_paths,
              projectHashSecret: this.cfg.project_hash_secret,
            }),
          ),
          backfill: opts.backfill,
        });
        if (pending.length >= 500) flush();
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") this.log.warn({ path, err: e.message }, "读取文件失败");
      flush();
      return;
    }

    flush();
    stats.files++;
    if (outcome.reset === "inode-changed" || outcome.reset === "truncated") {
      stats.resets++;
      this.log.info({ path, reason: outcome.reset }, "游标重置，文件从头重读");
    }
    // 游标在事件安全落入持久化队列之后才推进：进程此刻被杀也只会重读，不会丢
    this.store.putCursor(outcome.cursor);

    const dropped = this.store.trimQueue(this.cfg.queue.max_rows);
    if (dropped > 0) {
      stats.dropped += dropped;
      this.log.error({ dropped, maxRows: this.cfg.queue.max_rows }, "★ 队列超上限，丢弃最旧的事件");
    }
  }
}

function countWarning(acc: Record<string, number>, w: ParseWarning): void {
  acc[w.kind] = (acc[w.kind] ?? 0) + 1;
}
