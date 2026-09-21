import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 不起 Postgres 也要守住几条硬性约束（CONTRACT §3）。
 * 这些都是「改错了不会立刻报错、但会静默算错」的地方，值得一道静态防线。
 */
const sql = readFileSync(
  fileURLToPath(new URL("../../../deploy/migrations/0001_init.sql", import.meta.url)),
  "utf8",
);

describe("0001_init.sql", () => {
  it("creates every table the contract names, plus the usage_hourly matview", () => {
    for (const t of ["profiles", "machines", "usage_events", "quota_snapshots", "calibrations"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
    }
    expect(sql).toMatch(/CREATE MATERIALIZED VIEW IF NOT EXISTS usage_hourly/);
    // profile × machine × model × hour 预聚合
    expect(sql).toMatch(/GROUP BY profile_id, machine_id, model, date_trunc\('hour', ts\)/);
    // CONCURRENTLY 刷新需要唯一索引
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS usage_hourly_uidx/);
  });

  it("keys usage_events on (message_id, request_id) with a semantic_id fallback", () => {
    expect(sql).toMatch(/PRIMARY KEY \(message_id, request_id\)/);
    // request_id 可能是空字符串（实测 519 条），所以必须 NOT NULL DEFAULT ''，不能允许 NULL
    expect(sql).toMatch(/request_id\s+TEXT NOT NULL DEFAULT ''/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS usage_events_semantic_fallback_uidx[\s\S]*?WHERE request_id = ''/,
    );
  });

  it("splits 5m and 1h cache writes into separate columns", () => {
    expect(sql).toMatch(/cache_write_5m_tokens\s+BIGINT/);
    expect(sql).toMatch(/cache_write_1h_tokens\s+BIGINT/);
    // 合并列会让近九成缓存写入算错钱
    expect(sql).not.toMatch(/cache_creation_tokens/);
  });

  it("uses NUMERIC(12,6) for money and never a float type", () => {
    expect(sql).toMatch(/cost_usd\s+NUMERIC\(12,6\)/);
    const moneyLines = sql
      .split("\n")
      .filter((l) => /cost|usd|price/i.test(l) && /REAL|DOUBLE PRECISION|FLOAT/i.test(l));
    expect(moneyLines).toEqual([]);
  });

  it("stores every timestamp as TIMESTAMPTZ", () => {
    const timeCols = sql
      .split("\n")
      .filter((l) => /^\s+\w*(_at|^\s+ts)\b/.test(l) || /\b(ts|captured_at|resets_at|computed_at|created_at|last_seen_at|revoked_at|ingested_at|applied_at)\s+TIMESTAMP/.test(l));
    expect(timeCols.length).toBeGreaterThan(0);
    for (const line of timeCols) {
      if (!/TIMESTAMP/i.test(line)) continue;
      expect(line).toMatch(/TIMESTAMPTZ/);
    }
  });

  it("puts no enum or CHECK constraint on window_kind", () => {
    // 官方字段名尚未实测确认（ARCHITECTURE §2.2），枚举会在改名当天炸掉写入
    expect(sql).not.toMatch(/CREATE TYPE .*window_kind/i);
    expect(sql).not.toMatch(/window_kind[^\n]*CHECK/i);
    expect(sql).toMatch(/window_kind\s+TEXT NOT NULL,/);
  });

  it("keeps a snapshot's collecting machine and a probe's provisional id for tracing", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS quota_snapshots[\s\S]*?machine_id\s+TEXT,/);
    expect(sql).toMatch(/provisional_machine_id TEXT,/);
    // 采集机可能还没 enroll，加外键会让快照写不进来
    expect(sql).not.toMatch(/machine_id\s+TEXT[^\n]*REFERENCES/);
  });

  it("stores the calibration scatter points alongside the fit", () => {
    // 查询时重算会拿「现在的事件」去配「当时的拟合」，补报的历史事件一进来就对不上
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS calibrations[\s\S]*?points\s+JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  });

  it("marks <synthetic> as not counting toward quota", () => {
    expect(sql).toMatch(/counts_toward_quota[\s\S]*?model <> '<synthetic>'/);
  });

  it("has no column that could hold prompt or response text", () => {
    // 只看 DDL 本身，注释里提到这些词是在说明「刻意不存」
    const ddl = sql
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    expect(ddl).not.toMatch(/\b(prompt|completion|response_text|content|tool_input)\b/i);
  });
});
