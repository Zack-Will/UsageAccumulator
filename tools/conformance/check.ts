/**
 * 跨包契约一致性检查。
 *
 * 服务端与看板是并行开发的，双方从未见过对方的代码，只共同参照 docs/CONTRACT.md。
 * 这个脚本把服务端**真实返回的 JSON**，用看板**真实使用的 TypeScript 类型**去接：
 *   - 类型对不上 → tsc 编译报错
 *   - 值域/语义违约 → 运行时断言失败
 * 不需要 Postgres（用服务端自己的 MemoryStore），不联网。
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseLine } from "../../packages/ua-core/src/index.js";
import type { UsageEvent } from "../../packages/ua-core/src/index.js";
import { gzipSync } from "node:zlib";
import { buildApp } from "../../packages/ua-server/src/app.js";
import { MemoryStore } from "../../packages/ua-server/src/store-memory.js";
import { loadPricingTable } from "../../packages/ua-server/src/pricing.js";
import { testConfig, toWire } from "../../packages/ua-server/test/helpers.js";

import type {
  Calibration, Distribution, MachinesResponse, ProfilesResponse, Timeline, WindowsCurrent,
} from "../../apps/web/src/api/types.js";

const PROFILE = "claude-official";
const MACHINE = "9f2c1a7e-0000-4000-8000-000000000001";

// ── 用本机真实会话数据播种（只读，不上报任何内容）
const ROOT = join(homedir(), ".claude", "projects");
async function walk(d: string): Promise<string[]> {
  const o: string[] = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) o.push(...(await walk(p)));
    else if (e.name.endsWith(".jsonl")) o.push(p);
  }
  return o;
}
const files = (await walk(ROOT)).slice(-12);
const events: UsageEvent[] = [];
for (const f of files) {
  const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
  for await (const l of rl) {
    const { event } = parseLine(l, {
      machineId: MACHINE, profileId: PROFILE, attributionLevel: "timeline",
      projectSlug: f.split("/").at(-2) ?? null,
    });
    if (event) events.push(event);
  }
}
if (events.length === 0) throw new Error("没有解析到任何事件，无法验证");

const fails: string[] = [];
const ok = (cond: unknown, msg: string) => { if (!cond) fails.push(msg); };

const store = new MemoryStore();
const { table: pricing } = loadPricingTable("deploy/pricing.json");
const app = buildApp({ store, config: testConfig(), pricing });
await app.fastify.ready();
const DASH = { authorization: "Bearer dash-token" };

// ── 完整链路：enroll → 上报（gzip NDJSON，探针的线格式）→ 额度快照
const enrolled = await app.fastify.inject({
  method: "POST", url: "/v1/enroll",
  payload: { enroll_token: "enroll-token", hostname: "mbp-local", os: "darwin",
             provisional_machine_id: MACHINE },
});
if (enrolled.statusCode !== 200) throw new Error(`enroll → ${enrolled.statusCode} ${enrolled.body}`);
const { machine_id: realMachineId, machine_token: machineToken } =
  enrolled.json() as { machine_id: string; machine_token: string };
ok(realMachineId !== MACHINE, "服务端必须下发自己的 machine_id，不得采纳 provisional（否则可冒充已有机器）");

const ndjson = events.map((e) => JSON.stringify(toWire({ ...e, machineId: realMachineId }))).join("\n");
const ing = await app.fastify.inject({
  method: "POST", url: "/v1/ingest/events",
  headers: { authorization: `Bearer ${machineToken}`,
             "content-type": "application/x-ndjson", "content-encoding": "gzip" },
  payload: gzipSync(Buffer.from(ndjson, "utf8")),
});
if (ing.statusCode !== 200) throw new Error(`ingest → ${ing.statusCode} ${ing.body.slice(0, 300)}`);
const ingRes = ing.json() as { accepted: number; deduped: number; invalid: number };
ok(ingRes.invalid === 0, `上报出现 ${ingRes.invalid} 条无效行 —— 探针线格式与服务端不一致`);

const nowIso = new Date().toISOString();
const q = await app.fastify.inject({
  method: "POST", url: "/v1/ingest/quota",
  headers: { authorization: `Bearer ${machineToken}` },
  payload: { profile_id: PROFILE, machine_id: realMachineId, captured_at: nowIso,
    windows: [
      { window_kind: "five_hour", utilization_pct: 62, resets_at: new Date(Date.now() + 2 * 3600e3).toISOString() },
      { window_kind: "seven_day", utilization_pct: 41, resets_at: new Date(Date.now() + 3 * 86400e3).toISOString() },
    ], raw: { note: "conformance fixture" } },
});
if (q.statusCode !== 200) throw new Error(`quota → ${q.statusCode} ${q.body.slice(0, 200)}`);

async function get<T>(url: string): Promise<T> {
  const r = await app.fastify.inject({ method: "GET", url, headers: DASH });
  if (r.statusCode !== 200) throw new Error(`${url} → ${r.statusCode} ${r.body.slice(0, 200)}`);
  return r.json() as T;
}

// ★ 关键：每个响应都用看板的类型接住。类型不匹配在 tsc 阶段就会报错。
const profiles: ProfilesResponse = await get("/v1/profiles");
const machines: MachinesResponse = await get("/v1/machines");
const windows: WindowsCurrent = await get(`/v1/windows/current?profile_id=${PROFILE}`);
const timeline: Timeline = await get(`/v1/timeline?profile_id=${PROFILE}`);
const distMachine: Distribution = await get(`/v1/distribution?profile_id=${PROFILE}&by=machine&bucket=hour`);
const distHour: Distribution = await get(`/v1/distribution?profile_id=${PROFILE}&by=hour`);
const distAttr: Distribution = await get(`/v1/distribution?profile_id=${PROFILE}&by=attribution`);
const calib: Calibration = await get(`/v1/calibration?profile_id=${PROFILE}`);

// ── 语义断言：类型挡不住的那些约定
ok(Array.isArray(profiles.profiles), "profiles 必须包在 {profiles:[...]} 里");
ok(Array.isArray(machines.machines), "machines 必须包在 {machines:[...]} 里");

for (const w of windows.windows) {
  ok(w.utilization_pct >= 0 && w.utilization_pct <= 100, `utilization_pct 越界: ${w.utilization_pct}`);
  ok(w.metrics == null || (w.metrics.multi_machine_overlap_pct >= 0 && w.metrics.multi_machine_overlap_pct <= 100),
     "multi_machine_overlap_pct 必须是 0..100（不是 0..1）");
  ok(w.metrics == null || (w.metrics.session_cut_rate_pct >= 0 && w.metrics.session_cut_rate_pct <= 100),
     "session_cut_rate_pct 必须是 0..100（不是 0..1）");
  for (const p of w.burn_curve) ok(p.source === "official", `burn_curve 点必须标 source=official，实为 ${p.source}`);
  if (w.projected_curve && w.projected_curve.length > 0) {
    const last = w.projected_curve.at(-1)!;
    ok(Math.abs(last.mid - w.projected_pct.mid) < 0.51,
       `projected_curve 终点(${last.mid}) 必须等于 projected_pct.mid(${w.projected_pct.mid})，否则曲线与数字打架`);
  }
}

ok(timeline.metrics.multi_machine_overlap_pct <= 100, "timeline.metrics 也必须是 _pct / 0..100 口径");
ok("machine_label" in (timeline.lanes[0] ?? { machine_label: "" }), "timeline lane 必须带 machine_label");

const laneIds = new Set(timeline.lanes.map((l) => l.machine_id));
for (const b of distMachine.buckets) {
  ok(laneIds.size === 0 || laneIds.has(b.key),
     `by=machine 的 bucket.key 必须是 machine_id（与 timeline lane 同源），实为 ${b.key}`);
  ok(b.series !== undefined, "bucket=hour 时必须带 series[]");
}
for (const b of distHour.buckets) {
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00/.test(b.key),
     `by=hour 的 key 必须是小时起点 RFC3339，不是 0..23 序号，实为 ${b.key}`);
}
const levels = new Set(["proxy", "timeline", "fallback", "unknown"]);
for (const b of distAttr.buckets) ok(levels.has(b.key), `by=attribution 的 key 非法: ${b.key}`);
for (const b of [...distMachine.buckets, ...distHour.buckets]) {
  ok(b.cost_usd === null || typeof b.cost_usd === "number", "cost_usd 必须是 number 或 null，不得是 0 冒充未知");
}
ok(Array.isArray(calib.calibrations), "calibration 必须包在 {calibrations:[...]} 里");

// ── 错误契约
const bad = await app.fastify.inject({ method: "GET", url: "/v1/distribution?by=nonsense", headers: DASH });
ok(bad.statusCode === 400, `非法 by 应返回 400（否则客户端会当 5xx 永远重试），实为 ${bad.statusCode}`);
ok((bad.json() as { error?: { code?: string } }).error?.code === "bad_request", "非法参数的 error.code 应为 bad_request");
const noAuth = await app.fastify.inject({ method: "GET", url: "/v1/profiles" });
ok(noAuth.statusCode === 401, `缺鉴权应返回 401，实为 ${noAuth.statusCode}`);
const health = await app.fastify.inject({ method: "GET", url: "/healthz" });
ok(health.statusCode === 200, "/healthz 必须免鉴权");

await app.fastify.close();

console.log(`真实事件 ${events.length} 条（最近 ${files.length} 个会话文件）→ enroll → gzip NDJSON 上报`);
console.log(`  接收 ${ingRes.accepted} · 去重 ${ingRes.deduped} · 无效 ${ingRes.invalid}`);
console.log(`读端点 8 个全部 200，响应已用看板的 TypeScript 类型接住`);
if (fails.length === 0) {
  console.log("\n✓ 跨包契约一致性检查通过");
} else {
  console.log(`\n✗ ${fails.length} 处不一致:`);
  for (const f of fails) console.log("  -", f);
  process.exitCode = 1;
}
