import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
} from "echarts";
import type { EChartsOption } from "./echarts";

type Pt = [number, number];
type SeriesItem = NonNullable<EChartsOption["series"]> extends ReadonlyArray<infer U> ? U : never;

/**
 * 半透明区间带（燃尽曲线的 P25–P75、标定散点的 ±残差 …）。
 *
 * ⚠️ 不要"优化"回「两条 line + 同一个 stack」的常见写法。
 *
 * 那个写法在 ECharts 5 的 value / time 轴上是**错的**：上沿那条 series 的 areaStyle
 * 会填到**坐标轴基线**，而不是填到堆叠基线。于是本该是「P25 到 P75 之间的带」，
 * 实际画成了「P75 以下的全部面积」—— 图形看着像一条带（因为上沿轮廓对），
 * 含义却完全变了：它在说「用量可能落在 0 到 P75 之间」，而不是「P25 到 P75 之间」。
 *
 * 这个坑是靠 canvas 像素采样确认的（在带的下方取点，本该透明却是填充色），
 * 肉眼看截图分辨不出来，review 也看不出来。所以别信 stack，直接画多边形：
 * 上沿正着走一遍，下沿倒着走回来，闭合成一个封闭区域。
 */
export function bandSeries(opts: {
  id: string;
  lower: Pt[];
  upper: Pt[];
  color: string;
  z?: number;
}): SeriesItem {
  const { lower, upper } = opts;

  const renderItem = (
    _params: CustomSeriesRenderItemParams,
    api: CustomSeriesRenderItemAPI,
  ): CustomSeriesRenderItemReturn => {
    const points: number[][] = [];
    for (const p of upper) points.push(api.coord(p));
    for (let i = lower.length - 1; i >= 0; i--) {
      const p = lower[i];
      if (p) points.push(api.coord(p));
    }
    if (points.length < 3) return { type: "group", children: [] } as unknown as CustomSeriesRenderItemReturn;
    return {
      type: "polygon",
      shape: { points },
      style: { fill: opts.color },
      silent: true,
    } as unknown as CustomSeriesRenderItemReturn;
  };

  return {
    id: opts.id,
    type: "custom",
    clip: true,
    silent: true,
    z: opts.z ?? 1,
    // 数据点只是渲染触发器；真正的几何来自上面的闭包
    data: [[upper[0]?.[0] ?? 0, upper[0]?.[1] ?? 0]],
    renderItem,
    tooltip: { show: false },
  } as SeriesItem;
}
