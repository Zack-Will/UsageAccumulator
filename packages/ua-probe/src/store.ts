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
    // ★ 撞锁要等，不要抛。node:sqlite 把 SQLITE_BUSY 抛成未捕获异常，进程当场崩；
    //   真正的单实例保证在 lock.ts，这里只是兜住瞬时重叠（旧实例正在收尾、
    //   status 子命令顺手建表之类）。默认的 0ms 意味着任何重叠都是死刑。
    this.db.exec("PRAGMA busy_timeout = 5000");
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
        created_at INTEGER NOT NULL,
        usage_rank INTEGER NOT NULL DEFAULT 0
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
      -- 会话标题：shipped 记录「最后一次成功上报的是哪个标题」，与 title 不同即待上报
      CREATE TABLE IF NOT EXISTS session_titles (
        session_id TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        kind       TEXT NOT NULL,
        shipped    TEXT
      );
    `);
    // 老库没有 usage_rank：补列，并按已排队负载里的 output_tokens 估一个分数 ——
    // 否则排队中的旧行分数全是 0，任何一行流式中途值都能把它顶掉
    const cols = this.db.prepare("PRAGMA table_info(event_queue)").all().map((r) => asString(r["name"]));
    if (!cols.includes("usage_rank")) {
      this.db.exec("ALTER TABLE event_queue ADD COLUMN usage_rank INTEGER NOT NULL DEFAULT 0");
      this.db.exec(
        "UPDATE event_queue SET usage_rank = COALESCE(json_extract(payload, '$.output_tokens'), 0) * 3",
      );
    }
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

  // ── 会话标题 ─────────────────────────────────────────────────────────
  /**
   * 记下一个会话的标题。返回是否真的变了。
   * 用户起的标题（custom）优先于 agent 名：后到的 agent 名不能把它盖掉。
   */
  putSessionTitle(sessionId: string, title: string, kind: "custom" | "agent"): boolean {
    const cur = this.db.prepare("SELECT title, kind FROM session_titles WHERE session_id = ?").get(sessionId);
    if (cur) {
      if (asString(cur["kind"]) === "custom" && kind === "agent") return false;
      if (asString(cur["title"]) === title && asString(cur["kind"]) === kind) return false;
    }
    this.db
      .prepare(
        `INSERT INTO session_titles (session_id, title, kind, shipped) VALUES (?, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, kind = excluded.kind`,
      )
      .run(sessionId, title, kind);
    return true;
  }

  /** 还没上报、或上报后又改了名的标题 */
  pendingSessionTitles(limit: number): { sessionId: string; title: string }[] {
    return this.db
      .prepare(
        "SELECT session_id, title FROM session_titles WHERE shipped IS NULL OR shipped <> title LIMIT ?",
      )
      .all(limit)
      .map((r) => ({ sessionId: asString(r["session_id"]), title: asString(r["title"]) }));
  }

  /**
   * 标记为已上报。只标记「上报的正是当前标题」的行：
   * 发出去之后、回执之前如果又改了名，那一行必须继续待上报。
   */
  markSessionTitlesShipped(rows: { sessionId: string; title: string }[]): void {
    const stmt = this.db.prepare("UPDATE session_titles SET shipped = ? WHERE session_id = ? AND title = ?");
    for (const r of rows) stmt.run(r.title, r.sessionId, r.title);
  }

  sessionTitleCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM session_titles").get();
    return asNumber(row?.["n"]);
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

  /** 清空全部游标：下一轮扫描会把所有文件从头重读（一次性重扫用）。 */
  clearCursors(): number {
    return Number(this.db.prepare("DELETE FROM cursors").run().changes);
  }

  cursorCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM cursors").get();
    return asNumber(row?.["n"]);
  }

  // ── event queue ───────────────────────────────────────────────────────
  /**
   * 入队。dedup_key 唯一 —— 同一条事件被重复解析（比如游标回滚重读）时本地就吃掉，
   * 不劳服务端。
   *
   * ★ 同一个键再来时不是丢掉，而是**用量更完整就替换**（`rank` = @ua/core 的 usageRank）：
   * 一条消息在 JSONL 里有多行，子代理文件只有最后一行是最终用量，先到先得会把
   * 流式中途值发出去。已经发走（被 ack 删掉）的键再来会重新入队，由服务端覆盖。
   *
   * 返回新入队或被替换的条数。
   */
  enqueueEvents(rows: { dedupKey: string; payload: string; backfill: boolean; rank: number }[]): number {
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO event_queue (dedup_key, payload, backfill, created_at, usage_rank) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(dedup_key) DO UPDATE SET payload = excluded.payload, usage_rank = excluded.usage_rank
       WHERE excluded.usage_rank > event_queue.usage_rank`,
    );
    const now = Date.now();
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const res = stmt.run(r.dedupKey, r.payload, r.backfill ? 1 : 0, now, r.rank);
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
