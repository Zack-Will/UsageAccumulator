declare module "*.css";

interface ImportMetaEnv {
  /** 真实服务端基址，例如 https://ua.example.com。未设置时走同源。 */
  readonly VITE_UA_API_BASE?: string;
  /** "mock" | "live"。未设置时默认 mock（服务端尚未就绪）。 */
  readonly VITE_UA_DATA_SOURCE?: string;
  /**
   * 仅供**开发**便利的 Bearer token。
   * ★ 生产构建绝不能设置它：Vite 会把值原样内联进公开的 JS 产物，
   *   任何能打开页面的人都能读出来。生产下 token 由使用者在浏览器本地输入，
   *   见 `api/index.ts` 的 readToken()。
   */
  readonly VITE_UA_TOKEN?: string;
  /** Vite 内置：生产构建为 true。 */
  readonly PROD: boolean;
  /** Vite 内置：dev server 下为 true。 */
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
