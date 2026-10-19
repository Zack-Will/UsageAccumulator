import type { EChartsOption } from "./echarts";
import { axisCommon, baseOption, fmtClock, fmtDay, msOf, niceMaxPct, NUM_FONT } from "./base";
import { bandSeries } from "./band";
import { alpha, status, type Tokens } from "./tokens";
import type { CodexWindowAnalysis } from "../api/types";

type MaybePair = [number, number | null];

/**
 * Codex 一个窗口当前这一期的燃尽图。
 *
 * 与 Claude 那张的区别全在「官方提前重置」上：
 *   · 已用曲线在每次重置处**断开**，不画 51% → 0% 那一条下坠的斜线 —— 那不是用量，是清零；
 *   · 每次重置一根竖线，标「重置」；
 *   · 预测从当前段末尾出发（服务端只用当前段算速率），到计划重置为止；提前耗尽就在 100% 处封顶。
 */
export function codexBurnOption(t: Tokens, a: CodexWindowAnalysis, nowMs: number): EChartsOption {
  const s = status(t);
  const p = a.period;
  const endMs = msOf(p.scheduled_end);
  const startMs = msOf(p.starts_at) || msOf(p.first_sample_at);
  const short = (p.duration_minutes ?? 0) < 24 * 60;
  const fmtX = short ? fmtClock : fmtDay;

  // 段与段之间插一个 null：线在重置处断开
  const used: MaybePair[] = [];
  let seg = p.samples[0]?.segment ?? 0;
  for (const x of p.samples) {
    if (x.segment !== seg) {
      used.push([Date.parse(x.ts) - 1, null]);
      seg = x.segment;
    }
    used.push([Date.parse(x.ts), x.pct]);
  }

  const last = p.samples.at(-1);
  const lastMs = last ? Date.parse(last.ts) : nowMs;
  const lastPct = last?.pct ?? p.final_pct;
  const eta = msOf(a.exhaust_eta);
  const projecting = !p.ended_at && Number.isFinite(endMs) && endMs > lastMs;
  // 预测：到耗尽时刻封顶 100，之后持平；不会耗尽就直线到计划重置
  const proj = (v: number): MaybePair[] =>
    Number.isFinite(eta) && eta < endMs && v >= 100
      ? [[lastMs, lastPct], [eta, 100], [endMs, 100]]
      : [[lastMs, lastPct], [endMs, Math.min(100, v)]];

  const peak = Math.max(lastPct, ...p.samples.map((x) => x.pct), projecting ? a.projected_pct.p75 : 0);
  const yMax = niceMaxPct(peak);

  const series: NonNullable<EChartsOption["series"]> = [];
  if (projecting) {
    series.push(
      bandSeries({
        id: "p25p75",
        lower: [[lastMs, lastPct], [endMs, Math.min(100, a.projected_pct.p25)]],
        upper: [[lastMs, lastPct], [endMs, Math.min(100, a.projected_pct.p75)]],
        color: alpha(t.accent, 0.18),
        z: 1,
      }),
    );
    series.push({
      name: "预计",
      type: "line",
      data: proj(a.projected_pct.mid),
      symbol: "none",
      lineStyle: { color: alpha(t.accent, 0.8), width: 1.2, type: "dashed" },
    });
  }
  series.push({
    name: "已用",
    type: "line",
    data: used,
    symbol: "none",
    connectNulls: false,
    lineStyle: { color: t.accent, width: 1.8 },
    areaStyle: { color: alpha(t.accent, 0.1) },
    markLine: {
      silent: true,
      symbol: "none",
      label: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 10, rotate: 0, formatter: (x: { name?: string }) => x.name ?? "" },
      data: [
        ...(yMax >= 100 ? [{ yAxis: 100, lineStyle: { color: s.danger, type: "dashed" as const, width: 1 }, label: { show: false } }] : []),
        ...p.resets.map((r) => ({
          name: "重置",
          xAxis: Date.parse(r.at),
          lineStyle: { color: s.warn, width: 1, type: "dashed" as const },
          label: { position: "insideEndTop" as const, color: s.warn, rotate: 0 },
        })),
        ...(nowMs < endMs
          ? [{ name: "现在", xAxis: nowMs, lineStyle: { color: t.cut, type: "dotted" as const, width: 1 }, label: { position: "insideStartTop" as const, rotate: 0 } }]
          : []),
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
      valueFormatter: (v) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(0)}%`),
    },
    xAxis: {
      type: "time",
      min: Number.isFinite(startMs) ? startMs : undefined,
      max: Number.isFinite(endMs) ? endMs : undefined,
      ...axisCommon(t),
      splitLine: { show: false },
      axisLabel: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 10, formatter: (v: number) => fmtX(v) },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: yMax,
      interval: ({ 10: 2, 25: 5, 50: 10, 75: 25 } as Record<number, number>)[yMax] ?? 25,
      ...axisCommon(t),
      axisLine: { show: false },
      axisLabel: { color: t["text-3"], fontFamily: NUM_FONT(t), fontSize: 10, formatter: (v: number) => `${v}%` },
    },
    series,
  };
}
