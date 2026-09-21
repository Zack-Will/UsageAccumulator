import { useMemo, useState } from "react";
import type { Machine, UaApi, WindowsCurrent } from "../api";
import { bucketLabel, costSummary, machineIndex, stackFromBuckets } from "../api/derive";
import { fmtPct } from "../charts/base";
import { burndownOption } from "../charts/burndown";
import { machineStackOption, modelDonutOption } from "../charts/distribution";
import { colorMapFor } from "../charts/registry";
import type { Tokens } from "../charts/tokens";
import { Chart } from "../components/Chart";
import { Card, Cost, Mono, Placeholder, Segmented } from "../components/primitives";
import { EtaCard, labelOf, WindowCard } from "../components/WindowCards";
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
  // 二维分桶：by=machine + bucket=hour 直接给出「24 小时堆叠柱」需要的 series[]
  const machineDist = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "machine", bucket: "hour" }, s),
    [api, profileId, from, to, nonce],
  );
  const models = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "model" }, s),
    [api, profileId, from, to, nonce],
  );

  const five = windows?.windows.find((w) => w.window_kind === "five_hour") ?? windows?.windows[0];

  // 燃尽曲线可切窗口：projected_curve 对 7d 是日历模式（周末塌下去），
  // 只画 5h 的话这条曲线最要紧的那一半永远看不到。
  const [burnKind, setBurnKind] = useState("five_hour");
  const burnWindow =
    windows?.windows.find((w) => w.window_kind === burnKind) ?? five;

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
    return machineStackOption(t, series, colors);
  }, [t, machineDist.data, machines]);

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
      {windows
        ? windows.windows.map((w) => <WindowCard key={w.window_kind} t={t} w={w} />)
        : [0, 1, 2].map((i) => (
            <Card key={i} span={3}>
              <Placeholder state={windowsError ? "error" : "loading"} height={166} />
            </Card>
          ))}

      {five ? (
        <EtaCard w={five} nowMs={nowMs} />
      ) : (
        <Card span={3}>
          <Placeholder state={windowsError ? "error" : "loading"} height={166} />
        </Card>
      )}

      <Card
        title="燃尽曲线"
        span={12}
        aside={
          windows ? (
            <Segmented
              label="燃尽曲线窗口"
              value={burnWindow?.window_kind ?? "five_hour"}
              options={windows.windows.map((w) => ({
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
