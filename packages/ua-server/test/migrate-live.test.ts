/**
 * 需要真 Postgres 的迁移集成测试。
 *
 * 默认跳过；设了 UA_TEST_DATABASE_URL 才跑：
 *   docker run -d --name ua-pg-test -e POSTGRES_PASSWORD=t -e POSTGRES_DB=ua -p 55433:5432 postgres:17
 *   UA_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55433/ua npx vitest run --root packages/ua-server
 *
 * 为什么必须有这条：迁移文件自带 BEGIN/COMMIT，在连接池上执行会被 postgres.js 以
 * UNSAFE_TRANSACTION 拒绝。这个故障在内存 store 和 SQL 静态检查里都看不见，
 * 实际部署到真库时才炸（已发生过一次）。
 */
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import { PgStore } from "../src/store-pg.js";

const url = process.env["UA_TEST_DATABASE_URL"];
const dir = fileURLToPath(new URL("../../../deploy/migrations", import.meta.url));
const silent = { info: () => {} };

describe.skipIf(!url)("migrations against a real Postgres", () => {
  const sql = postgres(url ?? "", { max: 5, onnotice: () => {} });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("在连接池上也能跑通（迁移文件带 BEGIN/COMMIT）", async () => {
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const ran = await runMigrations(sql, dir, silent);
    expect(ran.length).toBeGreaterThan(0);
  });

  it("重跑是幂等的，且不会重复记账", async () => {
    const again = await runMigrations(sql, dir, silent);
    expect(again).toEqual([]);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM schema_migrations`;
    expect(row!.n).toBeGreaterThan(0);
  });

  it("契约关键约束确实落到了库上", async () => {
    const [pk] = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'p' AND conrelid = 'usage_events'::regclass`;
    expect(pk!.def).toBe("PRIMARY KEY (message_id, request_id)");

    const cols = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'usage_events'`;
    const names = cols.map((c) => c.column_name);
    // 5m / 1h 必须分列：实测 87.8% 的缓存写入是 1h，合并会系统性算错钱
    expect(names).toContain("cache_write_5m_tokens");
    expect(names).toContain("cache_write_1h_tokens");
    // 金额不得用浮点
    expect(cols.find((c) => c.column_name === "cost_usd")?.data_type).toBe("numeric");
    // 不得存任何正文
    expect(names.some((n) => /prompt|content|body/i.test(n))).toBe(false);

    const bad = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'`;
    expect(bad[0]!.n).toBe(0);
  });
});

/**
 * quotaSamples 的上界。
 *
 * 为什么必须打真库：不带上界时曾经用「JS 最大日期」当哨兵，Postgres 直接报
 * `time zone displacement out of range` 让请求 500 —— 内存 store 里这一句
 * 根本不执行 SQL，类型检查也看不出问题。2026-09-22 线上炸过一次：
 * /v1/summary 与 /v1/ingest/quota 一起挂掉。
 */
describe.skipIf(!url)("quotaSamples 的时间上界", () => {
  const sql = postgres(url ?? "", { max: 5, onnotice: () => {} });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("不带上界时不会构造出 Postgres 存不下的时间戳", async () => {
    await runMigrations(sql, dir, silent);
    await sql`INSERT INTO profiles (id, kind) VALUES ('p-quota', 'oauth') ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO quota_snapshots (profile_id, captured_at, window_kind, utilization_pct)
      VALUES ('p-quota', now(), 'seven_day', 42)
      ON CONFLICT DO NOTHING`;

    const store = new PgStore(sql);
    const since = new Date(Date.now() - 86_400_000);
    await expect(store.quotaSamples("p-quota", "seven_day", since)).resolves.toHaveLength(1);
  });

  it("带上界时按闭区间过滤", async () => {
    const store = new PgStore(sql);
    const since = new Date(Date.now() - 86_400_000);
    const past = new Date(Date.now() - 3_600_000);
    await expect(store.quotaSamples("p-quota", "seven_day", since, past)).resolves.toHaveLength(0);
  });
});
