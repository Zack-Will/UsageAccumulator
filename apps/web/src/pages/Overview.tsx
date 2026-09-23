import { useMemo, useState } from "react";
import type { Machine, UaApi, WindowsCurrent } from "../api";
import {
  alignedSeries,
  bucketLabel,
  bucketTicks,
  machineIndex,
  modelDisplayName,
  usageTotals,
  type UsageMetric,
} from "../api/derive";
import { burndownOption } from "../charts/burndown";
import { usageTimelineOption } from "../charts/distribution";
import { colorMapFor } from "../charts/registry";
import type { Tokens } from "../charts/tokens";
import { Chart } from "../components/Chart";
import { Card, Mono, Placeholder, Segmented } from "../components/primitives";
import { PageHead } from "../components/PageHead";
import { BreakdownTable, UsageSummary } from "../components/UsagePanels";
import { displayWindows, isActiveWindow, labelOf, quotaSpans, WindowCard } from "../components/WindowCards";
import { useAsync } from "../hooks/useAsync";

interface Props {
  api: UaApi;
  t: Tokens;
  profileId: string;
  from: string;
  to: string;
  /** 顶栏所选区间的文案（5h / 24h / 7d / 30d），给「区间用量」当标题 */
  rangeLabel: string;
  nonce: number;
  nowMs: number;
  machines: Machine[];
  windows: WindowsCurrent | null;
  windowsError: Error | null;
}

/**
 * 总览的阅读顺序就是重要性顺序：
 *   1. 额度 —— 会不会撞墙、什么时候重置（三张额度卡）
 *   2. 区间内用了多少、值多少钱、花在哪个模型上（图二那块面板的内容）
 *   3. 什么时候用的、在哪台机器上用的
 *   4. 当前窗口的轨迹细节（燃尽曲线）
 * 以前 2 几乎不存在，3 拆成两张大半空白的整行图，4 固定 0–110% 纵轴，
 * 用了 5% 的时候整张图只有一条贴地的线。
 */
