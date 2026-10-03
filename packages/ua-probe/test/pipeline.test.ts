import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { parseConfig, ConfigError } from "../src/config.js";
import { Attributor } from "../src/attributor.js";
import { Ingestor, emptyStats } from "../src/ingest.js";
import { ProbeStore } from "../src/store.js";
import { backoffMs, buildNdjsonBody, classifyStatus, isServerErrorEnvelope } from "../src/shipper.js";
import { hashProjectSlug, toWireEvent } from "../src/wire.js";
import { launchdPlist, resolveLauncher, systemdUnit } from "../src/install.js";
import { assistantLine, cleanup, makeConfig, silentLog, tmpDir } from "./helpers.js";
import type { UsageEvent } from "@ua/core";

describe("config", () => {
  it("scan_roots 是可配置的数组，支持套壳客户端的非标准路径（§14）", () => {
    const cfg = parseConfig(`
scan_roots = ["~/.claude/projects", "/opt/codewiz-cc/sessions"]
[server]
url = "https://ua.example.com"
`);
    expect(cfg.scan_roots).toHaveLength(2);
    expect(cfg.resolvedScanRoots[0]).toMatch(/\/\.claude\/projects$/);
    expect(cfg.resolvedScanRoots[0]).not.toContain("~");
    expect(cfg.resolvedScanRoots[1]).toBe("/opt/codewiz-cc/sessions");
  });

  it("缺 server.url 直接报错，不给默认值", () => {
    expect(() => parseConfig("machine_id = \"x\"\n")).toThrow(ConfigError);
  });

  it("hash_project_paths 开启但没给 secret → 报错", () => {
    expect(() =>
      parseConfig(`
hash_project_paths = true
[server]
url = "https://ua.example.com"
`),
    ).toThrow(/project_hash_secret/);
  });

  it("quota.enabled 但没给 profile_id → 报错", () => {
    expect(() =>
      parseConfig(`
[server]
url = "https://ua.example.com"
[quota]
enabled = true
`),
    ).toThrow(/quota.profile_id/);
  });

  it("默认值：60s 兜底轮询、100 万条队列上限、1000 条批量", () => {
    const cfg = parseConfig(`[server]\nurl = "https://ua.example.com"\n`);
    expect(cfg.watch.poll_interval_ms).toBe(60_000);
    expect(cfg.queue.max_rows).toBe(1_000_000);
    expect(cfg.backfill.batch_size).toBe(1000);
    expect(cfg.backfill.interval_ms).toBe(200);
    expect(cfg.server.retry_base_ms).toBe(1000);
    expect(cfg.server.retry_max_ms).toBe(300_000);
  });
});

