import { useMemo } from "react";
import type { UaApi, WindowState } from "../api";
import { costSummary } from "../api/derive";
import { fmtClock, fmtDuration, fmtTokens } from "../charts/base";
import { ringOption, ringTone } from "../charts/rings";
import type { Tokens } from "../charts/tokens";
import { useAsync } from "../hooks/useAsync";
import { Chart } from "./Chart";
import { Card, Cost, Mono, Num } from "./primitives";

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

/**
 * 哪些窗口值得展示。
 *
 * 官方响应里有一批代号占位字段（nimbus_quill / amber_gauge / juniper_tide…），
 * 探针刻意「不认识也原样带出」以防字段改名 —— 那是**存储**的策略。
 * 展示层必须自己筛：没有重置时刻又零用量的东西，进 UI 只会是噪音，
 * 还会把 12 栅格撑到换行。判据与菜单栏的 isMeaningful 一致。
 */
export const isMeaningfulWindow = (w: WindowState): boolean =>
  Number.isFinite(Date.parse(w.resets_at)) || w.utilization_pct > 0;

export function WindowCard({
  t,
  w,
  nowMs,
  api,
  profileId,
  to,
  nonce,
}: {
  t: Tokens;
  w: WindowState;
  nowMs: number;
  api: UaApi;
  profileId: string;
  /** 页面的区间右端（≈现在）。用它而不是 nowMs 当依赖，否则每秒都会重新取数。 */
  to: string;
  nonce: number;
}) {
  const tone = ringTone(w.utilization_pct, w.projected_pct.mid);
  // 预计值单独取色：它才是「会不会超」的答案，已用量只是现状
  const projTone = w.projected_pct.mid >= 100 ? "danger" : w.projected_pct.mid >= 90 ? "warn" : undefined;
  const etaMs = w.exhaust_eta ? Date.parse(w.exhaust_eta) : NaN;
  const remain = Number.isFinite(etaMs) ? etaMs - nowMs : null;
  const option = useMemo(
    () => ringOption(t, { used: w.utilization_pct, projected: w.projected_pct.mid, tone }),
    [t, w.utilization_pct, w.projected_pct.mid, tone],
  );
  const label = labelOf(w.window_kind);

  /**
   * 本窗口内的折算 API 费用。
   *
   * 官方只给百分比，不给金额；这里是**按公开价目表把本窗口的 token 折算成
   * 等价 API 费用**，不是实际扣费（订阅制下实际扣的是固定月费）。
   * 取数区间是窗口自己的 starts_at → 现在，与百分比同一段时间。
   */
  const spend = useAsync(
    (sig) => api.distribution({ profile_id: profileId, from: w.starts_at, to, by: "model" }, sig),
    [api, profileId, w.starts_at, to, nonce],
  );
  const cost = spend.data ? costSummary(spend.data.buckets) : null;
  const events = spend.data ? spend.data.buckets.reduce((a, b) => a + b.events, 0) : 0;
  const tokens = spend.data ? spend.data.buckets.reduce((a, b) => a + b.total_tokens, 0) : 0;

  // 窗口已过去的比例 —— 用它把已发生的费用线性外推到窗口结束
  const startMs = Date.parse(w.starts_at);
  const endMs = Date.parse(w.resets_at);
  const elapsed =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)))
      : null;
  const projectedCost =
    cost?.usd !== null && cost !== null && elapsed !== null && elapsed > 0.02
      ? cost.usd / elapsed
      : null;

  return (
    <Card title={label} span={4} tone={tone === "ok" ? "plain" : tone}>
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
          <Mono tone="muted">重置时预计 </Mono>
          <Num value={w.projected_pct.mid} digits={0} suffix="%" size="sm" tone={projTone} />
          <Mono tone="muted">
            {" "}
            ±{Math.round((w.projected_pct.p75 - w.projected_pct.p25) / 2)}
          </Mono>
        </span>
        <Mono tone="muted">{fmtClock(Date.parse(w.resets_at))} 重置</Mono>
      </div>
      {/* 折算费用：官方只给百分比，金额是按价目表折的等价成本，不是实际扣费 */}
      <div className="ring__cost">
        <span className="ring__cost-main">
          {cost ? <Cost usd={cost.usd} unpriced={cost.unpricedEvents} /> : <Mono tone="muted">—</Mono>}
          <Mono tone="muted">
            {" "}
            · {events.toLocaleString("en-US")} 次 · {fmtTokens(tokens)}
          </Mono>
        </span>
        {projectedCost !== null && (
          <Mono tone="muted">重置时预计 ${projectedCost.toFixed(2)}</Mono>
        )}
      </div>

      {/* 耗尽倒计时并进本卡，不再单独占一张 —— 它本来就是某个窗口的属性 */}
      <div className="ring__eta">
        {remain !== null ? (
          <Mono tone={remain < 45 * 60_000 ? "danger" : "warn"}>
            {fmtDuration(remain)} 后耗尽 · {fmtClock(etaMs)}
          </Mono>
        ) : (
          <Mono tone="muted">本窗口不会耗尽 · {w.rate_pct_per_min.toFixed(2)} %/min</Mono>
        )}
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
