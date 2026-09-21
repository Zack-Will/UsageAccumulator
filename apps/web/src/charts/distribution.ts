import type { EChartsOption } from "./echarts";
import { axisCommon, baseOption, fmtClock, fmtPct, fmtTokens, NUM_FONT, UI_FONT } from "./base";
import { alpha, readLightTokens, sequential, type Tokens } from "./tokens";
import type { CachePoint, HourCell, StackSeries } from "../api/derive";
import type { DistributionBucket } from "../api/types";

/** 成本未知与成本为 0 必须区分：桶缺价时 tooltip 里标出来，不显示成 $0.00。 */
function costCell(b: DistributionBucket): string {
  if (b.cost_usd === null) return "成本未知";
  return b.unpriced_events > 0 ? `$${b.cost_usd.toFixed(4)} †` : `$${b.cost_usd.toFixed(4)}`;
}

// ── 机器分布：按小时堆叠柱（数据由 derive.machineHourly 从 /v1/timeline 还原） ──
export function machineStackOption(
  t: Tokens,
  series: StackSeries[],
  colors: Map<string, string>,
): EChartsOption {
  const labels = (series[0]?.points ?? []).map((p) => fmtClock(p.ts));
  return {
    ...baseOption(t),
    grid: { left: 46, right: 12, top: 28, bottom: 22 },
    legend: {
      top: 0,
      left: 0,
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 14,
      icon: "roundRect",
      textStyle: { color: t["text-2"], fontFamily: NUM_FONT(t), fontSize: 10 },
    },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (v) => fmtTokens(Number(v)),
    },
    xAxis: {
      type: "category",
      data: labels,
      ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 10, interval: 3 },
    },
    yAxis: {
      type: "value",
      min: 0,
      ...axisCommon(t),
      axisLine: { show: false },
      axisLabel: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        formatter: (v: number) => fmtTokens(v),
      },
    },
    series: series.map((s, i) => ({
      name: s.label,
      type: "bar" as const,
      stack: "machines",
      barMaxWidth: 16,
      itemStyle: {
        color: colors.get(s.key) ?? t.cat1,
        borderRadius: i === series.length - 1 ? [2, 2, 0, 0] : 0,
      },
      data: s.points.map((p) => p.tokens),
    })),
  };
}

// ── 模型占比：环形 + 图例 ──────────────────────────────────────────────────
export function modelDonutOption(
  t: Tokens,
  buckets: DistributionBucket[],
  /** 按 bucket.key 取色（CONTRACT §2.1a），不按 label。 */
  colors: Map<string, string>,
  labelOf: (b: DistributionBucket) => string,
): EChartsOption {
  const byName = new Map(buckets.map((b) => [labelOf(b), b]));
  return {
    ...baseOption(t),
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: "item",
      formatter: (p: unknown) => {
        const d = p as { name: string; value: number; percent: number };
        const b = byName.get(d.name);
        return `${d.name}　${fmtTokens(d.value)}　${d.percent.toFixed(1)}%${b ? `\n${costCell(b)}` : ""}`;
      },
    },
    legend: {
      orient: "vertical",
      right: 4,
      top: "middle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 10,
      icon: "roundRect",
      textStyle: { color: t["text-2"], fontFamily: NUM_FONT(t), fontSize: 10 },
    },
    series: [
      {
        type: "pie",
        radius: ["55%", "78%"],
        center: ["32%", "50%"],
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: t.surface, borderWidth: 2 },
        data: buckets.map((b) => ({
          name: labelOf(b),
          value: b.total_tokens,
          itemStyle: { color: colors.get(b.key) ?? t.cat1 },
        })),
      },
    ],
  };
}

// ── 项目 treemap ───────────────────────────────────────────────────────────
/**
 * 「饱和底 + 深色文字」，两套主题保持一致：
 * 文字固定取日间主题的 --text，底色取分类色板（两套主题下都是饱和色）。
 * 这正是「图形色按 3:1 / 文字色按 4.5:1」两套约束的落点。
 */
