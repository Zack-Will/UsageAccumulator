import { useMemo } from "react";
import type { WindowState } from "../api";
import { fmtClock, fmtDuration } from "../charts/base";
import { ringOption, ringTone } from "../charts/rings";
import type { Tokens } from "../charts/tokens";
import { Chart } from "./Chart";
import { Card, Mono, Num } from "./primitives";

/**
 * CONTRACT §1.3 说 window_kind 是自由字符串；§2.2 的菜单栏摘要用 "5h" / "7d" / "7d Fable"
 * 三个标签。看板沿用同一套标签，未知 kind 直接回落到原值。
 *
 * ARCHITECTURE §2.2：官方响应里第三个窗口的字段名是 `seven_day_opus`，但实际受独立
 * 周限额约束的是 Fable。两个 kind 都映射到同一个展示标签，抓包确认后不必改前端。
 */
export const WINDOW_LABEL: Record<string, string> = {
  five_hour: "5h 窗口",
  seven_day: "7d 窗口",
  seven_day_opus: "7d Fable",
  seven_day_fable: "7d Fable",
};

export const labelOf = (kind: string): string => WINDOW_LABEL[kind] ?? kind;

export function WindowCard({ t, w }: { t: Tokens; w: WindowState }) {
  const tone = ringTone(w.utilization_pct, w.projected_pct.mid);
  const option = useMemo(
    () => ringOption(t, { used: w.utilization_pct, projected: w.projected_pct.mid, tone }),
    [t, w.utilization_pct, w.projected_pct.mid, tone],
  );
  const label = labelOf(w.window_kind);

  return (
    <Card title={label} span={3} tone={tone === "ok" ? "plain" : tone}>
      <div className="ring">
        <Chart
          option={option}
          height={132}
          ariaLabel={`${label} 已用 ${w.utilization_pct.toFixed(0)}%，预计 ${w.projected_pct.mid.toFixed(0)}%`}
        />
        <div className="ring__center">
          <Num value={w.utilization_pct} digits={0} suffix="%" size="xl" tone={tone} />
        </div>
      </div>
      <div className="ring__foot">
        <span>
          <Mono tone="muted">预计 </Mono>
          <Num value={w.projected_pct.mid} digits={0} suffix="%" size="sm" />
          <Mono tone="muted">
            {" "}
            ±{Math.round((w.projected_pct.p75 - w.projected_pct.p25) / 2)}
          </Mono>
        </span>
        <Mono tone="muted">{fmtClock(Date.parse(w.resets_at))}</Mono>
      </div>
    </Card>
  );
}

export function EtaCard({ w, nowMs }: { w: WindowState; nowMs: number }) {
  const etaMs = w.exhaust_eta ? Date.parse(w.exhaust_eta) : null;
  const remain = etaMs ? etaMs - nowMs : null;
  const tone = remain !== null && remain < 45 * 60_000 ? "danger" : remain !== null ? "warn" : "plain";

  return (
    <Card title="5h 耗尽 ETA" span={3} tone={tone === "plain" ? "plain" : tone}>
      <div className="eta">
        <span className={`num num--xl${tone === "danger" ? " num--danger" : tone === "warn" ? " num--warn" : ""}`}>
          {remain !== null ? fmtDuration(remain) : "—"}
        </span>
        <Mono tone="muted">
          {etaMs !== null ? fmtClock(etaMs) : "本窗口不会耗尽"}
          {" · "}
          {w.rate_pct_per_min.toFixed(2)} %/min
        </Mono>
      </div>
    </Card>
  );
}

export function Metric({
  title,
  value,
  digits = 1,
  suffix,
  sub,
  tone,
  span = 3,
}: {
  title: string;
  value: number;
  digits?: number;
  suffix?: string;
  sub?: string;
  tone?: "ok" | "warn" | "danger" | "muted";
  span?: number;
}) {
  return (
    <Card title={title} span={span}>
      <div className="metric">
        <Num value={value} digits={digits} suffix={suffix} size="lg" tone={tone} />
        {sub && <span className="metric__sub">{sub}</span>}
      </div>
    </Card>
  );
}