export function Overview({
  api,
  t,
  profileId,
  from,
  to,
  rangeLabel,
  nonce,
  nowMs,
  machines,
  windows,
  windowsError,
}: Props) {
  /**
   * 桶粒度随区间走：超过两天就按天。
   * 7d 用小时桶是 168 根柱、30d 是 720 根 —— 柱子细到看不清，刻度也必然叠成一团。
   */
  const bucket: "hour" | "day" =
    Date.parse(to) - Date.parse(from) > 48 * 3600_000 ? "day" : "hour";

  // 二维分桶：by=machine + bucket 同时喂时间线（series）和机器表（桶合计）
  const machineDist = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "machine", bucket }, s),
    [api, profileId, from, to, nonce],
  );
  // 模型表与区间合计只要桶合计，不要时间序列
  const models = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "model" }, s),
    [api, profileId, from, to, nonce],
  );

  // 展示用的窗口集合：核心窗口永远在（空闲也在），代号占位字段照旧滤掉
  const shown = useMemo(() => (windows ? displayWindows(windows.windows) : null), [windows]);
  // 这一行的列宽跟着张数走，永远铺满 12 栅格 —— 下面的卡不会被挤上来
  const spans = quotaSpans(shown?.length ?? 3);

  // 燃尽曲线只画正在计时的窗口：空闲窗口没有起止时刻，画出来是一张空轴。
  // projected_curve 对 7d 是日历模式（周末塌下去），只画 5h 的话这条曲线最要紧的那一半永远看不到。
  const burnable = useMemo(() => shown?.filter(isActiveWindow) ?? [], [shown]);
  const [burnKind, setBurnKind] = useState("five_hour");
  const burnWindow = burnable.find((w) => w.window_kind === burnKind) ?? burnable[0];
  const burnOption = useMemo(
    () =>
      burnWindow
        ? burndownOption(t, burnWindow, nowMs, burnWindow.window_kind === "five_hour" ? "five_hour" : "long")
        : null,
    [t, burnWindow, nowMs],
  );

  // 时间线默认看钱：这个项目最初要回答的就是「按 API 算值多少」
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const idx = useMemo(() => machineIndex(machines), [machines]);
  const machineLabel = useMemo(() => (b: Parameters<typeof bucketLabel>[0]) => bucketLabel(b, idx.label), [idx]);
  const machineColors = useMemo(
    () => colorMapFor("machine", (machineDist.data?.buckets ?? []).map((b) => b.key), t),
    [machineDist.data, t],
  );
  const timelineOption = useMemo(() => {
    if (!machineDist.data) return null;
    const ticks = bucketTicks(Date.parse(from), Date.parse(to), bucket);
    const series = alignedSeries(machineDist.data.buckets, ticks, metric, machineLabel);
    return usageTimelineOption(t, ticks, series, machineColors, bucket, metric);
  }, [t, machineDist.data, from, to, bucket, metric, machineLabel, machineColors]);

  const modelColors = useMemo(
    () => colorMapFor("model", (models.data?.buckets ?? []).map((b) => b.key), t),
    [models.data, t],
  );
  const totals = useMemo(() => (models.data ? usageTotals(models.data.buckets) : null), [models.data]);

  return (
    <div className="grid">
      <PageHead windows={shown} nowMs={nowMs} />

      {shown
        ? shown.map((w) => (
            <WindowCard
              key={w.window_kind}
              w={w}
              nowMs={nowMs}
              api={api}
              profileId={profileId}
              to={to}
              nonce={nonce}
              span={spans.span}
              mdSpan={spans.mdSpan}
            />
          ))
        : [0, 1, 2].map((i) => (
            <Card key={i} span={4} mdSpan={2}>
              <Placeholder state={windowsError ? "error" : "loading"} height={150} />
            </Card>
          ))}

      {/* 第二行：这段时间用了多少（左）、什么时候用的（右）—— 两张都跟着顶栏的区间走 */}
      <UsageSummary
        title={`${rangeLabel} 用量`}
        totals={totals}
        state={models.error ? "error" : "loading"}
        span={4}
        mdSpan={2}
      />
      <Card
        title="用量时间线"
        span={8}
        mdSpan={4}
        aside={
          <Segmented
            label="时间线口径"
            value={metric}
            options={[
              { value: "cost", label: "折算 $" },
              { value: "tokens", label: "tokens" },
            ]}
            onChange={setMetric}
          />
        }
      >
        {timelineOption ? (
          <Chart
            option={timelineOption}
            height={176}
            ariaLabel={metric === "cost" ? "各机器按时间的折算费用堆叠柱" : "各机器按时间的 token 堆叠柱"}
          />
        ) : (
          <Placeholder state={machineDist.error ? "error" : "loading"} height={176} />
        )}
      </Card>

      {/* 第三行：花在哪 —— 两张明细表同一个形状，并排放行数也差不多，不会一张满一张空 */}
      <BreakdownTable
        title="按模型"
        buckets={models.data?.buckets ?? null}
        colors={modelColors}
        labelOf={(b) => b.label ?? modelDisplayName(b.key)}
        state={models.error ? "error" : "loading"}
        span={6}
        mdSpan={3}
      />
      <BreakdownTable
        title="按机器"
        buckets={machineDist.data?.buckets ?? null}
        colors={machineColors}
        labelOf={machineLabel}
        state={machineDist.error ? "error" : "loading"}
        span={6}
        mdSpan={3}
      />

      <Card
        title="燃尽曲线"
        span={12}
        aside={
          windows ? (
            <Segmented
              label="燃尽曲线窗口"
              value={burnWindow?.window_kind ?? "five_hour"}
              options={burnable.map((w) => ({ value: w.window_kind, label: labelOf(w.window_kind) }))}
              onChange={setBurnKind}
            />
          ) : undefined
        }
      >
        {burnOption ? (
          <Chart
            option={burnOption}
            height={200}
            ariaLabel="燃尽曲线：已用百分比、P25–P75 预测区间与窗口边界"
          />
        ) : windows && burnable.length === 0 ? (
          <div className="btable__empty" style={{ height: 200 }}>
            <Mono tone="muted">没有正在计时的窗口</Mono>
          </div>
        ) : (
          <Placeholder state={windowsError ? "error" : "loading"} height={200} />
        )}
      </Card>
    </div>
  );
}
