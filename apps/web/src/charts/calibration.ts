import type { EChartsOption } from "./echarts";
import { axisCommon, baseOption, fmtTokens, NUM_FONT } from "./base";
import { bandSeries } from "./band";
import { alpha, type Tokens } from "./tokens";
import type { CalibrationPoint } from "../api/types";

/**
 * 标定拟合散点。
 *
 * ARCHITECTURE §7.0 的回归是 delta_pct/100 = weighted_tokens / L，
 * 所以横轴取 weighted_tokens、纵轴取 delta_pct：拟合线的斜率就是 1/L，
 * 这张图直接在说「限额是怎么反解出来的」。
 * fitted_pct 连成拟合线，半透明带是 ±residual 的相对误差范围
 * （residual 是 0..1 的相对量，所以带宽随 x 张开，不是等宽平移）。
 */
export function calibrationScatterOption(
  t: Tokens,
  points: CalibrationPoint[],
  residual: number,
): EChartsOption {
  const sorted = [...points].sort((a, b) => a.weighted_tokens - b.weighted_tokens);
  const maxX = Math.max(1, ...sorted.map((p) => p.weighted_tokens)) * 1.06;
  const maxY = Math.max(1, ...sorted.map((p) => Math.max(p.delta_pct, p.fitted_pct))) * 1.1;
  const r = Math.max(0, Math.min(0.9, residual));

  const fit: Array<[number, number]> = sorted.map((p) => [p.weighted_tokens, p.fitted_pct]);
  const lower: Array<[number, number]> = fit.map(([x, y]) => [x, y * (1 - r)]);
  const upper: Array<[number, number]> = fit.map(([x, y]) => [x, y * (1 + r)]);

  return {
    ...baseOption(t),
    grid: { left: 42, right: 14, top: 12, bottom: 28 },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: "item",
      formatter: (p: unknown) => {
        const d = p as { value: number[] };
        return `${fmtTokens(d.value[0] ?? 0)}　观测 ${(d.value[1] ?? 0).toFixed(2)}%`;
      },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: maxX,
      ...axisCommon(t),
      axisLabel: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        formatter: (v: number) => fmtTokens(v),
      },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: maxY,
      ...axisCommon(t),
      axisLine: { show: false },
      axisLabel: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 10, formatter: "{value}%" },
    },
    series: [
      bandSeries({ id: "residual", lower, upper, color: alpha(t.accent, 0.18) }),
      {
        name: "拟合",
        type: "line",
        data: fit,
        symbol: "none",
        silent: true,
        lineStyle: { color: alpha(t["text-4"], 0.9), width: 1, type: "dashed" },
        tooltip: { show: false },
        z: 2,
      },
      {
        name: "观测",
        type: "scatter",
        symbolSize: 5,
        data: sorted.map((p) => [p.weighted_tokens, p.delta_pct]),
        itemStyle: { color: alpha(t.cat3, 0.75) },
        z: 3,
      },
    ],
  };
}
