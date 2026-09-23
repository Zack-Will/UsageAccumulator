import type { EChartsOption } from "./echarts";
import type { Tokens } from "./tokens";
import { alpha } from "./tokens";

export const NUM_FONT = (t: Tokens): string => t["font-mono"] || "ui-monospace, monospace";
export const UI_FONT = (t: Tokens): string => t["font-sans"] || "system-ui, sans-serif";

/** 图表通用外观：字号、轴线、tooltip。文案克制 —— 不加 title，标题由卡片承担。 */
export function baseOption(t: Tokens): EChartsOption {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: UI_FONT(t), color: t["text-2"], fontSize: 11 },
    animationDuration: 300,
    animationDurationUpdate: 300,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: t.text, fontSize: 11, fontFamily: NUM_FONT(t) },
      extraCssText: "border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.28)",
    },
  };
}

export function axisCommon(t: Tokens) {
  return {
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
    axisLabel: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 10 },
    splitLine: { lineStyle: { color: alpha(t["border-soft"], 0.75), type: "dashed" as const } },
  };
}

export const fmtTokens = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${Math.round(n)}`;
};

export const fmtPct = (n: number, d = 1): string => (Number.isFinite(n) ? `${n.toFixed(d)}%` : "—");

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * 可空的 RFC3339 → 毫秒；null / 空串给 NaN。
 * 调用方一律用 Number.isFinite 判断，不要拿 Date.parse(null) 碰运气 ——
 * 它在不同引擎里不一定都是 NaN，而 NaN 一旦混进 min/max 就会静默污染整条轴。
 */
export const msOf = (s: string | null | undefined): number => (s ? Date.parse(s) : Number.NaN);

/** 本地时区显示；服务端一律 UTC（CONTRACT §4）。 */
export const fmtClock = (ms: number): string => {
  // 无效时间要显式说"没有"，不能吐 NaN:NaN —— 那既不是时间也不是占位符
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const fmtDay = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};

/** 剩余时长 → "1:48" / "3d 04h"。 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalMin = Math.round(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  if (d >= 1) return `${d}d ${pad(Math.floor((totalMin % 1440) / 60))}h`;
  return `${Math.floor(totalMin / 60)}:${pad(totalMin % 60)}`;
}

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 还有多久：`55 分钟后` / `1 小时 45 分后` / `5 天 16 小时后`。
 * 窗口重置、耗尽预测都用它 —— 人读「还剩多久」比读一个钟点快。
 */
export function fmtUntil(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 60_000) return "即将";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} 分钟后`;
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d >= 1) return h > 0 ? `${d} 天 ${h} 小时后` : `${d} 天后`;
  return m > 0 ? `${h} 小时 ${m} 分后` : `${h} 小时后`;
}

/**
 * 一个未来时刻的钟点表达，按离现在多远决定带多少日期信息：
 *   今天 → `16:10`；明天 → `明天 07:00`；更远 → `09-29 周二 07:00`。
 *
 * ★ 周窗口以前只显示 `07:00 重置`，读起来像明早 7 点，实际是 6 天后的周二。
 *   超过一天的时刻不带日期，就是在给错误的信息。
 */
export function fmtWhen(targetMs: number, nowMs: number): string {
  if (!Number.isFinite(targetMs)) return "—";
  const t = new Date(targetMs);
  const n = new Date(nowMs);
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((dayOf(t) - dayOf(n)) / 86_400_000);
  const clock = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  if (diffDays === 0) return clock;
  if (diffDays === 1) return `明天 ${clock}`;
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} 周${WEEKDAY[t.getDay()]} ${clock}`;
}

/**
 * 燃尽曲线的纵轴上限：贴着数据取一个整齐的刻度。
 *
 * 以前固定 0–110%。用了 5% 的窗口就是一条贴地的线，整张图 90% 是空白 ——
 * 「离上限还远」这件事由额度卡上的进度条表达，这张图的职责是看**轨迹的形状**，
 * 就该把形状放大到看得清。一旦预测逼近上限，自动回到 110%，100% 线重新出现。
 */
export function niceMaxPct(peak: number): number {
  const need = Math.max(0, peak) * 1.15;
  for (const c of [10, 25, 50, 75, 100]) if (need <= c) return c;
  return 110;
}
