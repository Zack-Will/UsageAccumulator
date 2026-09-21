import { useEffect, useRef } from "react";
import { echarts, type EChartsOption } from "../charts/echarts";

interface ChartProps {
  option: EChartsOption;
  height: number | string;
  /** Canvas 不可读屏，容器补一个 role=img + 描述。 */
  ariaLabel: string;
  className?: string;
}

export function Chart({ option, height, ariaLabel, className }: ChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const inst = echarts.init(host, undefined, { renderer: "canvas" });
    instRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(host);
    return () => {
      ro.disconnect();
      inst.dispose();
      instRef.current = null;
    };
  }, []);

  useEffect(() => {
    // notMerge：主题切换会换掉全部颜色，增量合并会留下旧色。
    instRef.current?.setOption(option, true);
  }, [option]);

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ height, width: "100%" }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}