export function projectTreemapOption(
  t: Tokens,
  buckets: DistributionBucket[],
  /** 按 bucket.key 取色（CONTRACT §2.1a）：key 可能是 HMAC 化的 slug，label 才是可读别名。 */
  colors: Map<string, string>,
  labelOf: (b: DistributionBucket) => string,
): EChartsOption {
  const ink = readLightTokens().text;
  const byName = new Map(buckets.map((b) => [labelOf(b), b]));
  return {
    ...baseOption(t),
    tooltip: {
      ...baseOption(t).tooltip,
      formatter: (p: unknown) => {
        const d = p as { name: string; value: number };
        const b = byName.get(d.name);
        return `${d.name}　${fmtTokens(d.value)}${b ? `\n${costCell(b)}` : ""}`;
      },
    },
    series: [
      {
        type: "treemap",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        top: 2,
        left: 0,
        right: 0,
        bottom: 2,
        itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2 },
        label: {
          show: true,
          color: ink,
          fontFamily: UI_FONT(t),
          fontSize: 11,
          overflow: "truncate",
          formatter: (p: unknown) => {
            const d = p as { name: string; value: number };
            const b = byName.get(d.name);
            // 缺价的块在名字后带 †，和 tooltip 的口径一致
            const mark = b && b.cost_usd === null ? " †" : "";
            return `${d.name}${mark}\n${fmtTokens(d.value)}`;
          },
        },
        data: buckets.map((b) => ({
          name: labelOf(b),
          value: b.total_tokens,
          itemStyle: { color: colors.get(b.key) ?? t.cat1 },
        })),
      },
    ],
  };
}

// ── 星期 × 小时热力图 ──────────────────────────────────────────────────────
const DOW = ["一", "二", "三", "四", "五", "六", "日"];

export function hourHeatmapOption(t: Tokens, cells: HourCell[]): EChartsOption {
  const max = cells.reduce((a, c) => Math.max(a, c.tokens), 0) || 1;
  return {
    ...baseOption(t),
    grid: { left: 26, right: 12, top: 8, bottom: 40 },
    tooltip: {
      ...baseOption(t).tooltip,
      formatter: (p: unknown) => {
        const d = p as { data: [number, number, number] };
        return `${DOW[d.data[1]] ?? ""} ${String(d.data[0]).padStart(2, "0")}:00　${fmtTokens(d.data[2])}`;
      },
    },
    xAxis: {
      type: "category",
      data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")),
      splitArea: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 9, interval: 2 },
    },
    yAxis: {
      type: "category",
      data: DOW,
      splitArea: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t["text-3"], fontFamily: UI_FONT(t), fontSize: 10 },
    },
    visualMap: {
      min: 0,
      max,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemWidth: 10,
      itemHeight: 90,
      inRange: { color: sequential(t) },
      textStyle: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 9 },
      formatter: (v: unknown) => fmtTokens(Number(v)),
    },
    series: [
      {
        type: "heatmap",
        data: cells.map((c) => [c.hour, c.dow, c.tokens]),
        itemStyle: { borderColor: t.surface, borderWidth: 1 },
        progressive: 0,
      },
    ],
  };
}

// ── 缓存命中率趋势 ─────────────────────────────────────────────────────────
export function cacheTrendOption(t: Tokens, points: CachePoint[]): EChartsOption {
  return {
    ...baseOption(t),
    grid: { left: 42, right: 12, top: 12, bottom: 22 },
    tooltip: { ...baseOption(t).tooltip, trigger: "axis", valueFormatter: (v) => fmtPct(Number(v)) },
    xAxis: {
      type: "time",
      ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        formatter: (v: number) => fmtClock(v),
      },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      interval: 25,
      ...axisCommon(t),
      axisLine: { show: false },
      axisLabel: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 10, formatter: "{value}%" },
    },
    series: [
      {
        type: "line",
        smooth: true,
        symbol: "none",
        data: points.map((p) => [p.ts, p.cacheReadPct]),
        lineStyle: { color: t.cat2, width: 1.6 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: alpha(t.cat2, 0.26) },
              { offset: 1, color: alpha(t.cat2, 0.02) },
            ],
          },
        },
      },
    ],
  };
}
