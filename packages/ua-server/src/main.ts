import { resolve } from "node:path";
import postgres from "postgres";
import { ClaudeWebClient } from "@ua/core";
import { buildApp } from "./app.js";
import { startCalibrationJob } from "./calibration-job.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { loadPricingTable } from "./pricing.js";
import { runMigrations } from "./migrate.js";
import { PgStore } from "./store-pg.js";
import { fetchGet } from "./quota-sampler.js";
import { FileSessionVault } from "./quota-vault.js";
import { computeCurrentWindows } from "./windows-service.js";

const config = loadConfig();
const log = createLogger(config.logLevel);

async function main(): Promise<void> {
  if (!config.databaseUrl) {
    log.error({}, "DATABASE_URL is required");
    process.exit(1);
  }

  const { table: pricing, errors: pricingErrors } = loadPricingTable(resolve(config.pricingFile));
  if (pricingErrors.length > 0) {
    // 缺定价不是致命错误：成本字段会是 null，其余指标照常。比猜一个价格安全得多。
    log.warn({ errors: pricingErrors }, "pricing table incomplete; cost fields will be null");
  }
  log.info({ models: Object.keys(pricing).length }, "pricing table loaded");

  const sql = postgres(config.databaseUrl, { max: 10, idle_timeout: 30, onnotice: () => {} });
  await runMigrations(
    sql as postgres.Sql<Record<string, never>>,
    resolve("deploy/migrations"),
    log,
  );

  const store = new PgStore(sql as postgres.Sql<Record<string, never>>);
  // claude.ai 会话存文件不进库（见 quota-vault.ts）；服务端每 5 分钟自己抓一次额度
  const quota = config.quotaSampling
    ? {
        vault: new FileSessionVault(resolve(config.claudeSessionDir), (msg) => log.warn({}, msg)),
        client: new ClaudeWebClient(fetchGet, config.claudeBaseUrl),
        intervalMs: config.quotaIntervalMs,
        jitterMs: config.quotaJitterMs,
      }
    : undefined;
  const { fastify, bus, sampler } = buildApp({ store, config, pricing, logger: log, ...(quota ? { quota } : {}) });

  // usage_hourly 刷新（ARCHITECTURE §6.2）
  const refreshTimer =
    config.refreshIntervalMs > 0
      ? setInterval(() => {
          void store.refreshHourly().catch((err) => log.error({ err }, "refresh usage_hourly failed"));
        }, config.refreshIntervalMs)
      : null;
  refreshTimer?.unref?.();

  // SSE window_update 定期推送；额度入库时还会即时推一次
  const streamTimer = setInterval(() => {
    void (async () => {
      if (bus.size === 0) return;
      for (const profile of await store.listProfiles()) {
        const current = await computeCurrentWindows(store, profile.id, {
          quotaStaleMs: config.quotaStaleMs,
        });
        bus.publish({ name: "window_update", profileId: profile.id, data: current });
      }
    })().catch((err) => log.error({ err }, "stream tick failed"));
  }, config.streamIntervalMs);
  streamTimer.unref?.();

  const stopCalibration = startCalibrationJob(store, config.calibrationIntervalMs, log);

  await fastify.listen({ host: config.host, port: config.port });
  log.info({ host: config.host, port: config.port }, "ua-server listening");

  const stopSampler = sampler ? sampler.start() : () => {};
  log.info(
    { sampling: Boolean(sampler), dir: sampler ? resolve(config.claudeSessionDir) : undefined },
    sampler ? "额度采样器已启动" : "服务端额度采样已关闭（只收探针上报）",
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    stopCalibration();
    stopSampler();
    if (refreshTimer) clearInterval(refreshTimer);
    clearInterval(streamTimer);
    await fastify.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
