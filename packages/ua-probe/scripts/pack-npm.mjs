/**
 * 组装发布到 npm 的 @zack-will/ua-probe。
 *
 * 发的是 bundle.mjs 打出的单文件，不是工作区里的 @ua/probe：后者依赖 workspace 里的
 * @ua/core 源码、bin 指向 .ts，装到别人机器上跑不起来。单文件只依赖 node。
 *
 *   node scripts/pack-npm.mjs <version>     → packages/ua-probe/dist/npm/
 *   cd dist/npm && npm publish --access public
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const outDir = join(pkgDir, "dist", "npm");

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`用法：node scripts/pack-npm.mjs <x.y.z>（收到 "${process.argv[2] ?? ""}"）`);
  process.exit(2);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
execFileSync(process.execPath, [join(here, "bundle.mjs"), "--out", outDir], { stdio: "inherit" });
rmSync(join(outDir, "ua-probe.mjs.sha256"));
chmodSync(join(outDir, "ua-probe.mjs"), 0o755);
copyFileSync(join(pkgDir, "npm-README.md"), join(outDir, "README.md"));

const manifest = {
  name: "@zack-will/ua-probe",
  version,
  description: "UsageAccumulator 探针：把本机 Claude Code 用量上报到自建的 UsageAccumulator 服务端",
  type: "module",
  bin: { "ua-probe": "ua-probe.mjs" },
  files: ["ua-probe.mjs", "README.md"],
  // node:sqlite 从 22.13 起不再需要实验开关
  engines: { node: ">=22.13" },
  os: ["darwin", "linux"],
  keywords: ["claude", "claude-code", "usage", "quota"],
  repository: { type: "git", url: "git+https://github.com/Zack-Will/UsageAccumulator.git", directory: "packages/ua-probe" },
  homepage: "https://github.com/Zack-Will/UsageAccumulator#readme",
  bugs: "https://github.com/Zack-Will/UsageAccumulator/issues",
  publishConfig: { access: "public" },
};
writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ ${outDir}（${manifest.name}@${version}）`);
