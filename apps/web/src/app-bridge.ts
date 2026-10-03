/**
 * 安卓外壳（apps/android）与看板之间的约定。
 *
 * 外壳用 WebView 直接加载线上看板，所以网页照常部署、手机端自动同步；
 * 两边只靠这里的两件事对接，约定越窄，网页改动越碰不到外壳：
 *   · UA 后缀 `UsageAccumulatorApp/<版本>`
 *   · `window.UaApp`（见 apps/android/.../UaBridge.kt）
 */
export interface UaAppBridge {
  openSettings(): void;
  /** theme: "dark" | "light"；bg: #RRGGBB，外壳拿去给状态栏区域铺底 */
  setTheme(theme: string, bg: string): void;
  version(): string;
}

declare global {
  interface Window {
    UaApp?: UaAppBridge;
  }
}

const UA_MARK = /\bUsageAccumulatorApp\//;

/** 不在外壳里（普通浏览器）返回 null。两个条件都要满足：光有 UA 可能是被人伪造，光有对象不可能 */
export function appBridge(): UaAppBridge | null {
  const w = globalThis as { UaApp?: UaAppBridge; navigator?: { userAgent?: string } };
  const bridge = w.UaApp;
  if (!bridge || typeof bridge.openSettings !== "function") return null;
  return UA_MARK.test(w.navigator?.userAgent ?? "") ? bridge : null;
}

/** 主题切换后通知外壳，让状态栏图标深浅与页面一致 */
export function syncAppTheme(theme: "dark" | "light"): void {
  const bridge = appBridge();
  if (!bridge) return;
  const bg = globalThis.getComputedStyle?.(document.documentElement).getPropertyValue("--bg").trim() ?? "";
  try {
    bridge.setTheme(theme, /^#[0-9a-f]{6}$/i.test(bg) ? bg : "");
  } catch {
    /* 外壳版本不带这个方法时静默跳过 */
  }
}
