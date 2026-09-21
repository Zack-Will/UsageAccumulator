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
