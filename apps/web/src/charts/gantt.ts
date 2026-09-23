import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
} from "echarts";
import type { EChartsOption } from "./echarts";
import { axisCommon, baseOption, fmtClock, fmtDuration, fmtTokens, NUM_FONT, UI_FONT } from "./base";
import { alpha, type Tokens } from "./tokens";
import { ganttOverlaps, ganttSegments } from "../api/derive";
import type { Timeline } from "../api/types";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function coordSysRect(params: CustomSeriesRenderItemParams): Rect {
  const cs = params.coordSys as unknown as Partial<Rect>;
  return { x: cs.x ?? 0, y: cs.y ?? 0, width: cs.width ?? 0, height: cs.height ?? 0 };
}

const clampX = (x: number, r: Rect): number => Math.max(r.x, Math.min(r.x + r.width, x));

/**
 * 窗口时间轴甘特图。
 * 每台机器一条泳道，色块深浅 = 消耗强度，红色块 = 多机重叠，
 * 虚线左边框 = 承接自上一窗口被切断，底部时间轴标「现在」「边界」。
 *
 * 契约给的是 lanes[].spans（时间 + events + tokens）；强度、重叠区、边界切分
 * 都是从这份数据推出来的几何，见 src/api/derive.ts。
 */
export function ganttOption(
  t: Tokens,
  timeline: Timeline,
  /** machine_id → 颜色。CONTRACT §2.1a：色板按稳定 id 登记，不按展示用的 label。 */
  colorOf: (machineId: string) => string,
  danger: string,
  nowMs: number,
): EChartsOption {
  // CONTRACT §2.1a：lane 自带 machine_label（取自 enroll 的 hostname）
  const laneNames = timeline.lanes.map((l) => l.machine_label);
  const from = Date.parse(timeline.from);
  const to = Date.parse(timeline.to);

  const labelOfLane = new Map(timeline.lanes.map((l) => [l.machine_id, l.machine_label]));

  type SegValue = [number, number, number, number, number];
  const segData = ganttSegments(timeline).map((s) => ({
    value: [s.laneIndex, s.startMs, s.endMs, s.intensity, s.carriedOver ? 1 : 0] as SegValue,
    itemStyle: { color: colorOf(s.machineId) },
    name: labelOfLane.get(s.machineId) ?? s.machineId,
    tokens: s.tokens,
  }));

  type OverlapValue = [number, number, number, number];
  const overlapData = ganttOverlaps(timeline.lanes).map((o) => ({
    value: [o.loLane, o.hiLane, o.startMs, o.endMs] as OverlapValue,
  }));

  type MarkValue = [number, number];
  const markData: Array<{ value: MarkValue }> = [
    ...timeline.window_boundaries
      .map((b) => Date.parse(b))
      .filter((ms) => ms > from && ms < to)
      .map((ms) => ({ value: [ms, 0] as MarkValue })),
    { value: [Math.min(Math.max(nowMs, from), to), 1] as MarkValue },
  ];

  const renderSegment = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const r = coordSysRect(params);
    const lane = Number(api.value(0));
    const a = api.coord([Number(api.value(1)), lane]);
    const b = api.coord([Number(api.value(2)), lane]);
    const size = api.size?.([0, 1]) as number[] | undefined;
    const h = Math.max(6, (size?.[1] ?? 20) * 0.56);
    const x0 = clampX(a[0] ?? 0, r);
    const x1 = clampX(b[0] ?? 0, r);
    const y = (a[1] ?? 0) - h / 2;
    const intensity = Math.max(0, Math.min(1, Number(api.value(3))));
    const carried = Number(api.value(4)) === 1;
    const base = (api.visual("color") as string) || t.cat1;

    const children: CustomSeriesRenderItemReturn[] = [
      {
        type: "rect",
        shape: { x: x0, y, width: Math.max(1.5, x1 - x0), height: h, r: 2 },
        style: { fill: alpha(base, 0.22 + 0.78 * intensity) },
      } as CustomSeriesRenderItemReturn,
    ];
    if (carried) {
      children.push({
        type: "line",
        shape: { x1: x0, y1: y - 1, x2: x0, y2: y + h + 1 },
        style: { stroke: t.cut, lineWidth: 1.5, lineDash: [3, 3] },
      } as CustomSeriesRenderItemReturn);
    }
    return { type: "group", children } as unknown as CustomSeriesRenderItemReturn;
  };

  const renderOverlap = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const r = coordSysRect(params);
    const a = api.coord([Number(api.value(2)), Number(api.value(0))]);
    const b = api.coord([Number(api.value(3)), Number(api.value(1))]);
    const size = api.size?.([0, 1]) as number[] | undefined;
    const h = Math.max(6, (size?.[1] ?? 20) * 0.56);
    const x0 = clampX(a[0] ?? 0, r);
    const x1 = clampX(b[0] ?? 0, r);
    const top = Math.min(a[1] ?? 0, b[1] ?? 0) - h / 2;
    const bottom = Math.max(a[1] ?? 0, b[1] ?? 0) + h / 2;
    return {
      type: "rect",
      shape: { x: x0, y: top, width: Math.max(1.5, x1 - x0), height: bottom - top, r: 2 },
      style: { fill: alpha(danger, 0.13), stroke: alpha(danger, 0.5), lineWidth: 1 },
    } as unknown as CustomSeriesRenderItemReturn;
  };

  const renderMark = (
    params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const r = coordSysRect(params);
    const p = api.coord([Number(api.value(0)), 0]);
    const isNow = Number(api.value(1)) === 1;
    const x = clampX(p[0] ?? 0, r);
    const color = isNow ? t.cut : danger;
    return {
      type: "group",
      children: [
        {
          type: "line",
          shape: { x1: x, y1: r.y, x2: x, y2: r.y + r.height },
          style: { stroke: color, lineWidth: 1, ...(isNow ? { lineDash: [2, 3] } : {}) },
          z2: isNow ? 20 : 1,
        },
        {
          type: "text",
          style: {
            x,
            // 放在时间刻度**下面**一行：以前是 +16，正好压在「20:00」上
            y: r.y + r.height + 34,
            text: isNow ? "现在" : "边界",
            fill: color,
            font: `10px ${UI_FONT(t)}`,
            align: "center",
          },
        },
      ],
    } as unknown as CustomSeriesRenderItemReturn;
  };

  // 泳道标签区按最长的主机名实测，而不是写死 88px：
  // 「zhouweichuandeMacBook-Pro.local」在 88px 里只剩「cBook-Pro.local」。封顶 220，再长就截断。
  const labelFont = `11px ${UI_FONT(t)}`;
  const longest = laneNames.reduce((mx, n) => Math.max(mx, measureText(String(n), labelFont)), 0);
  // 留一成余量：首帧量宽时正文字体可能还没到，量的是回退字体，而最终画字用的是正文字体
  const labelW = Math.min(220, Math.max(56, Math.ceil(longest * 1.1) + 4));

  return {
    ...baseOption(t),
    grid: { left: labelW + 20, right: 16, top: 10, bottom: 52 },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: "item",
      formatter: (p: unknown) => {
        const d = p as { seriesId?: string; name?: string; value?: number[]; data?: { tokens?: number } };
        const v = d.value ?? [];
        if (d.seriesId === "segments") {
          const s = v[1] ?? 0;
          const e = v[2] ?? 0;
          return `${d.name ?? ""}　${fmtClock(s)}–${fmtClock(e)}　${fmtDuration(e - s)}　${fmtTokens(d.data?.tokens ?? 0)}`;
        }
        if (d.seriesId === "overlaps") {
          const s = v[2] ?? 0;
          const e = v[3] ?? 0;
          return `重叠　${fmtClock(s)}–${fmtClock(e)}　${fmtDuration(e - s)}`;
        }
        return "";
      },
    },
    xAxis: {
      type: "time",
      min: from,
      max: to,
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
      type: "category",
      data: laneNames,
      inverse: true,
      ...axisCommon(t),
      axisLine: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: t["text-2"],
        fontFamily: UI_FONT(t),
        fontSize: 11,
        width: labelW,
        overflow: "truncate",
      },
    },
    series: [
      {
        id: "overlaps",
        type: "custom",
        clip: false,
        renderItem: renderOverlap,
        encode: { x: [2, 3], y: [0, 1] },
        data: overlapData,
        z: 1,
      },
      {
        id: "segments",
        type: "custom",
        clip: false,
        renderItem: renderSegment,
        encode: { x: [1, 2], y: 0 },
        data: segData,
        z: 3,
      },
      {
        id: "marks",
        type: "custom",
        clip: false,
        silent: true,
        renderItem: renderMark,
        encode: { x: 0, y: -1 },
        data: markData,
        z: 6,
      },
    ],
  };
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** 用 canvas 量文字宽度（与 ECharts 画字用的是同一套字体度量）。拿不到 canvas 时按字符数估。 */
function measureText(text: string, font: string): number {
  if (!measureCtx && typeof document !== "undefined") {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}
