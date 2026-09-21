import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type postgres from "postgres";

/**
 * 最小迁移器。`deploy/migrations/NNNN_*.sql` 按文件名排序执行，只增不改（CONTRACT §3）。
 * 每个文件自带 BEGIN/COMMIT，所以单文件是原子的。
 *
 * ★ 必须用**独占连接**（sql.reserve()）执行。
 *   迁移文件里有自己的 BEGIN/COMMIT，而 postgres.js 会拒绝在连接池上执行显式事务控制
 *   （UNSAFE_TRANSACTION：连接可能在事务中途被归还给其他请求）。
 *   这个坑只有连真库才会暴露 —— 内存 store 和 SQL 静态检查都发现不了，
 *   所以另有一个需要 UA_TEST_DATABASE_URL 才运行的集成测试守着它。
 *
 *   推论：迁移文件**必须幂等**（一律 IF NOT EXISTS）。记账的 INSERT 在文件自身的
 *   COMMIT 之后，进程若在两者之间崩溃，该文件会被重跑一次。
 */
export async function runMigrations(
  sql: postgres.Sql<Record<string, never>>,
  dir: string,
  log: { info: (o: object, m: string) => void },
): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const content = readFileSync(join(dir, file), "utf8");
    const reserved = await sql.reserve();
    try {
      await reserved.unsafe(content);
      await reserved`INSERT INTO schema_migrations (name) VALUES (${file}) ON CONFLICT DO NOTHING`;
    } finally {
      reserved.release();
    }
    ran.push(file);
    log.info({ migration: file }, "migration applied");
  }
  return ran;
}
