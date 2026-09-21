// 把渲染层静态资源和共用设计令牌搬进 dist/renderer。
// theme.css 从 @ua/tokens 取，菜单栏不另起一套颜色。
import { createRequire } from "node:module";
import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const appDir = resolve(here, "..");
const outDir = join(appDir, "dist", "renderer");

mkdirSync(outDir, { recursive: true });
cpSync(join(appDir, "src", "renderer"), outDir, { recursive: true });

const require = createRequire(import.meta.url);
let themeCss;
try {
  themeCss = require.resolve("@ua/tokens/theme.css");
} catch {
  themeCss = resolve(appDir, "..", "..", "packages", "ua-tokens", "src", "theme.css");
}
cpSync(themeCss, join(outDir, "theme.css"));

console.log(`[ua-menubar] renderer assets -> ${outDir}`);
