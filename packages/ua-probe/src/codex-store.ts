import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CodexAccount, CodexIngestBatch, CodexParserState, CodexUsageEvent } from "@ua/core";
import type { FileCursor } from "./store.js";

export interface CodexCheckpoint { cursor: FileCursor; state: CodexParserState }

/** Immutable event outbox: HTTP ACK can never delete a newer revision of an event. */
export class CodexProbeStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS codex_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_cursors (path TEXT PRIMARY KEY, checkpoint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, shipped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS codex_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_snapshot_rejections (
        snapshot_id INTEGER PRIMARY KEY,
        http_status INTEGER NOT NULL CHECK (http_status IN (400,413,422)),
        rejected_at TEXT NOT NULL
      );
    `);
  }
  meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM codex_meta WHERE key=?").get(key);
    return row ? String(row["value"]) : null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO codex_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  bind(account: CodexAccount, scanIdentity: string): void {
    const old = this.meta("account_id");
    if (old && old !== account.account_id) throw new Error("codex_account_binding_changed");
    if (this.meta("scan_identity") !== scanIdentity) {
      // Immutable event IDs make rescan safe; changed date range/parser must not reuse old cursors.
      this.db.exec("DELETE FROM codex_cursors");
      this.setMeta("scan_identity", scanIdentity);
    }
    this.setMeta("account_id", account.account_id);
    this.setMeta("account", JSON.stringify(account));
  }
  checkpoint(path: string): CodexCheckpoint | null {
    const row = this.db.prepare("SELECT checkpoint FROM codex_cursors WHERE path=?").get(path);
    return row ? JSON.parse(String(row["checkpoint"])) as CodexCheckpoint : null;
  }
  commitFile(checkpoint: CodexCheckpoint, events: CodexUsageEvent[]): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      const ins = this.db.prepare("INSERT OR IGNORE INTO codex_events(event_id,payload) VALUES (?,?)");
      for (const event of events) inserted += Number(ins.run(event.event_id, JSON.stringify(event)).changes);
      this.db.prepare("INSERT INTO codex_cursors VALUES (?,?) ON CONFLICT(path) DO UPDATE SET checkpoint=excluded.checkpoint")
        .run(checkpoint.cursor.path, JSON.stringify(checkpoint));
      this.db.exec("COMMIT");
      return inserted;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  pendingEvents(limit: number): CodexUsageEvent[] {
    return this.db.prepare("SELECT payload FROM codex_events WHERE shipped=0 ORDER BY rowid LIMIT ?")
      .all(limit).map((row) => JSON.parse(String(row["payload"])) as CodexUsageEvent);
  }
  ackEvents(ids: string[]): void {
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare("UPDATE codex_events SET shipped=1 WHERE event_id=?");
      for (const id of ids) stmt.run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  enqueueSnapshot(batch: CodexIngestBatch): void {
    this.db.prepare("INSERT INTO codex_snapshots(payload) VALUES (?)").run(JSON.stringify(batch));
  }
  pendingSnapshots(): Array<{ id: number; batch: CodexIngestBatch }> {
    return this.db.prepare(`SELECT id,payload FROM codex_snapshots
      WHERE NOT EXISTS (SELECT 1 FROM codex_snapshot_rejections WHERE snapshot_id=codex_snapshots.id)
      ORDER BY id LIMIT 100`).all()
      .map((row) => ({ id: Number(row["id"]), batch: JSON.parse(String(row["payload"])) as CodexIngestBatch }));
  }
  /** Preserve the original payload for repair; only permanent validation statuses qualify. */
  quarantineSnapshot(id: number, httpStatus: number): void {
    if (![400, 413, 422].includes(httpStatus)) throw new Error("codex_snapshot_status_not_quarantinable");
    this.db.prepare(`INSERT OR IGNORE INTO codex_snapshot_rejections(snapshot_id,http_status,rejected_at)
      SELECT id,?,? FROM codex_snapshots WHERE id=?`).run(httpStatus, new Date().toISOString(), id);
  }
  rejectedSnapshots(limit = 100): Array<{ id: number; batch: CodexIngestBatch; http_status: number; rejected_at: string }> {
    return this.db.prepare(`SELECT s.id,s.payload,r.http_status,r.rejected_at FROM codex_snapshots s
      JOIN codex_snapshot_rejections r ON r.snapshot_id=s.id ORDER BY s.id LIMIT ?`).all(limit)
      .map((row) => ({ id: Number(row["id"]), batch: JSON.parse(String(row["payload"])) as CodexIngestBatch,
        http_status: Number(row["http_status"]), rejected_at: String(row["rejected_at"]) }));
  }
  ackSnapshot(id: number): void {
    this.db.prepare(`DELETE FROM codex_snapshots WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM codex_snapshot_rejections WHERE snapshot_id=codex_snapshots.id)`).run(id);
  }
  stats(): { events: number; pending_events: number; pending_snapshots: number; rejected_snapshots: number; files: number } {
    const count = (query: string): number => Number(this.db.prepare(query).get()?.["n"] ?? 0);
    return {
      events: count("SELECT count(*) n FROM codex_events"),
      pending_events: count("SELECT count(*) n FROM codex_events WHERE shipped=0"),
      pending_snapshots: count(`SELECT count(*) n FROM codex_snapshots
        WHERE NOT EXISTS (SELECT 1 FROM codex_snapshot_rejections WHERE snapshot_id=codex_snapshots.id)`),
      rejected_snapshots: count("SELECT count(*) n FROM codex_snapshot_rejections"),
      files: count("SELECT count(*) n FROM codex_cursors"),
    };
  }
  close(): void { this.db.close(); }
}