describe("wire 格式（CONTRACT §1.1）", () => {
  const base: UsageEvent = {
    messageId: "msg_1",
    requestId: "req_1",
    semanticId: "sem123",
    machineId: "m1",
    appType: "claude",
    profileId: "claude-official",
    attributionLevel: "timeline",
    ts: new Date("2026-09-01T16:04:45.751Z"),
    model: "claude-opus-5",
    inputTokens: 2,
    outputTokens: 726,
    thinkingTokens: 295,
    cacheReadTokens: 38256,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 31626,
    sessionId: "sess",
    projectSlug: "-Users-me-Repos-Cleave",
    gitBranch: "HEAD",
    entrypoint: "claude-desktop",
    serviceTier: "standard",
    isSidechain: false,
    outputFinal: true,
    backfill: false,
  };

  it("字段名与契约一致，时间带 Z，5m/1h 分开", () => {
    const w = toWireEvent(base, { hashProjectPaths: false, projectHashSecret: "" });
    expect(w.ts).toBe("2026-09-01T16:04:45.751Z");
    expect(w.cache_write_5m_tokens).toBe(0);
    expect(w.cache_write_1h_tokens).toBe(31626);
    expect(w.attribution_level).toBe("timeline");
    expect(w.project_slug).toBe("-Users-me-Repos-Cleave");
  });

  it("message_id / request_id 缺失时用 semantic_id 兜底（§1.2）", () => {
    const w = toWireEvent({ ...base, requestId: "", messageId: "" }, { hashProjectPaths: false, projectHashSecret: "" });
    expect(w.request_id).toBe("sem123");
    expect(w.message_id).toBe("sem123");
    expect(w.semantic_id).toBe("sem123");
  });

  it("hash_project_paths 开启时 slug 被 HMAC 化，原路径不出现在线格式里", () => {
    const w = toWireEvent(base, { hashProjectPaths: true, projectHashSecret: "s3cret" });
    expect(w.project_slug).toBe(hashProjectSlug("-Users-me-Repos-Cleave", "s3cret"));
    expect(JSON.stringify(w)).not.toContain("Cleave");
  });

  it("只有用量元数据 —— 任何正文字段都不会被带出去", () => {
    const keys = Object.keys(toWireEvent(base, { hashProjectPaths: false, projectHashSecret: "" }));
    for (const forbidden of ["content", "message", "text", "tool_use", "input", "prompt", "toolUseResult"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("shipper", () => {
  it("2xx ok / 5xx & 429 & 401 重试 / 其余 4xx 丢弃（不堵队列头）", () => {
    expect(classifyStatus(200)).toBe("ok");
    expect(classifyStatus(204)).toBe("ok");
    expect(classifyStatus(500)).toBe("retry");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(401)).toBe("retry");
    expect(classifyStatus(400)).toBe("drop");
    expect(classifyStatus(422)).toBe("drop");
  });

  it("指数退避 1s 起，封顶 5min", () => {
    const noJitter = () => 0.5;
    expect(backoffMs(0, 1000, 300_000, noJitter)).toBe(1000);
    expect(backoffMs(1, 1000, 300_000, noJitter)).toBe(2000);
    expect(backoffMs(3, 1000, 300_000, noJitter)).toBe(8000);
    expect(backoffMs(30, 1000, 300_000, noJitter)).toBe(300_000);
    // 抖动在 ±20% 内
    for (let i = 0; i < 20; i++) {
      const v = backoffMs(2, 1000, 300_000);
      expect(v).toBeGreaterThanOrEqual(3200);
      expect(v).toBeLessThanOrEqual(4800);
    }
  });

  it("body 是 gzip 的 NDJSON，Idempotency-Key 由内容决定", () => {
    const lines = ['{"a":1}', '{"b":2}'];
    const { body, idempotencyKey } = buildNdjsonBody(lines);
    expect(gunzipSync(body).toString("utf8")).toBe('{"a":1}\n{"b":2}\n');
    expect(buildNdjsonBody(lines).idempotencyKey).toBe(idempotencyKey);
    expect(buildNdjsonBody(['{"a":2}']).idempotencyKey).not.toBe(idempotencyKey);
  });
});

describe("Ingestor 端到端（解析 → 归属 → 队列）", () => {
  let dir: string;
  let projects: string;
  let file: string;

  beforeEach(() => {
    dir = tmpDir();
    projects = join(dir, "projects", "-Users-me-Repos-Demo");
    mkdirSync(projects, { recursive: true });
    file = join(projects, "sess.jsonl");
  });
  afterEach(() => cleanup(dir));

  function build(hashPaths = false) {
    const cfg = makeConfig({ scanRoot: join(dir, "projects"), hashProjectPaths: hashPaths });
    const store = new ProbeStore(":memory:");
    const attr = new Attributor(cfg, store, silentLog);
    return { cfg, store, attr, ing: new Ingestor(cfg, store, attr, silentLog) };
  }

  it("子代理的一条消息多行：队列留最终行；已发走的中途值在最终行到来时重新入队", async () => {
    // 子代理转录：前几行是流式中途值（无 stop_reason / iterations），最后一行才是最终用量
    const partial = assistantLine({ isSidechain: true }, { output_tokens: 7 });
    const final = assistantLine({ isSidechain: true }, { output_tokens: 1500, iterations: [] });
    const { ing, store } = build();

    writeFileSync(file, [partial, partial, final].join("\n") + "\n");
    await ing.ingestFile(file, { backfill: false }, emptyStats());
    let rows = store.takeEvents(10);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ output_tokens: 1500, output_final: true });
    store.ackEvents(rows.map((r) => r.id));

    // 另一条消息：中途值先被读到并发走，最终行下一轮才写出来
    const p2 = assistantLine({ isSidechain: true, requestId: "req_2" }, { output_tokens: 5 });
    const f2 = assistantLine({ isSidechain: true, requestId: "req_2" }, { output_tokens: 900, iterations: [] });
    appendFileSync(file, p2 + "\n");
    await ing.ingestFile(file, { backfill: false }, emptyStats());
    rows = store.takeEvents(10);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ output_tokens: 5, output_final: false });
    store.ackEvents(rows.map((r) => r.id));

    appendFileSync(file, f2 + "\n");
    await ing.ingestFile(file, { backfill: false }, emptyStats());
    rows = store.takeEvents(10);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ output_tokens: 900, output_final: true });
  });

  it("解析 assistant 行入队，非 assistant 行忽略，project_slug 取目录名", async () => {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", timestamp: "2026-09-21T03:00:00Z", message: { content: "绝密 prompt 正文" } }),
        assistantLine(),
      ].join("\n") + "\n",
    );
    const { ing, store, attr } = build();
    const stats = emptyStats();
    await ing.ingestFile(file, { backfill: false }, stats);

    expect(stats.lines).toBe(2);
    expect(stats.events).toBe(1);
    expect(stats.enqueued).toBe(1);

    const row = store.takeEvents(1)[0]!;
    const doc = JSON.parse(row.payload) as Record<string, unknown>;
    expect(doc["project_slug"]).toBe("-Users-me-Repos-Demo");
    expect(doc["cache_write_1h_tokens"]).toBe(31626);
    expect(doc["machine_id"]).toBe("machine-test");
    // ★ 正文绝不出现在上报里
    expect(row.payload).not.toContain("绝密");
    attr.close();
    store.close();
  });

  it("增量：追加新行只入队新事件，重复内容被 dedup_key 吃掉", async () => {
    writeFileSync(file, assistantLine() + "\n");
    const { ing, store, attr } = build();
    const s1 = emptyStats();
    await ing.ingestFile(file, { backfill: false }, s1);
    expect(s1.enqueued).toBe(1);

    appendFileSync(file, assistantLine({ requestId: "req_2" }, {}) + "\n");
    const s2 = emptyStats();
    await ing.ingestFile(file, { backfill: false }, s2);
    expect(s2.lines).toBe(1);
    expect(s2.enqueued).toBe(1);
    expect(store.queueDepth()).toBe(2);

    // 同一条消息在 JSONL 里重复落盘（实测 64% 是重复）→ 本地就去掉
    appendFileSync(file, assistantLine({ requestId: "req_2" }, {}) + "\n");
    const s3 = emptyStats();
    await ing.ingestFile(file, { backfill: false }, s3);
    expect(s3.events).toBe(1);
    expect(s3.enqueued).toBe(0);
    expect(store.queueDepth()).toBe(2);
    attr.close();
    store.close();
  });

  it("backfill 模式给事件打 backfill: true，历史数据归属为 unknown", async () => {
    // 探针安装前的历史数据（时间戳远早于 installed_at）
    writeFileSync(file, assistantLine({ timestamp: "2025-03-01T10:00:00.000Z" }) + "\n");
    const { ing, store, attr } = build();
    const stats = emptyStats();
    await ing.ingestFile(file, { backfill: true }, stats);
    const doc = JSON.parse(store.takeEvents(1)[0]!.payload) as Record<string, unknown>;
    expect(doc["backfill"]).toBe(true);
    expect(doc["attribution_level"]).toBe("unknown");
    attr.close();
    store.close();
  });

  it("游标推进：第二次扫描同一文件不产生重复解析", async () => {
    writeFileSync(file, assistantLine() + "\n");
    const { ing, store, attr } = build();
    const s1 = emptyStats();
    await ing.ingestFile(file, { backfill: false }, s1);
    const s2 = emptyStats();
    await ing.ingestFile(file, { backfill: false }, s2);
    expect(s2.lines).toBe(0);
    expect(store.getCursor(file)?.offset).toBeGreaterThan(0);
    attr.close();
    store.close();
  });

  it("缓存拆分缺失时计告警，不静默按 1h 计价", async () => {
    writeFileSync(
      file,
      assistantLine({}, { cache_creation: undefined, cache_creation_input_tokens: 1000 }) + "\n",
    );
    const { ing, attr, store } = build();
    const stats = emptyStats();
    await ing.ingestFile(file, { backfill: false }, stats);
    expect(stats.warnings["missing-cache-breakdown"]).toBe(1);
    attr.close();
    store.close();
  });

  it("hash_project_paths 开启时队列里也看不到原始路径", async () => {
    writeFileSync(file, assistantLine() + "\n");
    const { ing, store, attr } = build(true);
    const stats = emptyStats();
    await ing.ingestFile(file, { backfill: false }, stats);
    const payload = store.takeEvents(1)[0]!.payload;
    expect(payload).not.toContain("-Users-me-Repos-Demo");
    expect(payload).toContain("h_");
    attr.close();
    store.close();
  });
});

