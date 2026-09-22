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

/**
 * window_kind 里编码的模型家族；null = 该窗口覆盖所有模型。
 *
 * `seven_day_fable` 是**只约束 Fable** 的独立周限额，它的用量与费用必须只算
 * Fable —— 否则这张卡会和「7d 全部模型」显示完全相同的数字，等于白占一张卡。
 * `seven_day_scoped` 是拿不到模型名时的兜底 kind，没有家族可依，不做过滤。
 */
export function windowModelFamily(kind: string): string | null {
  const m = /^seven_day_(.+)$/.exec(kind);
  if (!m?.[1]) return null;
  const fam = m[1].toLowerCase();
  return fam === "scoped" ? null : fam;
}

/** 模型名是否属于某家族。先剥掉 `claude-` 前缀，再比家族名。 */
function modelInFamily(model: string, family: string): boolean {
  const m = model.trim().toLowerCase().replace(/^claude[-.]/, "");
  return m === family || m.startsWith(`${family}-`) || m.startsWith(`${family}.`);
}

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
  // 按模型分桶后再按窗口的家族过滤：7d Fable 只该算 Fable 的量
  const family = windowModelFamily(w.window_kind);
  const buckets = useMemo(() => {
    const all = spend.data?.buckets ?? null;
    if (!all) return null;
    return family ? all.filter((b) => modelInFamily(b.key, family)) : all;
  }, [spend.data, family]);

  const cost = buckets ? costSummary(buckets) : null;
  const events = buckets ? buckets.reduce((a, b) => a + b.events, 0) : 0;
  const tokens = buckets ? buckets.reduce((a, b) => a + b.total_tokens, 0) : 0;

  /**
   * 这个窗口**打满**值多少钱。
   *
   * 把已花的钱按「已用百分比」外推到 100%：$已花 ÷ (pct/100)。
   * 7d 窗口上这个数就是周限额的美元等价 —— 它回答「我这个订阅一周能换多少 API 额度」，
   * 而不是「按当前速率我会花多少」。后者是另一个问题，由燃尽曲线回答。
   *
   * 用量太低时不给：1% 意味着放大 100 倍，几条请求的抖动就能让结果差出一个数量级。
   */
  const MIN_PCT_FOR_FULL = 5;
  const fullWindowCost =
    cost?.usd != null && w.utilization_pct >= MIN_PCT_FOR_FULL
      ? cost.usd / (w.utilization_pct / 100)
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
          <Mono tone="muted">已用 </Mono>
          {/* 过滤后一个桶都不剩 = 这个家族本窗口确实没用过，是 $0 而不是「未知」 */}
          {buckets === null ? (
            <Mono tone="muted">—</Mono>
          ) : (
            <Cost usd={buckets.length === 0 ? 0 : cost!.usd} unpriced={cost?.unpricedEvents ?? 0} />
          )}
          <Mono tone="muted">
            {" "}
            · {events.toLocaleString("en-US")} 次请求 · {fmtTokens(tokens)} tokens
          </Mono>
        </span>
        <Mono tone="muted">
          满额约 {fullWindowCost !== null ? `$${fullWindowCost.toFixed(0)}` : "—"}
        </Mono>
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
