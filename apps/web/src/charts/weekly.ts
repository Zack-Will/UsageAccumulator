/**
 * 周额度曲线。
 *
 * 纵轴是官方给的 utilization_pct（0..100），横轴是快照的采集时刻。
 * ★ 这是**离散采样**（探针 5 分钟抓一次），不是连续函数：
 * 用 step 折线而不是平滑曲线，免得看起来像我们知道两点之间发生了什么。
 */
import type { EChartsOption } from "./echarts";
import { axisCommon, baseOption, NUM_FONT } from "./base";
import { alpha, type Tokens } from "./tokens";
import type { QuotaSample } from "../api/types";

export function weeklyQuotaOption(
  t: Tokens,
  samples: QuotaSample[],
  weekStartMs: number,
  weekEndMs: number,
): EChartsOption {
  const pts = samples
    .map((s) => [Date.parse(s.ts), s.utilization_pct] as [number, number])
    .filter(([ms]) => Number.isFinite(ms))
    .sort((a, b) => a[0] - b[0]);

  return {
    ...baseOption(t),
    grid: { left: 44, right: 14, top: 18, bottom: 26 },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: "axis",
      valueFormatter: (v) => `${Number(v).toFixed(1)}%`,
    },
    xAxis: {
      type: "time",
      min: weekStartMs,
      max: weekEndMs,
      ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        hideOverlap: true,
        formatter: (v: number) => {
          const d = new Date(v);
          return `${d.getMonth() + 1}/${d.getDate()}`;
        },
      },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      ...axisCommon(t),
      axisLine: { show: false },
      axisLabel: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        formatter: (v: number) => `${v}%`,
      },
    },
    series: [
      {
        type: "line",
        name: "已用",
        step: "end",
        showSymbol: false,
        data: pts,
        lineStyle: { width: 1.6, color: t["cat1"] },
        areaStyle: { color: alpha(t["cat1"], 0.14) },
      },
    ],
  };
}
