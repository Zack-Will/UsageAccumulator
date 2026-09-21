/** 对本机真实会话数据跑一遍解析，验证 M1 口径。不依赖网络，不上报任何内容。 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLine, projectSlugFromPath } from "../src/jsonl.js";
import { dedupKey } from "../src/dedup.js";

const ROOT = join(homedir(), ".claude", "projects");

const stats = {
  files: 0, lines: 0, events: 0, bytes: 0,
  input: 0, output: 0, thinking: 0, cacheRead: 0, w5: 0, w1: 0,
  warn: {} as Record<string, number>,
  models: {} as Record<string, number>,
  entrypoints: {} as Record<string, number>,
};
const seen = new Map<string, Set<string>>();   // dedupKey -> project slugs
const dupAcrossProjects = new Set<string>();

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const files = await walk(ROOT);
for (const f of files) {
  stats.files++;
  stats.bytes += (await stat(f)).size;
  const slug = projectSlugFromPath(f) ?? "?";
  const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
  for await (const line of rl) {
    stats.lines++;
    const { event, warnings } = parseLine(line, {
      machineId: "validate", profileId: "unknown", attributionLevel: "unknown", projectSlug: slug,
    });
    for (const w of warnings) stats.warn[w.kind] = (stats.warn[w.kind] ?? 0) + 1;
    if (!event) continue;
    stats.events++;
    stats.input += event.inputTokens; stats.output += event.outputTokens;
    stats.thinking += event.thinkingTokens; stats.cacheRead += event.cacheReadTokens;
    stats.w5 += event.cacheWrite5mTokens; stats.w1 += event.cacheWrite1hTokens;
    stats.models[event.model] = (stats.models[event.model] ?? 0) + 1;
    if (event.entrypoint) stats.entrypoints[event.entrypoint] = (stats.entrypoints[event.entrypoint] ?? 0) + 1;
    const k = dedupKey(event);
    let s = seen.get(k);
    if (!s) { s = new Set(); seen.set(k, s); }
    s.add(slug);
    if (s.size > 1) dupAcrossProjects.add(k);
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");
console.log(`文件 ${stats.files} · ${(stats.bytes / 1024 / 1024).toFixed(0)} MB · 行 ${fmt(stats.lines)}`);
console.log(`用量事件 ${fmt(stats.events)} · 去重后 ${fmt(seen.size)} · 重复 ${fmt(stats.events - seen.size)}`);
console.log(`  其中跨项目目录重复（ssh 双写嫌疑）: ${fmt(dupAcrossProjects.size)}`);
console.log(`token  input=${fmt(stats.input)} output=${fmt(stats.output)} thinking=${fmt(stats.thinking)}`);
console.log(`       cacheRead=${fmt(stats.cacheRead)} write5m=${fmt(stats.w5)} write1h=${fmt(stats.w1)}`);
const wsum = stats.w5 + stats.w1;
console.log(`缓存写入 1h 占比 ${wsum ? ((stats.w1 / wsum) * 100).toFixed(1) : "0"}%  ← 若按单列计价，这部分会系统性算错`);
console.log(`告警`, Object.keys(stats.warn).length ? stats.warn : "无");
console.log(`模型`, Object.entries(stats.models).sort((a, b) => b[1] - a[1]).slice(0, 6));
console.log(`入口`, stats.entrypoints);
