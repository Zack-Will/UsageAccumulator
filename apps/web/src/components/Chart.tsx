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
  const optionRef = useRef(option);
  optionRef.current = option;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const inst = echarts.init(host, undefined, { renderer: "canvas" });
    instRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(host);
    // ★ canvas 里的字是画死的：首帧如果字体还没到，刻度会一直是回退字体。
    //   字体就绪后用当前 option 重画一次。
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive && instRef.current) instRef.current.setOption(optionRef.current, true);
    });
    return () => {
      alive = false;
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
