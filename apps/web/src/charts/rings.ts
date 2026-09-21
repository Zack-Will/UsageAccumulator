import type { EChartsOption } from "./echarts";
import { baseOption } from "./base";
import { alpha, status, type Tokens } from "./tokens";

export type RingTone = "ok" | "warn" | "danger";

/**
 * 已用逼近上限 → danger；已用偏高或预测撞线 → warn。
 * 7d Fable 这类「用了七成、预计九成」的窗口必须落在 warn，不能显示成安全。
 */
export function ringTone(used: number, projected: number): RingTone {
  if (used >= 90) return "danger";
  if (used >= 70 || projected >= 95) return "warn";
  return "ok";
}

/**
 * 窗口环形：内圈 = 已用（utilization_pct），外圈 = 预计（projected_pct.mid）。
 * 中心数字由 HTML 承担，这里不画文字 —— canvas 里做不到 tabular-nums。
 */
export function ringOption(
  t: Tokens,
  opts: { used: number; projected: number; tone: RingTone },
): EChartsOption {
  const s = status(t);
  const main = s[opts.tone];
  const used = Math.max(0, Math.min(100, opts.used));
  const projected = Math.max(0, Math.min(100, opts.projected));

  return {
    ...baseOption(t),
    tooltip: { show: false },
    series: [
      {
        type: "pie",
        radius: ["62%", "84%"],
        center: ["50%", "50%"],
        startAngle: 90,
        silent: true,
        label: { show: false },
        labelLine: { show: false },
        data: [
          { value: used, itemStyle: { color: main, borderRadius: 3 } },
          { value: 100 - used, itemStyle: { color: t["ring-track"] } },
        ],
      },
      {
        type: "pie",
        radius: ["89%", "95%"],
        center: ["50%", "50%"],
        startAngle: 90,
        silent: true,
        label: { show: false },
        labelLine: { show: false },
        data: [
          { value: projected, itemStyle: { color: alpha(main, 0.42), borderRadius: 2 } },
          { value: 100 - projected, itemStyle: { color: "transparent" } },
        ],
      },
    ],
  };
}
