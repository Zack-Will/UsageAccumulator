import { useMemo, useState } from "react";
import type { UaApi, WindowsCurrent } from "../api";
import { costSummary } from "../api/derive";
import { fmtTokens, msOf } from "../charts/base";
import { weeklyQuotaOption } from "../charts/weekly";
import type { Tokens } from "../charts/tokens";
import { Chart } from "../components/Chart";
import { Card, Cost, Mono, Num, Placeholder, Segmented } from "../components/primitives";
import { useAsync } from "../hooks/useAsync";
import { colorMapFor } from "../charts/registry";
import { BreakdownTable } from "../components/UsagePanels";

const WEEK_MS = 7 * 24 * 3600_000;
/** 往回看多少周 */
const WEEKS_BACK = 8;

interface Props {
  api: UaApi;
  t: Tokens;
  profileId: string;
  nonce: number;
  windows: WindowsCurrent | null;
}

interface Week {
  startMs: number;
  endMs: number;
  label: string;
}

const md = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * 周边界。
 *
 * ★ 锚点取服务端给的 seven_day 窗口的 resets_at，再按 7 天整步往回推，
 * 而不是自己算「周二 07:00」。这个号的周限确实固定在周二早七点（实测
 * resets_at = 周一 23:00 UTC = 周二 07:00 北京），但把它写死在前端，
 * 官方哪天调了时间就会整页错位而没有任何报错。锚在真实数据上则自动跟随。
 */
function buildWeeks(windows: WindowsCurrent | null): Week[] {
  const seven = windows?.windows.find((w) => w.window_kind === "seven_day");
  // 周窗口理论上一直在计时，但万一官方给了 null（空闲），宁可不画也不要锚在 NaN 上
  const anchor = seven ? msOf(seven.resets_at) : NaN;
  if (!Number.isFinite(anchor)) return [];
  const out: Week[] = [];
  for (let k = 0; k < WEEKS_BACK; k++) {
    const endMs = anchor - k * WEEK_MS;
    const startMs = endMs - WEEK_MS;
    out.push({
      startMs,
      endMs,
      label: k === 0 ? "本周" : `${md(startMs)}–${md(endMs)}`,
    });
  }
  return out;
}

export function Weeks({ api, t, profileId, nonce, windows }: Props) {
  const weeks = useMemo(() => buildWeeks(windows), [windows]);
  const [idx, setIdx] = useState(0);
  const week = weeks[Math.min(idx, Math.max(0, weeks.length - 1))];

  const fromIso = week ? new Date(week.startMs).toISOString() : "";
  const toIso = week ? new Date(week.endMs).toISOString() : "";

  const quota = useAsync(
    (s) =>
      week
        ? api.quotaHistory({ profile_id: profileId, from: fromIso, to: toIso, window_kind: "seven_day" }, s)
        : Promise.resolve(null),
    [api, profileId, fromIso, toIso, nonce],
  );

  const usage = useAsync(
    (s) =>
      week
        ? api.distribution({ profile_id: profileId, from: fromIso, to: toIso, by: "model" }, s)
        : Promise.resolve(null),
    [api, profileId, fromIso, toIso, nonce],
  );

  const byMachine = useAsync(
    (s) =>
      week
        ? api.distribution({ profile_id: profileId, from: fromIso, to: toIso, by: "machine" }, s)
        : Promise.resolve(null),
    [api, profileId, fromIso, toIso, nonce],
  );
  const machineColors = useMemo(
    () => colorMapFor("machine", (byMachine.data?.buckets ?? []).map((b) => b.key), t),
    [byMachine.data, t],
  );

  const cost = usage.data ? costSummary(usage.data.buckets) : null;
  const tokens = usage.data ? usage.data.buckets.reduce((a, b) => a + b.total_tokens, 0) : 0;
  const events = usage.data ? usage.data.buckets.reduce((a, b) => a + b.events, 0) : 0;

  // 这一周结束时（或最后一次采样时）的已用百分比
  const endPct = useMemo(() => {
    const ss = quota.data?.samples ?? [];
    return ss.length > 0 ? (ss[ss.length - 1]?.utilization_pct ?? null) : null;
  }, [quota.data]);

  /**
   * 周限额的美元等价：把这一周花掉的钱按已用百分比外推到 100%。
   * 百分比太低时不给 —— 5% 外推 20 倍，几条请求的抖动就能差出一个数量级。
   */
  const fullWeekCost =
    cost?.usd != null && endPct !== null && endPct >= 5 ? cost.usd / (endPct / 100) : null;

  const curve = useMemo(
    () =>
      quota.data && week
        ? weeklyQuotaOption(t, quota.data.samples, week.startMs, week.endMs)
        : null,
    [t, quota.data, week],
  );

  if (weeks.length === 0) {
    return (
      <div className="grid">
        <Card title="周历史" span={12}>
          <Placeholder state="loading" height={200} />
        </Card>
      </div>
    );
  }

  return (
    <div className="grid">
      <Card
        title="周额度曲线"
        span={12}
        aside={
          <Segmented
            label="选择周"
            value={String(idx)}
            options={weeks.map((w, i) => ({ value: String(i), label: w.label }))}
            onChange={(v) => setIdx(Number(v))}
          />
        }
      >
        {curve ? (
          <Chart option={curve} height={220} ariaLabel="本周额度百分比随时间的变化" />
        ) : (
          <Placeholder state={quota.error ? "error" : "loading"} height={220} />
        )}
      </Card>

      <Card title="这一周用了多少" span={5}>
        <div className="weekstat">
          <div className="weekstat__row">
            <Mono tone="muted">已用额度</Mono>
            {endPct !== null ? <Num value={endPct} digits={0} suffix="%" size="lg" /> : <Mono tone="muted">—</Mono>}
          </div>
          <div className="weekstat__row">
            <Mono tone="muted">折算费用</Mono>
            {cost ? <Cost usd={cost.usd} unpriced={cost.unpricedEvents} /> : <Mono tone="muted">—</Mono>}
          </div>
          <div className="weekstat__row">
            <Mono tone="muted">调用 / tokens</Mono>
            <Mono>
              {events.toLocaleString("en-US")} 次 · {fmtTokens(tokens)}
            </Mono>
          </div>
          <div className="weekstat__row">
            <Mono tone="muted">周限额约</Mono>
            <Mono>{fullWeekCost !== null ? `$${fullWeekCost.toFixed(0)}` : "—"}</Mono>
          </div>
        </div>
      </Card>

      {/* 与总览的「按机器」同一张表：以前这里套用归属列表的四列模板却只放了三个元素，
          主机名落进了 10px 的色点列，被挤得折成两行 */}
      <BreakdownTable
        title="这一周各机器"
        buckets={byMachine.data?.buckets ?? null}
        colors={machineColors}
        labelOf={(b) => b.label ?? b.key}
        state={byMachine.error ? "error" : "loading"}
        span={7}
        mdSpan={3}
        emptyText="这一周没有用量"
      />
    </div>
  );
}
