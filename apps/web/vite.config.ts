import type { UserConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// root 显式指向本目录，这样 `vite build --config apps/web/vite.config.ts`
// 可以从仓库根目录执行。
const here = fileURLToPath(new URL(".", import.meta.url));

export default ({ mode }: { mode: string }): UserConfig => {
  // 第三个参数为 "" 表示连非 VITE_ 前缀的变量一起读——这些只在本配置里用，
  // 不会被打进产物。
  const env = loadEnv(mode, here, "");
  const target = env["UA_DEV_API_BASE"] ?? "";
  const token = env["UA_DEV_TOKEN"] ?? "";

  // 开发期把 /v1 代理到真实服务端，并在**代理这一层**注入 Authorization。
  //
  // 这样做有三个好处，每一个都是实际踩出来的：
  //   1. 浏览器与页面同源，跨源 CORS 预检整个消失
  //   2. SSE 能用：EventSource 无法自定义请求头，跨源时 token 只能塞进 query string，
  //      而 query 里的 token 会进访问日志。走代理就不必这么干。
  //   3. token 根本不进浏览器，也不会被打进前端产物
  //
  // 生产部署本来就是同源的（服务端用 ServeDir 托管前端产物，ARCHITECTURE §3），
  // 所以这个代理只是让开发环境与生产保持一致，不是额外的特殊处理。
  const proxy = target
    ? {
        "/v1": {
          target,
          changeOrigin: true,
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        },
      }
    : undefined;

  return {
    root: here,
    base: "./",
    plugins: [react()],
    build: {
      outDir: fileURLToPath(new URL("./dist", import.meta.url)),
      emptyOutDir: true,
      chunkSizeWarningLimit: 1200,
    },
    server: { port: 5183, ...(proxy ? { proxy } : {}) },
  };
};
