import { resolve } from "node:path";
import postgres from "postgres";
import { ClaudeWebClient } from "@ua/core";
import { buildApp } from "./app.js";
import { startCalibrationJob } from "./calibration-job.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { PriceBook } from "./pricing.js";
import { startRepricing } from "./live-pricing.js";
import { runMigrations } from "./migrate.js";
import { PgStore } from "./store-pg.js";
import { fetchGet } from "./quota-sampler.js";
import { FileSessionVault } from "./quota-vault.js";
import { codexFetch } from "./codex-web.js";
import { computeCurrentWindows } from "./windows-service.js";

const config = loadConfig();
const log = createLogger(config.logLevel);

async function main(): Promise<void> {
  if (!config.databaseUrl) {
    log.error({}, "DATABASE_URL is required");
    process.exit(1);
  }

  // 缺定价不是致命错误：成本字段会是 null，其余指标照常。比猜一个价格安全得多。
  const pricing = new PriceBook(
    [
      { kind: "bundled", path: resolve(config.pricingFile), optional: false },
      { kind: "override", path: resolve(config.pricingOverrideFile), optional: true },
    ],
    log,
  );
  pricing.reload();
  const stopPricingWatch = pricing.watch();
  process.on("SIGHUP", () => {
    log.info({}, "收到 SIGHUP，重新加载定价表");
    pricing.reload();
  });

  const sql = postgres(config.databaseUrl, { max: 10, idle_timeout: 30, onnotice: () => {} });
  await runMigrations(
    sql as postgres.Sql<Record<string, never>>,
    resolve("deploy/migrations"),
    log,
  );

  const rawStore = new PgStore(sql as postgres.Sql<Record<string, never>>);
  // claude.ai 会话存文件不进库（见 quota-vault.ts）；服务端自己抓额度：额度在动时 10 秒一次，没变化逐次翻倍放慢到 5 分钟
  const quota = config.quotaSampling
    ? {
        vault: new FileSessionVault(resolve(config.claudeSessionDir), (msg) => log.warn({}, msg)),
        client: new ClaudeWebClient(fetchGet, config.claudeBaseUrl),
        intervalMs: config.quotaIntervalMs,
        jitterMs: config.quotaJitterMs,
        minIntervalMs: config.quotaMinIntervalMs,
      }
    : undefined;
  // Codex 的服务端专用登录同样存文件不进库（见 codex-web.ts 为什么不能和本机 CLI 共用一份）
  const codex = config.codexSampling
    ? {
        vault: new FileSessionVault(resolve(config.codexSessionDir), (msg) => log.warn({}, msg)),
        http: codexFetch,
        intervalMs: config.quotaIntervalMs,
        jitterMs: config.quotaJitterMs,
      }
    : undefined;
  // 返回的 store 已包上「读取时按当前价格算成本」，后面的定时任务都用它
  const { fastify, bus, sampler, codexSampler, store } = buildApp({
    store: rawStore, config, pricing, logger: log, ...(quota ? { quota } : {}), ...(codex ? { codex } : {}),
  });
  // 库里的 cost_usd 列在后台跟上价格变化（启动时补一次，之后每次改价再补）
  const repricing = startRepricing(store, pricing, log);
  void repricing.trigger();

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
          timeZone: config.timeZone,
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
  const stopCodexSampler = codexSampler ? codexSampler.start() : () => {};
  log.info(
    { sampling: Boolean(sampler), dir: sampler ? resolve(config.claudeSessionDir) : undefined },
    sampler ? "额度采样器已启动" : "服务端额度采样已关闭（只收探针上报）",
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    stopCalibration();
    stopSampler();
    stopCodexSampler();
    stopPricingWatch();
    repricing.stop();
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
