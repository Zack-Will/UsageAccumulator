import type { EChartsOption } from "./echarts";
import { axisCommon, baseOption, escapeHtml, fmtClock, fmtDay, fmtPct, fmtTokens, NUM_FONT, UI_FONT } from "./base";
import { alpha, readLightTokens, sequential, type Tokens } from "./tokens";
import { treemapAreas, type CachePoint, type HourCell, type MetricSeries, type UsageMetric } from "../api/derive";
import type { DistributionBucket } from "../api/types";

/** 成本未知与成本为 0 必须区分：桶缺价时 tooltip 里标出来，不显示成 $0.00。 */
function costCell(b: DistributionBucket): string {
  if (b.cost_usd === null) return "成本未知";
  return b.unpriced_events > 0 ? `$${b.cost_usd.toFixed(4)} †` : `$${b.cost_usd.toFixed(4)}`;
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
  // 按 key 找回 bucket，不按名字：名字会撞（两个都叫 web 的项目、同一天两个没标题的临时会话）
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const bucketOf = (p: unknown) => byKey.get((p as { data?: { id?: string } }).data?.id ?? "");
  // 面积有保底（见 treemapAreas），所以下面的标签和 tooltip 一律读 bucket 的真实数，不读 value
  const areas = treemapAreas(buckets.map((b) => b.total_tokens));
  return {
    ...baseOption(t),
    tooltip: {
      ...baseOption(t).tooltip,
      // 手机上小块主要靠点开 tooltip 认，别让它伸出屏幕
      confine: true,
      // HTML tooltip：换行用 <br/>；名字可能是会话标题（任意文本），必须转义
      formatter: (p: unknown) => {
        const b = bucketOf(p);
        if (!b) return escapeHtml((p as { name: string }).name);
        // 临时工作区（桌面端不选项目直接开的对话）注明一句，免得把会话标题当成项目名
        const scratch = b.key.includes("-scratch-workspaces-") ? "<br/>临时会话 · 没有项目目录" : "";
        return `${escapeHtml(labelOf(b))}　${fmtTokens(b.total_tokens)}<br/>${costCell(b)}${scratch}`;
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
            const b = bucketOf(p);
            if (!b) return (p as { name: string }).name;
            // 缺价的块在名字后带 †，和 tooltip 的口径一致
            const mark = b.cost_usd === null ? " †" : "";
            return `${labelOf(b)}${mark}\n${fmtTokens(b.total_tokens)}`;
          },
        },
        // 窄到放不下两三个字、矮到放不下一行的块干脆不写字：截断后只剩「2」「za」这种残片，像是坏了。
        // 块本身还在，悬停照样有 tooltip。fontSize 0 会被 zrender 解析成 0px，等于隐藏
        labelLayout: (p: { rect: { width: number; height: number } }) =>
          p.rect.width < 32 || p.rect.height < 16 ? { fontSize: 0 } : {},
        data: buckets.map((b, i) => ({
          id: b.key,
          name: labelOf(b),
          value: areas[i],
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

// ── 用量时间线：按机器堆叠，费用 / token 两种口径 ───────────────────────────
/**
 * 把原来的「折算 API 费用」和「机器分布」合成一张。
 * 两张图画的是同一条时间轴、同一批事件，只是一个看钱、一个看 token 按机器拆 ——
 * 分开放各占一整行，两行加起来大半是空白。合成一张堆叠柱，高度 = 总量，颜色 = 机器。
 *
 * 横轴用**补齐后的完整刻度**（derive.bucketTicks），空着的小时是真空档，不再被挤掉。
 */
export function usageTimelineOption(
  t: Tokens,
  ticks: number[],
  series: MetricSeries[],
  colors: Map<string, string>,
  bucket: "hour" | "day",
  metric: UsageMetric,
): EChartsOption {
  // 小时桶跨零点时把 00:00 换成日期：一眼看出哪几根柱子是昨天的
  const fmtTick = (ms: number): string =>
    bucket === "day" ? fmtDay(ms) : new Date(ms).getHours() === 0 ? fmtDay(ms) : fmtClock(ms);

  // 纵轴刻度的小数位由**整轴**的量级决定，不再一格一个样（以前是 $18 / $15 / $9.00 / $6.00）
  const stackMax = ticks.reduce((mx, _, i) => {
    const sum = series.reduce((a, s) => a + (s.values[i] ?? 0), 0);
    return Math.max(mx, sum);
  }, 0);
  const costDigits = stackMax >= 10 ? 0 : 2;
  const fmtValue = (v: number): string =>
    metric === "cost" ? `$${v.toFixed(costDigits)}` : fmtTokens(v);

  return {
    ...baseOption(t),
    grid: { left: 50, right: 12, top: 30, bottom: 22 },
    legend: {
      top: 0,
      left: 0,
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 16,
      // 圆点图例：与明细表的色点同一个形状
      icon: "circle",
      textStyle: { color: t["text-2"], fontFamily: NUM_FONT(t), fontSize: 10 },
    },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const ps = params as Array<{ seriesName: string; value: number | null; marker: string; dataIndex: number }>;
        const idx = ps[0]?.dataIndex ?? 0;
        const head = bucket === "day" ? fmtDay(ticks[idx] ?? 0) : `${fmtDay(ticks[idx] ?? 0)} ${fmtClock(ticks[idx] ?? 0)}`;
        let total = 0;
        let unknown = false;
        const rows = ps
          .filter((p) => p.value !== 0)
          .map((p) => {
            if (p.value === null) {
              unknown = true;
              return `${p.marker}${p.seriesName}　${metric === "cost" ? "成本未知" : "—"}`;
            }
            total += p.value;
            return `${p.marker}${p.seriesName}　${metric === "cost" ? `$${p.value.toFixed(2)}` : fmtTokens(p.value)}`;
          });
        if (rows.length === 0) return `${head}<br/>无用量`;
        const sum = metric === "cost" ? `$${total.toFixed(2)}${unknown ? " †" : ""}` : fmtTokens(total);
        return [`${head}　合计 ${sum}`, ...rows].join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: ticks.map(fmtTick),
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
        formatter: (v: number) => fmtValue(v),
      },
    },
    series: series.map((s, i) => ({
      name: s.label,
      type: "bar" as const,
      stack: "usage",
      barMaxWidth: 18,
      barCategoryGap: "32%",
      itemStyle: {
        color: colors.get(s.key) ?? t.cat1,
        borderRadius: i === series.length - 1 ? [3, 3, 0, 0] : 0,
      },
      emphasis: { focus: "series" as const },
      data: s.values,
    })),
  };
}
