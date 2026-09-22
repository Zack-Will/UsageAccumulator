/**
 * 把探针打成单文件，放进看板的静态目录一起发布。
 *
 * 为什么需要：目标机器（公司 Mac）不装 pnpm、不装 gh、也不该去 clone 私有仓。
 * 打包产物只依赖 node，一条 curl 就能拿到。
 *
 * fsevents 是可选原生模块，打包不进去；chokidar 缺了它会退回 fs.watch，
 * 配置里本来就有 watch.poll_interval_ms 兜底，功能不受影响。
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const outDir = join(repo, "apps/web/public/dl");
const outFile = join(outDir, "ua-probe.mjs");

mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [join(here, "../src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["fsevents"],
  // 打包后仍有依赖走 require()（node:sqlite 等），补一个
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  outfile: outFile,
});

const buf = readFileSync(outFile);
const sha = createHash("sha256").update(buf).digest("hex");
writeFileSync(join(outDir, "ua-probe.mjs.sha256"), `${sha}  ua-probe.mjs\n`);
console.log(`✓ ${outFile}`);
console.log(`  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  sha256 ${sha}`);
