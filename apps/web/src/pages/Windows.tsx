import { useMemo } from "react";
import type { CalibrationEntry, UaApi, WindowsCurrent } from "../api";
import { fmtPct, fmtTokens } from "../charts/base";
import { calibrationScatterOption } from "../charts/calibration";
import { ganttOption } from "../charts/gantt";
import { colorFor, colorMapFor } from "../charts/registry";
import { status, type Tokens } from "../charts/tokens";
import { Chart } from "../components/Chart";
import { Card, KeyValue, Mono, Placeholder } from "../components/primitives";
import { Metric } from "../components/WindowCards";
import { useAsync } from "../hooks/useAsync";

interface Props {
  api: UaApi;
  t: Tokens;
  profileId: string;
  from: string;
  to: string;
  nonce: number;
  nowMs: number;
  windows: WindowsCurrent | null;
  windowsError: Error | null;
}

function WeightBars({ entry, t }: { entry: CalibrationEntry; t: Tokens }) {
  const rows = Object.entries(entry.weights).sort((a, b) => b[1] - a[1]);
  const max = rows.reduce((a, [, w]) => Math.max(a, w), 0) || 1;
  return (
    <div className="bars">
      {rows.map(([model, weight]) => (
        <div className="bar__row" key={model}>
          <span className="bar__label" title={model}>
            {model.replace(/^claude-/, "")}
            {model === entry.base_model && <span className="bar__base"> ·1</span>}
          </span>
          <span className="bar__track">
            <span
              className="bar__fill"
              style={{ width: `${(weight / max) * 100}%`, background: colorFor("model", model, t) }}
            />
          </span>
          <span className="bar__value">{weight.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

export function Windows({ api, t, profileId, from, to, nonce, nowMs, windows, windowsError }: Props) {
  const timeline = useAsync(
    (s) => api.timeline({ profile_id: profileId, from, to }, s),
    [api, profileId, from, to, nonce],
  );
  const cal = useAsync((s) => api.calibration(profileId, s), [api, profileId, nonce]);

  const s = useMemo(() => status(t), [t]);

  const gantt = useMemo(() => {
    if (!timeline.data) return null;
    // CONTRACT §2.1a：色板按 machine_id 登记 —— 它跨端点一致且稳定，
    // 而 machine_label 是展示文案，主机改名就会变，拿它取色会让颜色满图乱跳。
    const colors = colorMapFor("machine", timeline.data.lanes.map((l) => l.machine_id), t);
    return ganttOption(t, timeline.data, (id) => colors.get(id) ?? t.cat1, s.danger, nowMs);
  }, [t, timeline.data, s.danger, nowMs]);

  // CONTRACT §2.1a：calibrations 为空 = 观测点不够 → 标定中，退回百分比口径。
  const entry =
    cal.data?.calibrations.find((c) => c.window_kind === "five_hour") ?? cal.data?.calibrations[0];

  const scatter = useMemo(
    () => (entry && entry.points.length > 0 ? calibrationScatterOption(t, entry.points, entry.residual) : null),
    [t, entry],
  );

  /**
   * 四个重叠度指标取 /v1/windows/current 的 metrics（CONTRACT §2.1）：
   * 那份定义用的是统一后的 `_pct` 口径，而且随 SSE 实时更新。
   */
  const m = (windows?.windows.find((w) => w.window_kind === "five_hour") ?? windows?.windows[0])
    ?.metrics;
  const laneCount = timeline.data?.lanes.length ?? 4;

  return (
    <div className="grid">
      {m ? (
        <>
          <Metric
            title="窗口偏移"
            value={m.local_window_offset_min}
            digits={0}
            suffix=" min"
            tone={Math.abs(m.local_window_offset_min) > 5 ? "warn" : undefined}
          />
          <Metric
            title="多机重叠度"
            value={m.multi_machine_overlap_pct}
            suffix="%"
            tone={m.multi_machine_overlap_pct > 30 ? "warn" : undefined}
          />
          <Metric
            title="会话切断率"
            value={m.session_cut_rate_pct}
            suffix="%"
            tone={m.session_cut_rate_pct > 25 ? "warn" : undefined}
          />
          <Metric title="窗口浪费度" value={m.window_waste_pct} suffix="%" />
        </>
      ) : (
        [0, 1, 2, 3].map((i) => (
          <Card key={i} span={3}>
            <Placeholder state={windowsError ? "error" : "loading"} height={54} />
          </Card>
        ))
      )}

      <Card title="窗口时间轴" span={12}>
        {gantt ? (
          <Chart
            option={gantt}
            height={Math.max(180, laneCount * 46 + 60)}
            ariaLabel="窗口时间轴甘特图：每台机器一条泳道，色块深浅表示消耗强度，红色块表示多机重叠"
          />
        ) : (
          <Placeholder state={timeline.error ? "error" : "loading"} height={220} />
        )}
      </Card>

      <Card
        title="限额标定"
        span={12}
        aside={
          cal.data ? (
            <Mono tone={entry?.converged ? undefined : "warn"}>
              {!entry ? "标定中" : entry.converged ? "已标定" : "未收敛"}
            </Mono>
          ) : undefined
        }
      >
        {!cal.data && !cal.error ? (
          <Placeholder state="loading" height={180} />
        ) : cal.error ? (
          <Placeholder state="error" height={180} />
        ) : entry ? (
          <div className="split">
            <KeyValue
              items={[
                { k: `限额 · ${entry.window_kind}`, v: fmtTokens(entry.limit_weighted_tokens) },
                {
                  k: "残差范围",
                  v: `${fmtTokens(entry.limit_weighted_tokens * (1 - entry.residual))} – ${fmtTokens(
                    entry.limit_weighted_tokens * (1 + entry.residual),
                  )}`,
                },
                { k: "观测点", v: String(entry.observations) },
                { k: "残差", v: fmtPct(entry.residual * 100) },
                { k: "基准模型", v: entry.base_model.replace(/^claude-/, "") },
              ]}
            />
            <WeightBars entry={entry} t={t} />
            {scatter ? (
              <Chart
                option={scatter}
                height={180}
                ariaLabel="标定拟合散点：横轴加权 token，纵轴官方 Δ 百分比，虚线为拟合线"
              />
            ) : (
              <Placeholder state="loading" height={180} />
            )}
          </div>
        ) : (
          // 观测点不够：只说状态，不给假数字
          <div className="metric">
            <span className="num num--lg num--muted">标定中</span>
          </div>
        )}
      </Card>
    </div>
  );
}
