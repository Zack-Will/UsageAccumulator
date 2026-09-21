import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Node 内置 SQLite：避免 better-sqlite3 的原生编译，Linux 侧部署少一个坑。
import { DatabaseSync } from "node:sqlite";

export interface FileCursor {
  path: string;
  /** stat.ino，字符串存以免超出 Number 安全范围 */
  inode: string;
  size: number;
  offset: number;
  mtime: number;
}

export interface QueuedEvent {
  id: number;
  dedupKey: string;
  payload: string;
  backfill: boolean;
}

export interface QueuedQuota {
  id: number;
  payload: string;
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return fallback;
}

/**
 * 本地状态库：断点续传游标 + 上报缓冲队列 + profile 时间线。
 * 断网堆积、重启不丢；上报成功才删除（ARCHITECTURE §5.2）。
 */
export class ProbeStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursors (
        path        TEXT PRIMARY KEY,
        inode       TEXT NOT NULL,
        size        INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        mtime       INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        dedup_key  TEXT NOT NULL UNIQUE,
        payload    TEXT NOT NULL,
        backfill   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile_timeline (
        changed_at INTEGER PRIMARY KEY,
        profile_id TEXT NOT NULL,
        source     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── meta ──────────────────────────────────────────────────────────────
  getMeta(k: string): string | null {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
    return row ? asString(row["v"]) : null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  /** 探针安装时间。此前的 JSONL 没有时间线可依，一律 attribution_level = 'unknown'。 */
  installedAt(): number {
    const raw = this.getMeta("installed_at");
    if (raw) return Number(raw);
    const now = Date.now();
    this.setMeta("installed_at", String(now));
    return now;
  }

  // ── cursors ───────────────────────────────────────────────────────────
  getCursor(path: string): FileCursor | null {
    const row = this.db.prepare("SELECT * FROM cursors WHERE path = ?").get(path);
    if (!row) return null;
    return {
      path: asString(row["path"]),
      inode: asString(row["inode"]),
      size: asNumber(row["size"]),
      offset: asNumber(row["byte_offset"]),
      mtime: asNumber(row["mtime"]),
    };
  }

  putCursor(c: FileCursor): void {
    this.db
      .prepare(
        `INSERT INTO cursors (path, inode, size, byte_offset, mtime) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, size = excluded.size,
           byte_offset = excluded.byte_offset, mtime = excluded.mtime`,
      )
      .run(c.path, c.inode, c.size, c.offset, c.mtime);
  }

  allCursors(): FileCursor[] {
    return this.db
      .prepare("SELECT * FROM cursors")
      .all()
      .map((row) => ({
        path: asString(row["path"]),
        inode: asString(row["inode"]),
        size: asNumber(row["size"]),
        offset: asNumber(row["byte_offset"]),
        mtime: asNumber(row["mtime"]),
      }));
  }

  cursorCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM cursors").get();
    return asNumber(row?.["n"]);
  }

  // ── event queue ───────────────────────────────────────────────────────
  /**
   * 入队。dedup_key 唯一 —— 同一条事件被重复解析（比如游标回滚重读）时本地就吃掉，
   * 不劳服务端。返回真正新入队的条数。
   */
  enqueueEvents(rows: { dedupKey: string; payload: string; backfill: boolean }[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO event_queue (dedup_key, payload, backfill, created_at) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const res = stmt.run(r.dedupKey, r.payload, r.backfill ? 1 : 0, now);
        inserted += Number(res.changes);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return inserted;
  }

  takeEvents(limit: number): QueuedEvent[] {
    return this.db
      .prepare("SELECT id, dedup_key, payload, backfill FROM event_queue ORDER BY id LIMIT ?")
      .all(limit)
      .map((row) => ({
        id: asNumber(row["id"]),
        dedupKey: asString(row["dedup_key"]),
        payload: asString(row["payload"]),
        backfill: asNumber(row["backfill"]) === 1,
      }));
  }

  ackEvents(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM event_queue WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const id of ids) stmt.run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  queueDepth(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM event_queue").get();
    return asNumber(row?.["n"]);
  }

  /** 队列超上限时丢最旧的。返回被丢弃的条数，调用方必须告警。 */
  trimQueue(maxRows: number): number {
    const depth = this.queueDepth();
    if (depth <= maxRows) return 0;
    const excess = depth - maxRows;
    const res = this.db
      .prepare("DELETE FROM event_queue WHERE id IN (SELECT id FROM event_queue ORDER BY id LIMIT ?)")
      .run(excess);
    return Number(res.changes);
  }

  // ── quota queue ───────────────────────────────────────────────────────
  enqueueQuota(payload: string): void {
    this.db.prepare("INSERT INTO quota_queue (payload, created_at) VALUES (?, ?)").run(payload, Date.now());
  }

  takeQuota(limit: number): QueuedQuota[] {
    return this.db
      .prepare("SELECT id, payload FROM quota_queue ORDER BY id LIMIT ?")
      .all(limit)
      .map((row) => ({ id: asNumber(row["id"]), payload: asString(row["payload"]) }));
  }

  ackQuota(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM quota_queue WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  quotaDepth(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM quota_queue").get();
    return asNumber(row?.["n"]);
  }

  // ── profile timeline（L2） ────────────────────────────────────────────
  /** 同一毫秒重复写入是幂等的；profile 没变时不落新点。 */
  appendTimeline(changedAt: number, profileId: string, source: string): boolean {
    const last = this.latestTimeline();
    if (last && last.profileId === profileId) return false;
    this.db
      .prepare("INSERT OR REPLACE INTO profile_timeline (changed_at, profile_id, source) VALUES (?, ?, ?)")
      .run(changedAt, profileId, source);
    return true;
  }

  latestTimeline(): { changedAt: number; profileId: string; source: string } | null {
    const row = this.db.prepare("SELECT * FROM profile_timeline ORDER BY changed_at DESC LIMIT 1").get();
    if (!row) return null;
    return {
      changedAt: asNumber(row["changed_at"]),
      profileId: asString(row["profile_id"]),
      source: asString(row["source"]),
    };
  }

  /** 按事件时间戳二分查找当时生效的 profile。早于最早一个时间点则返回 null。 */
  timelineAt(tsMs: number): { changedAt: number; profileId: string; source: string } | null {
    const row = this.db
      .prepare("SELECT * FROM profile_timeline WHERE changed_at <= ? ORDER BY changed_at DESC LIMIT 1")
      .get(tsMs);
    if (!row) return null;
    return {
      changedAt: asNumber(row["changed_at"]),
      profileId: asString(row["profile_id"]),
      source: asString(row["source"]),
    };
  }

  allTimeline(): { changedAt: number; profileId: string; source: string }[] {
    return this.db
      .prepare("SELECT * FROM profile_timeline ORDER BY changed_at")
      .all()
      .map((row) => ({
        changedAt: asNumber(row["changed_at"]),
        profileId: asString(row["profile_id"]),
        source: asString(row["source"]),
      }));
  }
}
