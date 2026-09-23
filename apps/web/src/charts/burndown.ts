import type { EChartsOption } from "./echarts";
import { axisCommon, baseOption, fmtClock, fmtDay, niceMaxPct, NUM_FONT } from "./base";
import { bandSeries } from "./band";
import { alpha, status, type Tokens } from "./tokens";
import type { WindowState } from "../api/types";

type Pair = [number, number];
type MaybePair = [number, number | null];

/**
 * CONTRACT §2.1：burn_curve 的点必须可区分来源。
 * official 画实线，interpolated 画虚线 —— 推算出来的曲线不能长得像官方数据。
 */
function splitBySource(w: WindowState): {
  official: MaybePair[];
  interpolated: MaybePair[] | null;
} {
  const pts = w.burn_curve;
  const interp = (i: number): boolean => pts[i]?.source === "interpolated";
  const hasInterp = pts.some((p) => p.source === "interpolated");

  const official: MaybePair[] = pts.map((p, i) => [Date.parse(p.ts), interp(i) ? null : p.pct]);
  if (!hasInterp) return { official, interpolated: null };

  // 虚线段两端各延伸一个 official 点，否则两段之间会断开
  const interpolated: MaybePair[] = pts.map((p, i) => [
    Date.parse(p.ts),
    interp(i) || interp(i - 1) || interp(i + 1) ? p.pct : null,
  ]);
  return { official, interpolated };
}

export function burndownOption(
  t: Tokens,
  w: WindowState,
  nowMs: number,
  span: "five_hour" | "long",
): EChartsOption {
  const s = status(t);
  const { official, interpolated } = splitBySource(w);
  const startMs = Date.parse(w.starts_at);
  const endMs = Date.parse(w.resets_at);
  const fmtX = span === "five_hour" ? fmtClock : fmtDay;

  /**
   * 预测曲线整条来自服务端（CONTRACT §2.1 的 projected_curve）。
   * **前端不得自行外推**：5h 是线性速率，但 7d 走「按星期几的日历模式」，
   * 在前端做线性插值会系统性偏离服务端的真实预测。
   */
  const curve = w.projected_curve;
  const lo: Pair[] = curve.map((p) => [Date.parse(p.ts), p.p25]);
  const hi: Pair[] = curve.map((p) => [Date.parse(p.ts), p.p75]);
  const mid: Pair[] = curve.map((p) => [Date.parse(p.ts), p.mid]);

  // 纵轴贴着数据走（见 niceMaxPct）：已用与预测上沿里取最高的那个
  const peak = Math.max(
    w.utilization_pct,
    ...w.burn_curve.map((p) => p.pct),
    ...curve.map((p) => p.p75),
  );
  const yMax = niceMaxPct(peak);
  // 100% 线只在视野内时才画 —— 画在轴外会把纵轴硬撑回 110%，缩放就白做了
  const limitInView = yMax >= 100;

  const series: NonNullable<EChartsOption["series"]> = [];

  if (curve.length > 1) {
    // 预测区间用半透明色带，不是三条实线（ARCHITECTURE §8 美学基线）
    series.push(bandSeries({ id: "p25p75", lower: lo, upper: hi, color: alpha(t.accent, 0.2), z: 1 }));
    series.push({
      name: "预计",
      type: "line",
      data: mid,
      symbol: "none",
      lineStyle: { color: alpha(t.accent, 0.8), width: 1.2, type: "dashed" },
    });
  }

  if (interpolated) {
    series.push({
      name: "插值",
      type: "line",
      data: interpolated,
      symbol: "none",
      connectNulls: false,
      lineStyle: { color: alpha(t.accent, 0.85), width: 1.6, type: "dashed" },
    });
  }

  series.push({
    name: "已用",
    type: "line",
    data: official,
    symbol: "none",
    connectNulls: false,
    lineStyle: { color: t.accent, width: 1.8 },
    areaStyle: { color: alpha(t.accent, 0.1) },
    markLine: {
      silent: true,
      symbol: "none",
      label: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        rotate: 0,
        formatter: (p: { name?: string }) => p.name ?? "",
      },
      data: [
        ...(limitInView
          ? [{ yAxis: 100, lineStyle: { color: s.danger, type: "dashed" as const, width: 1 }, label: { show: false } }]
          : []),
        {
          name: "边界",
          xAxis: endMs,
          lineStyle: { color: s.danger, width: 1 },
          label: { position: "insideEndTop", color: s.danger, rotate: 0 },
        },
        {
          name: "现在",
          xAxis: nowMs,
          lineStyle: { color: t.cut, type: "dotted", width: 1 },
          label: { position: "insideStartTop", rotate: 0 },
        },
      ],
    },
  });

  return {
    ...baseOption(t),
    grid: { left: 42, right: 16, top: 16, bottom: 26 },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: t["text-4"] } },
      valueFormatter: (v) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}%`),
    },
    xAxis: {
      type: "time",
      min: startMs,
      max: endMs,
      ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        formatter: (v: number) => fmtX(v),
      },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: yMax,
      // 刻度取整数百分比：25% 上限按 4 等分是 6.25 / 12.5 / 18.75，读起来像噪声
      interval: ({ 10: 2, 25: 5, 50: 10, 75: 25 } as Record<number, number>)[yMax] ?? 25,
      ...axisCommon(t),
      axisLine: { show: false },
      axisLabel: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        showMaxLabel: false,
        formatter: "{value}%",
      },
    },
    series,
  };
}