describe("服务单元", () => {
  it("launchd plist 带 KeepAlive 与配置路径", () => {
    const p = launchdPlist({
      label: "com.ua.probe",
      launcher: { program: "/bin/tsx", args: ["/x/cli.ts", "run"] },
      configPath: "/home/u/.config/ua-probe/config.toml",
      logDir: "/tmp/logs",
    });
    expect(p).toContain("<string>com.ua.probe</string>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("/home/u/.config/ua-probe/config.toml");
  });

  it("systemd 是 user service（WantedBy=default.target，不需要 root）", () => {
    const u = systemdUnit({ launcher: { program: "/bin/tsx", args: ["/x/cli.ts", "run"] }, configPath: "/c.toml" });
    expect(u).toContain("WantedBy=default.target");
    expect(u).toContain("Restart=always");
    expect(u).toContain("ExecStart=/bin/tsx /x/cli.ts run --config /c.toml");
  });
});

describe("4xx 的裁决权归属", () => {
  it("服务端自己回的 4xx 才丢弃", () => {
    expect(classifyStatus(400, true)).toBe("drop");
    expect(classifyStatus(422, true)).toBe("drop");
    expect(classifyStatus(404, true)).toBe("drop");
  });

  it("中间链路回的 4xx 一律重试 —— frp 的 404 HTML 页曾导致整批丢失", () => {
    expect(classifyStatus(404, false)).toBe("retry");
    expect(classifyStatus(400, false)).toBe("retry");
  });

  it("只认服务端的错误信封", () => {
    expect(isServerErrorEnvelope('{"error":{"code":"not_found","message":"no such route"}}')).toBe(true);
    expect(isServerErrorEnvelope("<!DOCTYPE html><html><title>Not Found</title>")).toBe(false);
    expect(isServerErrorEnvelope('{"accepted":3}')).toBe(false);
    expect(isServerErrorEnvelope("")).toBe(false);
  });
});

describe("单文件打包产物的启动器", () => {
  it("入口是 .mjs 时用 node，不去找 tsx", () => {
    const l = resolveLauncher("/opt/ua/ua-probe.mjs");
    expect(l.program).toBe(process.execPath);
    expect(l.args).toEqual(["/opt/ua/ua-probe.mjs", "run"]);
  });

  it("入口是 .ts 时仍然允许走 tsx 查找", () => {
    // 这里只断言不会被上面的 JS 分支提前截胡；具体找不找得到 tsx 取决于目录
    const l = resolveLauncher("/nowhere/cli.ts");
    expect(l.args).toEqual(["/nowhere/cli.ts", "run"]);
  });
});
