import { useMemo, useState } from "react";
import type { Machine, UaApi, WindowsCurrent } from "../api";
import { bucketLabel, costSeries, costSummary, machineIndex, stackFromBuckets } from "../api/derive";
import { fmtPct } from "../charts/base";
import { burndownOption } from "../charts/burndown";
import { costTrendOption, machineStackOption, modelDonutOption } from "../charts/distribution";
import { colorMapFor } from "../charts/registry";
import type { Tokens } from "../charts/tokens";
import { Chart } from "../components/Chart";
import { Card, Cost, Mono, Placeholder, Segmented } from "../components/primitives";
import { isMeaningfulWindow, labelOf, WindowCard } from "../components/WindowCards";
import { useAsync } from "../hooks/useAsync";

interface Props {
  api: UaApi;
  t: Tokens;
  profileId: string;
  from: string;
  to: string;
  nonce: number;
  nowMs: number;
  machines: Machine[];
  windows: WindowsCurrent | null;
  windowsError: Error | null;
}

const stripClaude = (key: string): string => key.replace(/^claude-/, "");

export function Overview({
  api,
  t,
  profileId,
  from,
  to,
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

  // 二维分桶：by=machine + bucket 直接给出堆叠柱需要的 series[]
  const machineDist = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "machine", bucket }, s),
    [api, profileId, from, to, nonce],
  );
  const models = useAsync(
    // 带 bucket：同一份取数既喂模型占比环，也喂费用趋势
    (s) => api.distribution({ profile_id: profileId, from, to, by: "model", bucket }, s),
    [api, profileId, from, to, nonce],
  );

  // 展示用的窗口集合：滤掉官方那批代号占位字段，否则 12 栅格会被撑到换行
  const shown = useMemo(
    () => windows?.windows.filter(isMeaningfulWindow) ?? null,
    [windows],
  );
  const five = shown?.find((w) => w.window_kind === "five_hour") ?? shown?.[0];

  // 燃尽曲线可切窗口：projected_curve 对 7d 是日历模式（周末塌下去），
  // 只画 5h 的话这条曲线最要紧的那一半永远看不到。
  const [burnKind, setBurnKind] = useState("five_hour");
  const burnWindow =
    shown?.find((w) => w.window_kind === burnKind) ?? five;

  const burnOption = useMemo(
    () =>
      burnWindow
        ? burndownOption(
            t,
            burnWindow,
            nowMs,
            burnWindow.window_kind === "five_hour" ? "five_hour" : "long",
          )
        : null,
    [t, burnWindow, nowMs],
  );

  const machineOption = useMemo(() => {
    if (!machineDist.data) return null;
    // 取色按 bucket.key（= machine_id，与甘特图同源）；label 只用于显示，
    // bucket.label 缺省时拿 /v1/machines 的名册补一个比 UUID 好看的名字。
    const idx = machineIndex(machines);
    const series = stackFromBuckets(machineDist.data.buckets, (b) => bucketLabel(b, idx.label));
    const colors = colorMapFor("machine", series.map((s) => s.key), t);
    return machineStackOption(t, series, colors, bucket);
  }, [t, machineDist.data, machines, bucket]);

  const costOption = useMemo(() => {
    if (!models.data) return null;
    const pts = costSeries(models.data.buckets);
    return pts.length > 0 ? costTrendOption(t, pts, bucket) : null;
  }, [t, models.data, bucket]);

  const modelOption = useMemo(() => {
    if (!models.data) return null;
    const colors = colorMapFor("model", models.data.buckets.map((b) => b.key), t);
    return modelDonutOption(t, models.data.buckets, colors, (b) => bucketLabel(b, stripClaude));
  }, [t, models.data]);

  const modelStats = useMemo(() => {
    if (!models.data) return null;
    const total = models.data.buckets.reduce((a, b) => a + b.total_tokens, 0);
    const cacheRead = models.data.buckets.reduce((a, b) => a + b.cache_read_tokens, 0);
    return {
      cachePct: total > 0 ? (cacheRead / total) * 100 : 0,
      cost: costSummary(models.data.buckets),
    };
  }, [models.data]);

  return (
    <div className="grid">
      {shown
        ? shown.map((w) => (
            <WindowCard
              key={w.window_kind}
              t={t}
              w={w}
              nowMs={nowMs}
              api={api}
              profileId={profileId}
              to={to}
              nonce={nonce}
            />
          ))
        : [0, 1, 2].map((i) => (
            <Card key={i} span={4}>
              <Placeholder state={windowsError ? "error" : "loading"} height={196} />
            </Card>
          ))}

      <Card
        title="燃尽曲线"
        span={12}
        aside={
          windows ? (
            <Segmented
              label="燃尽曲线窗口"
              value={burnWindow?.window_kind ?? "five_hour"}
              options={(shown ?? []).map((w) => ({
                value: w.window_kind,
                label: labelOf(w.window_kind),
              }))}
              onChange={setBurnKind}
            />
          ) : undefined
        }
      >
        {burnOption ? (
          <Chart
            option={burnOption}
            height={240}
            ariaLabel="燃尽曲线：已用百分比、P25–P75 预测区间、限额线与窗口边界"
          />
        ) : (
          <Placeholder state={windowsError ? "error" : "loading"} height={240} />
        )}
      </Card>

      <Card
        title="折算 API 费用"
        span={12}
        aside={
          modelStats ? (
            <span className="aside-row">
              <Mono tone="muted">按公开价目表折算，非实际扣费</Mono>
              <Cost usd={modelStats.cost.usd} unpriced={modelStats.cost.unpricedEvents} />
            </span>
          ) : undefined
        }
      >
        {costOption ? (
          <Chart option={costOption} height={180} ariaLabel="折算 API 费用随时间的变化" />
        ) : (
          <Placeholder state={models.error ? "error" : "loading"} height={180} />
        )}
      </Card>

      <Card title="机器分布" span={7}>
        {machineOption ? (
          <Chart option={machineOption} height={220} ariaLabel="各机器按小时的 token 消耗堆叠柱状图" />
        ) : (
          <Placeholder state={machineDist.error ? "error" : "loading"} height={220} />
        )}
      </Card>

      <Card
        title="模型占比"
        span={5}
        aside={
          modelStats ? (
            <span className="aside-row">
              <Mono tone="muted">缓存命中 {fmtPct(modelStats.cachePct)}</Mono>
              <Cost usd={modelStats.cost.usd} unpriced={modelStats.cost.unpricedEvents} />
            </span>
          ) : undefined
        }
      >
        {modelOption ? (
          <Chart option={modelOption} height={220} ariaLabel="各模型 token 占比环形图" />
        ) : (
          <Placeholder state={models.error ? "error" : "loading"} height={220} />
        )}
      </Card>
    </div>
  );
}
