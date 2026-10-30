#!/usr/bin/env -S npx tsx
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, renderConfigToml } from "./config.js";
import { defaultCliPath, installService } from "./install.js";
import { LockBusyError, acquireForRun, lockPathFor, tryAcquire } from "./lock.js";
import { createLogger } from "./logger.js";
import { DEFAULT_CONFIG_PATH, expandHome } from "./paths.js";
import { Probe } from "./probe.js";
import { Shipper } from "./shipper.js";
import {
  RELEASE_TGZ_URL, detectInstall, findServices, npmInstallGlobal, realPath, restartCommand, restartServices, updateBundle,
} from "./update.js";

const USAGE = `ua-probe —— UsageAccumulator 本地探针

  ua-probe install [选项]     生成 machine_id、写配置、装 launchd/systemd 服务
  ua-probe run                常驻：监听 + 增量解析 + 上报 + 额度采集
  ua-probe backfill           首次全量解析历史 JSONL，限速上报（backfill=true）
  ua-probe status             打印队列深度、游标数、归属时间线等
  ua-probe codex-run          独立 Codex 常驻采集（配置 [codex]）
  ua-probe codex-sync         Codex 历史回填 + 当前额度单次同步
  ua-probe codex-status       Codex 本地队列状态
  ua-probe update [选项]      升级探针并重启引用它的服务

update 选项
  --check                 只检查有没有新版，不替换、不重启
  --from <url>            新版来源；单文件默认 <server.url>/dl/ua-probe.mjs，npm 安装默认 GitHub Release
  --no-restart            替换后不重启服务

install 选项
  --server <url>          服务端地址（必填）
  --enroll-token <t>      一次性 enroll token，换取 machine_token
  --machine-token <t>     直接给长期 token（与 --enroll-token 二选一）
  --profile <id>          default_profile_id，默认 claude-official
  --scan-root <path>      可重复；默认 ~/.claude/projects
  --quota                 本机代抓额度（旧路径；默认由服务端直接抓，只在服务端关了采集时用）
  --no-service            只写配置，不装 launchd/systemd
  --force                 覆盖已存在的配置

通用
  --config <path>         配置路径，默认 ${DEFAULT_CONFIG_PATH}
  --json                  status 输出 JSON
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "";
  const rest = argv.slice(1);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "enroll-token": { type: "string" },
      "machine-token": { type: "string" },
      profile: { type: "string" },
      "scan-root": { type: "string", multiple: true },
      quota: { type: "boolean", default: false },
      "no-service": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      from: { type: "string" },
      "no-restart": { type: "boolean", default: false },
    },
  });
  const configPath = values.config ? expandHome(values.config) : DEFAULT_CONFIG_PATH;

  switch (cmd) {
    case "install":
      return await cmdInstall(values, configPath);
    case "run":
      return await cmdRun(configPath);
    case "backfill":
      return await cmdBackfill(configPath);
    case "status":
      return cmdStatus(configPath, values.json === true);
    case "codex-run":
    case "codex-sync":
    case "codex-status":
      return await cmdCodex(configPath, cmd);
    case "update":
      return await cmdUpdate(values, configPath);
    default:
      process.stderr.write(`未知子命令：${cmd}\n\n${USAGE}`);
      return 2;
  }
}

async function cmdUpdate(
  v: { check?: boolean | undefined; from?: string | undefined; "no-restart"?: boolean | undefined },
  configPath: string,
): Promise<number> {
  const cli = defaultCliPath();
  const real = realPath(cli);
  const kind = detectInstall(real);
  // 服务里记的可能是 npm 的 bin 链接，也可能是真实文件，两个都认
  const services = findServices([cli, real]);
  const restartHint = (): void => {
    for (const s of services) process.stdout.write(`  ${restartCommand(s).join(" ")}\n`);
  };

  if (kind === "source") {
    process.stdout.write(`正在跑仓库源码（${real}），版本由工作区决定：先 git pull（或从开发机同步）再重启服务。\n`);
    if (services.length) restartHint();
    return 0;
  }

  if (kind === "npm") {
    const spec = v.from ?? RELEASE_TGZ_URL;
    if (v.check) {
      process.stdout.write(`npm 全局安装（${real}）无法预先比对版本；升级会执行：npm i -g ${spec}\n`);
      return 0;
    }
    process.stdout.write(`npm i -g ${spec}\n`);
    await npmInstallGlobal(spec);
  } else {
    let url = v.from;
    if (!url) {
      if (!existsSync(configPath)) {
        process.stderr.write(`找不到配置 ${configPath}，无法确定服务端地址；用 --config 指定或用 --from <url>\n`);
        return 2;
      }
      url = `${loadConfig(configPath).server.url.replace(/\/+$/, "")}/dl/ua-probe.mjs`;
    }
    const r = await updateBundle(real, url, { check: v.check === true });
    const short = (sha: string): string => sha.slice(0, 12);
    if (r.status === "up_to_date") {
      process.stdout.write(`已是最新（${short(r.localSha)}）：${real}\n`);
      return 0;
    }
    if (r.status === "available") {
      process.stdout.write(`有新版：${short(r.localSha)} → ${short(r.remoteSha)}（来源 ${url}）\n`);
      return 0;
    }
    process.stdout.write(`已替换 ${real}：${short(r.localSha)} → ${short(r.remoteSha)}\n`);
  }

  if (services.length === 0) {
    process.stdout.write("没有找到引用这个探针的 launchd/systemd 服务；手动跑的进程需要自己重启。\n");
    return 0;
  }
  if (v["no-restart"]) {
    process.stdout.write("未重启（--no-restart），稍后执行：\n");
    restartHint();
    return 0;
  }
  let failed = 0;
  for (const { service, error } of await restartServices(services)) {
    if (error) { failed++; process.stderr.write(`重启 ${service.name} 失败：${error}\n`); }
    else process.stdout.write(`已重启 ${service.name}\n`);
  }
  return failed ? 1 : 0;
}

async function cmdCodex(configPath: string, cmd: string): Promise<number> {
  const cfg = loadConfig(configPath);
  if (cmd === "codex-status") {
    // Read-only: must work while the service holds the collector lock (WAL allows a reader).
    const { CodexProbeStore } = await import("./codex-store.js");
    const store = new CodexProbeStore(expandHome(cfg.codex.state_db));
    try { process.stdout.write(JSON.stringify(store.stats()) + "\n"); } finally { store.close(); }
    return 0;
  }
  const { CodexProbe } = await import("./codex-probe.js");
  const locked = tryAcquire(lockPathFor(expandHome(cfg.codex.state_db)));
  if (!locked.ok) {
    process.stderr.write("Codex 采集器已运行；请通过其服务管理器停止后再手工同步。\n");
    return 69;
  }
  let probe: InstanceType<typeof CodexProbe> | null = null;
  const shutdown = (): void => { void probe?.stop(); };
  try {
    probe = new CodexProbe(cfg);
    if (cmd === "codex-sync") {
      await probe.sync();
    } else {
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await probe.run();
    }
    return 0;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await probe?.stop();
    probe?.close();
    locked.release();
  }
}

async function cmdInstall(
  v: {
    server?: string | undefined;
    "enroll-token"?: string | undefined;
    "machine-token"?: string | undefined;
    profile?: string | undefined;
    "scan-root"?: string[] | undefined;
    quota?: boolean | undefined;
    "no-service"?: boolean | undefined;
    force?: boolean | undefined;
  },
  configPath: string,
): Promise<number> {
  const configExists = existsSync(configPath);
  if (configExists && !v.force) {
    process.stdout.write(`配置已存在，保留不动：${configPath}（要重写加 --force）\n`);
  } else {
    if (!v.server) {
      process.stderr.write("install 需要 --server <url>\n");
      return 2;
    }
    let machineId: string = randomUUID();
    let machineToken = v["machine-token"] ?? "";
    if (v["enroll-token"]) {
      try {
        const enrolled = await Shipper.enroll(v.server, v["enroll-token"], hostname(), `${platform()} ${release()}`);
        machineId = enrolled.machineId;
        machineToken = enrolled.machineToken;
        process.stdout.write(`enroll 成功，machine_id = ${machineId}\n`);
      } catch (err) {
        process.stderr.write(`enroll 失败：${(err as Error).message}\n换个办法：先拿到 machine_token，用 --machine-token 传入\n`);
        return 1;
      }
    }
    const toml = renderConfigToml({
      machineId,
      serverUrl: v.server,
      machineToken,
      defaultProfileId: v.profile ?? "claude-official",
      scanRoots: (v["scan-root"] ?? [join(expandHome("~"), ".claude", "projects")]).map(expandHome),
      quotaEnabled: v.quota === true,
    });
    mkdirSync(dirname(configPath), { recursive: true });
    // 0600：里面有 machine_token
    writeFileSync(configPath, toml, { mode: 0o600 });
    process.stdout.write(`已写入 ${configPath}（权限 600，含 machine_token）\nmachine_id = ${machineId}\n`);
    if (!machineToken) {
      process.stdout.write("⚠️  machine_token 为空，上报会被拒；补上 [server].machine_token 再启动\n");
    }
  }

  if (v["no-service"]) {
    process.stdout.write("跳过服务安装（--no-service）\n");
    return 0;
  }
  // 服务单元会记下这个路径；npx 缓存一清，服务就指向一个不存在的文件
  if (/[\\/]_npx[\\/]/.test(defaultCliPath())) {
    process.stderr.write("⚠️  正在从 npx 缓存运行，缓存清理后常驻服务会起不来。建议改用：npm i -g @zack-will/ua-probe\n");
  }
  const res = await installService(configPath);
  process.stdout.write(`${res.platform}: 已写入 ${res.unitPath}${res.loaded ? "（已加载）" : "（未加载）"}\n`);
  for (const n of res.notes) process.stdout.write(`  · ${n}\n`);
  if (v.quota) {
    process.stdout.write("\n额度采集已开启。凭证只存本机、绝不上报，按提示自行放入：\n");
    process.stdout.write(
      process.platform === "darwin"
        ? "  security add-generic-password -U -s ua-probe -a claude-session-key -w\n"
        : "  install -m 600 /dev/null ~/.config/ua-probe/claude-session-key && cat > ~/.config/ua-probe/claude-session-key\n",
    );
  }
  return 0;
}

async function cmdRun(configPath: string): Promise<number> {
  const cfg = loadConfig(configPath);
  const log = createLogger(cfg.log_level);

  // ★ 先拿单实例锁，再碰状态库。两个探针同时写 state.db 会让后来者直接崩溃
  //   （node:sqlite 把 SQLITE_BUSY 抛成未捕获异常），见 lock.ts 的注释。
  const lockPath = lockPathFor(cfg.state_db);
  let lock;
  try {
    lock = await acquireForRun(lockPath);
  } catch (err) {
    if (err instanceof LockBusyError) {
      log.error({ holderPid: err.holderPid }, "状态库被另一个探针占着且不肯退出，本次不启动");
      return 69; // EX_UNAVAILABLE
    }
    throw err;
  }
  if (lock.tookOverFrom !== null) {
    log.warn({ previousPid: lock.tookOverFrom }, "接管了上一个探针实例（多半是菜单栏重启后遗留的孤儿）");
  }

  const probe = new Probe(cfg, { logger: log });
  await probe.start();

  let stopping = false;
  const shutdown = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, "收到信号，退出中（队列已持久化，不会丢）");
    void probe.stop().then(() => {
      lock.release();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // 常驻：定时器都 unref 了，用一个空 interval 把进程挂住
  const keepalive = setInterval(() => undefined, 1 << 30);
  await new Promise<void>((resolve) => process.on("exit", () => resolve()));
  clearInterval(keepalive);
  return 0;
}

async function cmdBackfill(configPath: string): Promise<number> {
  const cfg = loadConfig(configPath);
  const log = createLogger(cfg.log_level);

  // backfill 不接管：它是一次性任务，为它抢掉常驻探针不值得。直接说清楚谁占着。
  const lock = tryAcquire(lockPathFor(cfg.state_db));
  if (!lock.ok) {
    log.error({ holderPid: lock.holderPid }, "探针正在运行，先停掉它再 backfill");
    return 69; // EX_UNAVAILABLE
  }

  const probe = new Probe(cfg, { logger: log });
  try {
    await probe.runBackfill();
  } finally {
    await probe.stop();
    lock.release();
  }
  return 0;
}

function cmdStatus(configPath: string, asJson: boolean): number {
  const cfg = loadConfig(configPath);
  const log = createLogger("silent");
  const probe = new Probe(cfg, { logger: log });
  const snap = probe.snapshot();
  void probe.stop();
  if (asJson) {
    process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
    return 0;
  }
  for (const [k, val] of Object.entries(snap)) {
    process.stdout.write(`${k.padEnd(20)} ${typeof val === "object" ? JSON.stringify(val) : String(val)}\n`);
  }
  return 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  });
