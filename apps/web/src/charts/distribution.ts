import type { EChartsOption } from "./echarts";
import { axisCommon, baseOption, fmtClock, fmtDay, fmtPct, fmtTokens, NUM_FONT, UI_FONT } from "./base";
import { alpha, readLightTokens, sequential, type Tokens } from "./tokens";
import type { CachePoint, CostPoint, HourCell, StackSeries } from "../api/derive";
import type { DistributionBucket } from "../api/types";

/** 成本未知与成本为 0 必须区分：桶缺价时 tooltip 里标出来，不显示成 $0.00。 */
function costCell(b: DistributionBucket): string {
  if (b.cost_usd === null) return "成本未知";
  return b.unpriced_events > 0 ? `$${b.cost_usd.toFixed(4)} †` : `$${b.cost_usd.toFixed(4)}`;
}

/**
 * 费用趋势。纵轴是**按公开价目表折算的等价 API 费用**，不是实际扣费 ——
 * 订阅制下实际扣的是固定月费，这条曲线回答的是「如果按 API 计价值多少钱」。
 */
export function costTrendOption(
  t: Tokens,
  points: CostPoint[],
  bucket: "hour" | "day",
): EChartsOption {
  const fmtTick = bucket === "day" ? fmtDay : fmtClock;
  return {
    ...baseOption(t),
    grid: { left: 52, right: 12, top: 16, bottom: 22 },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (v) => (v === null || v === undefined ? "成本未知" : `$${Number(v).toFixed(4)}`),
    },
    xAxis: {
      type: "category",
      data: points.map((p) => fmtTick(p.ts)),
      ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 10, hideOverlap: true },
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
        formatter: (v: number) => `$${v >= 10 ? v.toFixed(0) : v.toFixed(2)}`,
      },
    },
    series: [
      {
        type: "bar",
        name: "折算费用",
        // 缺价的点给 null：ECharts 会留空，而不是画成 0 —— 两者含义完全不同
        data: points.map((p) => p.cost),
        itemStyle: { color: t["cat1"], borderRadius: [2, 2, 0, 0] },
        barMaxWidth: 18,
      },
    ],
  };
}

// ── 机器分布：堆叠柱。桶粒度随区间变化，刻度文案必须跟着变 ──
export function machineStackOption(
  t: Tokens,
  series: StackSeries[],
  colors: Map<string, string>,
  /** "hour" 时刻度是 HH:MM，"day" 时是 M/D —— 7d/30d 用小时刻度会有上百根柱，标签必然叠在一起 */
  bucket: "hour" | "day" = "hour",
): EChartsOption {
  const fmtTick = bucket === "day" ? fmtDay : fmtClock;
  const labels = (series[0]?.points ?? []).map((p) => fmtTick(p.ts));
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
      // 不写死 interval：柱子数量随区间变（24 根 ~ 30 根），
      // 交给 hideOverlap 按实际宽度取舍，比固定每 4 个显示一个稳
      axisLabel: {
        color: t["text-3"],
        fontFamily: NUM_FONT(t),
        fontSize: 10,
        hideOverlap: true,
      },
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
