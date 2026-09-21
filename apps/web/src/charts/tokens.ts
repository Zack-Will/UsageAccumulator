/**
 * CSS 变量 → 具体色值。
 *
 * Canvas 的 fillStyle 不认 `var(--cat1)`，所以图表颜色必须在运行时解析。
 * 唯一的色值来源仍然是 packages/ua-tokens 的 theme.css，这里只做读取，不新增颜色。
 */
import { CATEGORICAL, STATUS, THEME_CLASS, type ThemeName } from "@ua/tokens";

const NAMES = [
  "bg",
  "surface",
  "border",
  "border-soft",
  "ring-track",
  "track",
  "text",
  "text-2",
  "text-3",
  "text-4",
  "seg-active",
  "cut",
  "ok",
  "warn",
  "danger",
  "info",
  "ok-bg",
  "warn-bg",
  "warn-border",
  "danger-bg",
  "danger-border",
  "accent",
  "accent-active",
  "cat1",
  "cat2",
  "cat3",
  "cat4",
  "empty",
  "font-sans",
  "font-mono",
] as const;

export type TokenName = (typeof NAMES)[number];
export type Tokens = Record<TokenName, string>;

function readFrom(el: Element): Tokens {
  const cs = getComputedStyle(el);
  const out = {} as Tokens;
  for (const n of NAMES) out[n] = cs.getPropertyValue(`--${n}`).trim();
  return out;
}

export function readTokens(): Tokens {
  return readFrom(document.documentElement);
}

let lightProbe: HTMLElement | null = null;
let lightCache: Tokens | null = null;

/**
 * 读日间主题的令牌值。
 * 用途：treemap 这类「饱和底 + 深色文字」的图形要在两套主题下保持一致，
 * 文字色必须固定取日间的 `--text`，而不是跟随当前主题。
 */
export function readLightTokens(): Tokens {
  if (lightCache) return lightCache;
  if (!lightProbe) {
    lightProbe = document.createElement("div");
    lightProbe.className = THEME_CLASS.light;
    lightProbe.setAttribute("aria-hidden", "true");
    lightProbe.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
    document.body.appendChild(lightProbe);
  }
  lightCache = readFrom(lightProbe);
  return lightCache;
}

/** 把 "var(--cat1)" 之类的表达式解析成具体色值。 */
export function resolveVar(expr: string, t: Tokens): string {
  const m = /^var\(\s*--([a-z0-9-]+)\s*\)$/i.exec(expr.trim());
  if (!m) return expr;
  const key = m[1] as TokenName | undefined;
  return key && key in t ? t[key] : expr;
}

// ── 颜色工具 ───────────────────────────────────────────────────────────────
function parseColor(c: string): [number, number, number, number] {
  const s = c.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((h) => h + h)
            .join("")
        : hex;
    const n = Number.parseInt(full.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /rgba?\(([^)]+)\)/i.exec(s);
  if (m?.[1]) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
  }
  return [0, 0, 0, 1];
}

export function alpha(color: string, a: number): string {
  const [r, g, b] = parseColor(color);
  return `rgba(${r},${g},${b},${a})`;
}

export function mix(a: string, b: string, ratio: number): string {
  const [r1, g1, b1] = parseColor(a);
  const [r2, g2, b2] = parseColor(b);
  const k = Math.max(0, Math.min(1, ratio));
  const c = (x: number, y: number) => Math.round(x + (y - x) * k);
  return `rgb(${c(r1, r2)},${c(g1, g2)},${c(b1, b2)})`;
}

// ── 分类色板 ───────────────────────────────────────────────────────────────
/**
 * 分类色板贯穿所有图表：同一个 key（机器 A / 模型 Opus）在任何一张图里都是同一个颜色。
 * 基色来自 @ua/tokens 的 CATEGORICAL；超过 4 项时按「向白混合」生成第二轮，
 * 保持饱和度，且仍然只依赖令牌里的 4 个基色。
 */
export function palette(t: Tokens, size = 4): string[] {
  const base = CATEGORICAL.map((v) => resolveVar(v, t));
  const out: string[] = [];
  for (let i = 0; i < size; i++) {
    const c = base[i % base.length] ?? t.cat1;
    const round = Math.floor(i / base.length);
    out.push(round === 0 ? c : mix(c, "#FFFFFF", 0.3 * round));
  }
  return out;
}

export function status(t: Tokens): Record<keyof typeof STATUS, string> {
  return {
    ok: resolveVar(STATUS.ok, t),
    warn: resolveVar(STATUS.warn, t),
    danger: resolveVar(STATUS.danger, t),
    info: resolveVar(STATUS.info, t),
  };
}

/** 顺序色板（热力图 / 强度色块）：空态 → 主强调色。 */
export function sequential(t: Tokens): string[] {
  return [t.empty, mix(t.accent, t.bg, 0.72), mix(t.accent, t.bg, 0.36), t.accent];
}

export type { ThemeName };
