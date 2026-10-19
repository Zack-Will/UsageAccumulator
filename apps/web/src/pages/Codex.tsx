import { useMemo, useState } from "react";
import type {
  CodexAccount,
  CodexAggregate,
  CodexCollector,
  CodexPeriodRecord,
  CodexQuotaResponse,
  CodexQuotaWindow,
  CodexResetCredits,
  CodexSessionStatus,
  CodexUsageBy,
  CodexWindowAnalysis,
  UaApi,
} from "../api";
import {
  codexBucket,
  codexBuckets,
  codexTopSpans,
  type Span,
  codexDaySeries,
  codexPace,
  codexWindowTitle,
  collectorName,
  collectorStateLabel,
  collectorTone,
  earliestCreditExpiry,
  fmtCumulative,
  localDayTicks,
  longPeriods,
  periodWasReset,
  sortCodexWindows,
} from "../api/codex";
import { usageTotals, type UsageMetric } from "../api/derive";
import { fmtClock, fmtDay, fmtTokens, fmtUntil, fmtWhen, msOf } from "../charts/base";
import { codexBurnOption } from "../charts/codex";
import { usageTimelineOption } from "../charts/distribution";
import { colorMapFor } from "../charts/registry";
import { ringTone } from "../charts/rings";
import type { Tokens } from "../charts/tokens";
import { Chart } from "../components/Chart";
import { Card, Cost, Dot, Mono, Num, Placeholder, Segmented } from "../components/primitives";
import { BreakdownTable, UsageSummary } from "../components/UsagePanels";
import { QuotaBar } from "../components/WindowCards";
import { useAsync, type AsyncState } from "../hooks/useAsync";

/** 按天的桶要和浏览器的本地日期对上：请求时把这个时区交给服务端 */
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** 悬停说明「不完整」从哪来；只列有的项 */
function coverageNote(a: CodexAggregate, warnings: number): string | undefined {
  const parts = [
    ...(a.incomplete_events > 0 ? [`${a.incomplete_events} 个事件前后有缺口`] : []),
    ...(warnings > 0 ? [`采集时扣留了 ${warnings} 条记录`] : []),
  ];
  return a.usage_complete ? undefined : parts.join("，") || "覆盖不完整";
}

interface CoreProps {
  api: UaApi;
  t: Tokens;
  core: CodexCore;
  from: string;
  to: string;
  nonce: number;
  nowMs: number;
}

/**
 * 三个选项卡共用的那部分：账号、额度（含期/段分析）、服务端登录状态、采集器。
 * App 层取一次 —— 顶栏的同步按钮也要用额度快照时刻与登录状态。
 */
export interface CodexCore {
  accounts: AsyncState<CodexAccount[]>;
  account: CodexAccount | null;
  quota: AsyncState<CodexQuotaResponse | null>;
  session: AsyncState<CodexSessionStatus | null>;
  collectors: AsyncState<CodexCollector[] | null>;
}

export function useCodexCore(api: UaApi, enabled: boolean, nonce: number, sessionTick: number): CodexCore {
  const accounts = useAsync((s) => (enabled ? api.codexAccounts(s) : Promise.resolve([])), [api, enabled, nonce]);
  const account = enabled ? (accounts.data?.[0] ?? null) : null;
  const accountId = account?.account_id ?? null;
  const session = useAsync(
    (s): Promise<CodexSessionStatus | null> => (enabled ? api.codexSession(s) : Promise.resolve(null)),
    [api, enabled, nonce, sessionTick],
  );
  const quota = useAsync(
    (s) => (accountId ? api.codexQuota(accountId, s) : Promise.resolve(null)),
    [api, accountId, nonce, sessionTick],
  );
  const collectors = useAsync(
    (s) => (accountId ? api.codexCollectors(accountId, s) : Promise.resolve(null)),
    [api, accountId, nonce, sessionTick],
  );
  return { accounts, account, quota, session, collectors };
}

/** 服务端还没收到过任何 Codex 数据：登录入口在顶栏的同步按钮 */
function notConnected(core: CodexCore): boolean {
  return Boolean(core.accounts.data && core.accounts.data.length === 0);
}

function NotConnected() {
  return (
    <div className="grid">
      <Card title="Codex" span={12}>
        <div className="btable__empty">
          <Mono tone="muted">未接入</Mono>
        </div>
      </Card>
    </div>
  );
}

function useCodexUsage(api: UaApi, core: CodexCore, by: CodexUsageBy, from: string, to: string, nonce: number) {
  const accountId = core.account?.account_id ?? null;
  return useAsync(
    (s) => (accountId ? api.codexUsage({ account_id: accountId, from, to, by, timezone: TIME_ZONE }, s) : Promise.resolve(null)),
    [api, accountId, by, from, to, nonce],
  );
}

/** 总览：额度、燃尽与重置券、区间用量与时间线、按模型、采集器 */
export function CodexOverview({ api, t, core, from, to, rangeLabel, nonce, nowMs }: CoreProps & { rangeLabel: string }) {
  const byDay = useCodexUsage(api, core, "day", from, to, nonce);
  const byModel = useCodexUsage(api, core, "model", from, to, nonce);

  const [metric, setMetric] = useState<UsageMetric>("cost");
  const timeline = useMemo(() => {
    if (!byDay.data) return null;
    const ticks = localDayTicks(Date.parse(from), Date.parse(to));
    const series = codexDaySeries(byDay.data.buckets, ticks, metric, "Codex");
    return usageTimelineOption(t, ticks, series, new Map([["codex", t.cat1]]), "day", metric);
  }, [t, byDay.data, from, to, metric]);

  const modelBuckets = useMemo(() => (byModel.data ? codexBuckets(byModel.data.buckets) : null), [byModel.data]);
  const modelColors = useMemo(() => colorMapFor("model", (modelBuckets ?? []).map((b) => b.key), t), [modelBuckets, t]);
  // 汇总读服务端的 totals，不自己把桶加起来：totals 才带账户级的完整性判断
  const totalsData = byModel.data?.totals ?? null;
  const totals = useMemo(() => (totalsData ? usageTotals([codexBucket("total", totalsData)]) : null), [totalsData]);
  const warnings = (core.collectors.data ?? []).reduce((n, c) => n + c.parse_warnings_total, 0);
  const failed = Boolean(core.accounts.error);
  const quota = core.quota;

  // 第一行：额度窗口 · 区间用量 · 重置券；第二行：燃尽 · 用量时间线；第三行：按模型 · 采集器
  const top = codexTopSpans(quota.data?.snapshot?.windows.length ?? 1);

  if (notConnected(core)) return <NotConnected />;
  return (
    <div className="grid">
      <QuotaRow quota={quota.data} failed={Boolean(quota.error) || failed} nowMs={nowMs} span={top.window} />
      <UsageSummary
        title={`${rangeLabel} 用量`}
        totals={totals}
        state={byModel.error || failed ? "error" : "loading"}
        span={top.summary.span}
        mdSpan={top.summary.mdSpan}
        incomplete={totalsData ? coverageNote(totalsData, warnings) : undefined}
      />
      <CreditsCard credits={quota.data?.snapshot?.reset_credits} loading={!quota.data} nowMs={nowMs} span={top.credits} />

      <BurnCard
        analyses={quota.data?.analysis ?? []}
        windows={quota.data?.snapshot?.windows ?? []}
        t={t}
        nowMs={nowMs}
        failed={Boolean(quota.error) || failed}
        loading={!quota.data}
      />
      <Card
        title="用量时间线"
        span={6}
        mdSpan={3}
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
        {timeline ? (
          <Chart option={timeline} height={200} ariaLabel={metric === "cost" ? "Codex 按天的折算费用" : "Codex 按天的 token 用量"} />
        ) : (
          <Placeholder state={byDay.error || failed ? "error" : "loading"} height={200} />
        )}
      </Card>

      <BreakdownTable
        title="按模型"
        buckets={modelBuckets}
        colors={modelColors}
        labelOf={(b) => b.key}
        state={byModel.error || failed ? "error" : "loading"}
        span={8}
        mdSpan={4}
      />
      <CollectorsCard
        collectors={core.collectors.data ?? null}
        failed={Boolean(core.collectors.error) || failed}
        plan={core.account?.plan_type ?? null}
        nowMs={nowMs}
        span={4}
      />
    </div>
  );
}

/** 周历史：本周（最长那个窗口的当前一期）的燃尽与小结，以及逐期列表 */
export function CodexWeeks({ api, t, core, nonce, nowMs }: Pick<CoreProps, "api" | "t" | "core" | "nonce" | "nowMs">) {
  const accountId = core.account?.account_id ?? null;
  const periods = useAsync(
    (s) => (accountId ? api.codexPeriods({ account_id: accountId, weeks: 8, timezone: TIME_ZONE }, s) : Promise.resolve(null)),
    [api, accountId, nonce],
  );
  // 「本周」= 时长最长的那个窗口（通常是 7d）的当前一期
  const week = useMemo(() => {
    const all = core.quota.data?.analysis ?? [];
    return [...all].sort((a, b) => (b.period.duration_minutes ?? 0) - (a.period.duration_minutes ?? 0))[0] ?? null;
  }, [core.quota.data]);
  const burn = useMemo(() => (week && week.period.samples.length > 0 ? codexBurnOption(t, week, nowMs) : null), [t, week, nowMs]);
  const failed = Boolean(core.accounts.error);

  if (notConnected(core)) return <NotConnected />;
  const p = week?.period ?? null;
  const usage = week?.local_usage ?? null;
  const full = week?.full_cost ?? null;
  return (
    <div className="grid">
      <Card title="本周燃尽" span={7} mdSpan={4}>
        {burn ? (
          <Chart option={burn} height={220} ariaLabel="本周已用与预计，竖线为官方重置" />
        ) : (
          <Placeholder state={core.quota.error || failed ? "error" : "loading"} height={220} />
        )}
      </Card>

      <Card title="这一周用了多少" span={5} mdSpan={2}>
        {p ? (
          <div className="weekstat">
            <div className="weekstat__row" title={p.has_gap ? "采样有断档，累计是下界" : undefined}>
              <Mono tone="muted">本期累计</Mono>
              <span className="num num--lg">{fmtCumulative(p)}</span>
            </div>
            <div className="weekstat__row">
              <Mono tone="muted">重置时预计</Mono>
              <Num value={week!.projected_pct.mid} digits={0} suffix="%" size="md" />
            </div>
            <div className="weekstat__row">
              <Mono tone="muted">折算费用</Mono>
              {usage ? <Cost usd={usage.events === 0 ? 0 : usage.cost_usd} unpriced={usage.unpriced_events} /> : <Mono tone="muted">—</Mono>}
            </div>
            <div className="weekstat__row">
              <Mono tone="muted">调用 / tokens</Mono>
              <Mono>{usage ? `${usage.events.toLocaleString("en-US")} 次 · ${fmtTokens(usage.tokens.total)}` : "—"}</Mono>
            </div>
            <div className="weekstat__row" title={full?.basis === "reference" ? `最近 ${full.reference_periods} 期的中位数` : full?.lower_bound ? "期内有缺价调用，这是下界" : undefined}>
              <Mono tone="muted">周限额约</Mono>
              <span className="cost">
                <Mono>{full ? `$${full.usd.toFixed(0)}` : "—"}</Mono>
                {full?.lower_bound && <span className="cost__mark" aria-hidden="true">†</span>}
              </span>
            </div>
            <div className="weekstat__row">
              <Mono tone="muted">官方重置</Mono>
              <Mono>{p.resets.length + (p.opened_by_reset ? 1 : 0)} 次</Mono>
            </div>
          </div>
        ) : (
          <Placeholder state={core.quota.error || failed ? "error" : "loading"} height={220} />
        )}
      </Card>

      <PeriodsCard
        periods={periods.data ? longPeriods(periods.data.periods) : null}
        failed={Boolean(periods.error) || failed}
        nowMs={nowMs}
      />
    </div>
  );
}

/** 用量分布：按模型 / 项目 / 机器，以及采集器 */
export function CodexDistribution({ api, t, core, from, to, nonce, nowMs }: CoreProps) {
  const byModel = useCodexUsage(api, core, "model", from, to, nonce);
  const byProject = useCodexUsage(api, core, "project", from, to, nonce);
  const byMachine = useCodexUsage(api, core, "machine", from, to, nonce);
  const modelBuckets = useMemo(() => (byModel.data ? codexBuckets(byModel.data.buckets) : null), [byModel.data]);
  const projectBuckets = useMemo(() => (byProject.data ? codexBuckets(byProject.data.buckets) : null), [byProject.data]);
  const machineBuckets = useMemo(() => (byMachine.data ? codexBuckets(byMachine.data.buckets) : null), [byMachine.data]);
  const modelColors = useMemo(() => colorMapFor("model", (modelBuckets ?? []).map((b) => b.key), t), [modelBuckets, t]);
  const projectColors = useMemo(() => colorMapFor("project", (projectBuckets ?? []).map((b) => b.key), t), [projectBuckets, t]);
  const machineColors = useMemo(() => colorMapFor("machine", (machineBuckets ?? []).map((b) => b.key), t), [machineBuckets, t]);
  const machineName = useMemo(() => {
    const names = new Map((core.collectors.data ?? []).map((c) => [c.machine_id, collectorName(c)]));
    return (key: string) => names.get(key) ?? key.slice(0, 8);
  }, [core.collectors.data]);
  const failed = Boolean(core.accounts.error);

  if (notConnected(core)) return <NotConnected />;
  return (
    <div className="grid">
      <BreakdownTable
        title="按模型"
        buckets={modelBuckets}
        colors={modelColors}
        labelOf={(b) => b.key}
        state={byModel.error || failed ? "error" : "loading"}
        span={6}
        mdSpan={3}
      />
      <BreakdownTable
        title="按项目"
        buckets={projectBuckets}
        colors={projectColors}
        labelOf={(b) => b.key.split("/").filter(Boolean).at(-1) ?? b.key}
        state={byProject.error || failed ? "error" : "loading"}
        span={6}
        mdSpan={3}
        limit={10}
      />
      <BreakdownTable
        title="按机器"
        buckets={machineBuckets}
        colors={machineColors}
        labelOf={(b) => machineName(b.key)}
        state={byMachine.error || failed ? "error" : "loading"}
        span={6}
        mdSpan={3}
      />
      <CollectorsCard
        collectors={core.collectors.data ?? null}
        failed={Boolean(core.collectors.error) || failed}
        plan={core.account?.plan_type ?? null}
        nowMs={nowMs}
        span={6}
      />
    </div>
  );
}

function QuotaRow({
  quota,
  failed,
  nowMs,
  span,
}: {
  quota: CodexQuotaResponse | null;
  failed: boolean;
  nowMs: number;
  /** 每张窗口卡的列宽：与同一行的用量、重置券一起铺满（见 codexTopSpans） */
  span: Span;
}) {
  const snapshot = quota?.snapshot ?? null;
  if (!snapshot) {
    // 还在取 / 取失败：骨架。取到了但从没采到过（snapshot = null）：一张卡写「暂无」
    if (quota && !failed) {
      return (
        <Card title="额度" span={span.span} mdSpan={span.mdSpan}>
          <div className="btable__empty">
            <Mono tone="muted">暂无快照</Mono>
          </div>
        </Card>
      );
    }
    return (
      <Card span={span.span} mdSpan={span.mdSpan}>
        <Placeholder state={failed ? "error" : "loading"} height={180} />
      </Card>
    );
  }
  const windows = sortCodexWindows(snapshot.windows);
  // 最近一次采到了，但官方没给任何窗口 —— 和「从没采到」是两回事
  if (windows.length === 0) {
    return (
      <Card title="额度" span={span.span} mdSpan={span.mdSpan} aside={<Mono tone="muted">{fmtClock(msOf(snapshot.captured_at))}</Mono>}>
        <div className="btable__empty">
          <Mono tone="muted">当前没有限额窗口</Mono>
        </div>
      </Card>
    );
  }
  const multipleLimits = new Set(windows.map((w) => w.limit_id)).size > 1;
  const reached = new Set(snapshot.limits.filter((l) => l.limit_reached).map((l) => l.limit_id));
  const byWindow = new Map((quota?.analysis ?? []).map((a) => [a.window_id, a]));
  return (
    <>
      {windows.map((w) => (
        <CodexWindowCard
          key={w.window_id}
          w={w}
          a={byWindow.get(w.window_id) ?? null}
          title={codexWindowTitle(w, multipleLimits)}
          reached={reached.has(w.limit_id)}
          stale={quota?.stale ?? false}
          capturedAt={snapshot.captured_at}
          nowMs={nowMs}
          span={span.span}
          mdSpan={span.mdSpan}
        />
      ))}
    </>
  );
}

function CodexWindowCard({
  w,
  a,
  title,
  reached,
  stale,
  capturedAt,
  nowMs,
  span,
  mdSpan,
}: {
  w: CodexQuotaWindow;
  /** 服务端的期/段分析；旧服务端没有 */
  a: CodexWindowAnalysis | null;
  title: string;
  reached: boolean;
  stale: boolean;
  capturedAt: string;
  nowMs: number;
  span: number;
  mdSpan: number;
}) {
  const projected = a?.projected_pct.mid ?? w.used_percent;
  const tone = reached ? "danger" : ringTone(w.used_percent, projected);
  const projTone = projected >= 100 ? "danger" : projected >= 90 ? "warn" : undefined;
  const band = a ? Math.round((a.projected_pct.p75 - a.projected_pct.p25) / 2) : 0;
  const resetMs = msOf(w.resets_at);
  const etaMs = msOf(a?.exhaust_eta);
  const remain = Number.isFinite(etaMs) ? etaMs - nowMs : null;
  const pace = codexPace(w, nowMs);
  const period = a?.period ?? null;
  const usage = a?.local_usage ?? null;
  const full = a?.full_cost ?? null;
  const reset = period ? periodWasReset(period) : false;
  const resetTimes = period
    ? [...(period.opened_by_reset ? [period.opened_by_reset] : []), ...period.resets]
        .map((r) => `${fmtWhen(Date.parse(r.at), nowMs)} 重置 ${Math.round(r.from_pct)}% → ${Math.round(r.to_pct)}%`)
        .join("\n")
    : "";
  return (
    <Card
      title={title}
      span={span}
      mdSpan={mdSpan}
      tone={tone === "ok" ? "plain" : tone}
      aside={
        Number.isFinite(resetMs) ? (
          <Mono tone="muted">
            {fmtWhen(resetMs, nowMs)} 重置 · {fmtUntil(resetMs - nowMs)}
          </Mono>
        ) : undefined
      }
    >
      <div className="quota">
        <div className="quota__head">
          <Num value={w.used_percent} digits={0} suffix="%" size="xl" tone={tone === "ok" ? undefined : tone} />
          {a && (
            <span className="quota__proj">
              <Mono tone="muted">重置时预计</Mono>
              <Num value={projected} digits={0} suffix="%" size="md" tone={projTone} />
              {band >= 1 && <Mono tone="muted">±{band}</Mono>}
            </span>
          )}
        </div>
        <QuotaBar used={w.used_percent} projected={projected} pace={pace} tone={tone} />
        <div className={`quota__eta quota__eta--${reached ? "danger" : stale ? "warn" : remain !== null ? "warn" : "muted"}`}>
          {reached ? (
            <>
              <Dot tone="danger" />
              <span>已达上限</span>
            </>
          ) : stale ? (
            <>
              <Dot tone="warn" />
              <span>快照已过期 · {fmtClock(msOf(capturedAt))}</span>
            </>
          ) : remain !== null ? (
            <>
              <Dot tone="warn" />
              <span>
                {fmtWhen(etaMs, nowMs)} 耗尽 · {fmtUntil(remain)}
              </span>
            </>
          ) : (
            <span>{a ? "按当前速率不会耗尽" : `${fmtClock(msOf(capturedAt))} 采集`}</span>
          )}
        </div>
        {/* 与 Claude 卡同一个形状：左边本期已花，右边打满值多少钱。
            本期被重置过时，右下角写本期累计 —— 现值只是重置之后的那一截 */}
        {(usage || reset) && (
          <div className="quota__money" title={resetTimes || undefined}>
            <div className="quota__money-col">
              <span className="quota__k">已用</span>
              {usage ? (
                <>
                  <span className="quota__v">
                    <Cost usd={usage.events === 0 ? 0 : usage.cost_usd} unpriced={usage.unpriced_events} />
                  </span>
                  <Mono tone="muted">
                    {usage.events.toLocaleString("en-US")} 次调用 · {fmtTokens(usage.tokens.total)}
                  </Mono>
                </>
              ) : (
                <Mono tone="muted">—</Mono>
              )}
            </div>
            <div className="quota__money-col quota__money-col--end">
              <span className="quota__k">满额约</span>
              <span
                className={`quota__v quota__v--strong${full?.basis === "reference" ? " quota__v--ref" : ""}`}
                title={
                  full?.basis === "reference"
                    ? `最近 ${full.reference_periods} 期的中位数`
                    : full?.lower_bound
                      ? "期内有缺价调用，这是下界"
                      : undefined
                }
              >
                {full ? `$${full.usd.toFixed(0)}` : "—"}
                {full?.lower_bound && (
                  <span className="cost__mark" aria-hidden="true">
                    †
                  </span>
                )}
              </span>
              {reset && period ? (
                <Mono tone="muted">
                  本期累计 {fmtCumulative(period)} · 重置 {period.resets.length + (period.opened_by_reset ? 1 : 0)} 次
                </Mono>
              ) : (
                <Mono tone="muted">&nbsp;</Mono>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function BurnCard({
  analyses,
  windows,
  t,
  nowMs,
  failed,
  loading,
}: {
  analyses: CodexWindowAnalysis[];
  windows: CodexQuotaWindow[];
  t: Tokens;
  nowMs: number;
  failed: boolean;
  loading: boolean;
}) {
  const ordered = useMemo(() => {
    const order = new Map(sortCodexWindows(windows).map((w, i) => [w.window_id, i]));
    return [...analyses].filter((a) => a.period.samples.length > 0).sort((x, y) => (order.get(x.window_id) ?? 99) - (order.get(y.window_id) ?? 99));
  }, [analyses, windows]);
  const multipleLimits = new Set(windows.map((w) => w.limit_id)).size > 1;
  const [picked, setPicked] = useState<string | null>(null);
  // 默认看最长的那个窗口：官方重置在 7d 上影响最大
  const current = ordered.find((a) => a.window_id === picked) ?? ordered.at(-1) ?? null;
  const option = useMemo(() => (current ? codexBurnOption(t, current, nowMs) : null), [t, current, nowMs]);
  const titleOf = (id: string) => {
    const w = windows.find((x) => x.window_id === id);
    return w ? codexWindowTitle(w, multipleLimits) : id;
  };
  return (
    <Card
      title="燃尽"
      span={6}
      mdSpan={3}
      aside={
        ordered.length > 1 && current ? (
          <Segmented
            label="窗口"
            value={current.window_id}
            options={ordered.map((a) => ({ value: a.window_id, label: titleOf(a.window_id).replace(/ 窗口$/, "") }))}
            onChange={setPicked}
          />
        ) : undefined
      }
    >
      {option ? (
        <Chart option={option} height={200} ariaLabel={`${titleOf(current!.window_id)} 本期已用与预计，竖线为官方重置`} />
      ) : loading || failed ? (
        <Placeholder state={failed ? "error" : "loading"} height={200} />
      ) : (
        <div className="btable__empty">
          <Mono tone="muted">还没有历史快照</Mono>
        </div>
      )}
    </Card>
  );
}

function CreditsCard({
  credits,
  loading,
  nowMs,
  span,
}: {
  /** undefined = 当前快照不是服务端抓的（探针读不到券）—— 不知道，不是 0 张 */
  credits: CodexResetCredits | null | undefined;
  loading: boolean;
  nowMs: number;
  span: Span;
}) {
  const expiry = earliestCreditExpiry(credits);
  const available = (credits?.credits ?? []).filter((c) => c.status === "available");
  return (
    <Card title="重置券" span={span.span} mdSpan={span.mdSpan}>
      {loading ? (
        <Placeholder state="loading" height={180} />
      ) : (
        <div className="quota">
          <div className="quota__head">
            {credits ? <Num value={credits.available_count} digits={0} suffix="张" size="xl" /> : <span className="num num--xl num--muted">—</span>}
          </div>
          {credits && expiry !== null && (
            <div className="quota__eta quota__eta--muted">
              <span>
                最早 {fmtWhen(expiry, nowMs)} 到期 · {fmtUntil(expiry - nowMs)}
              </span>
            </div>
          )}
          {available.length > 0 && (
            <ul className="attr-list">
              {available.slice(0, 4).map((c, i) => (
                <li className="attr-list__row" key={`${c.granted_at}-${i}`}>
                  <Dot tone="ok" />
                  <span className="attr-list__name">{c.title ?? c.reset_type}</span>
                  <span className="attr-list__n">{fmtDay(Date.parse(c.granted_at))} 发</span>
                  <span className="attr-list__pct">{c.expires_at ? `${fmtDay(Date.parse(c.expires_at))} 止` : "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/** 一期的起止：06/10 → 06/17；提前结束的写实际结束日 */
function periodRange(p: CodexPeriodRecord): string {
  const start = msOf(p.starts_at) || msOf(p.first_sample_at);
  const end = msOf(p.ended_at) || msOf(p.scheduled_end);
  return `${Number.isFinite(start) ? fmtDay(start) : "—"} → ${Number.isFinite(end) ? fmtDay(end) : "—"}`;
}

function periodNote(p: CodexPeriodRecord): string {
  const parts: string[] = [];
  if (!p.ended_at) parts.push("进行中");
  if (p.opened_by_reset) parts.push("由重置开启");
  if (p.resets.length) parts.push(`期内重置 ${p.resets.length} 次`);
  if (p.end_reason === "reset") parts.push("被重置提前结束");
  return parts.join(" · ");
}

function PeriodsCard({ periods, failed, nowMs }: { periods: CodexPeriodRecord[] | null; failed: boolean; nowMs: number }) {
  return (
    <Card title="周期历史" span={12}>
      {periods === null ? (
        <Placeholder state={failed ? "error" : "loading"} height={148} />
      ) : periods.length === 0 ? (
        <div className="btable__empty">
          <Mono tone="muted">还没有完整的周期</Mono>
        </div>
      ) : (
        <table className="btable">
          <thead>
            <tr>
              <th scope="col" className="btable__name" />
              <th scope="col">累计</th>
              <th scope="col" className="btable__barcol" />
              <th scope="col">tokens</th>
              <th scope="col">折算</th>
              <th scope="col">满额约</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => {
              const note = periodNote(p);
              const tip = [
                p.has_gap ? "采样有断档，累计是下界" : "",
                ...[...(p.opened_by_reset ? [p.opened_by_reset] : []), ...p.resets].map(
                  (r) => `${fmtWhen(Date.parse(r.at), nowMs)} 重置 ${Math.round(r.from_pct)}% → ${Math.round(r.to_pct)}%`,
                ),
              ].filter(Boolean).join("\n");
              return (
                <tr key={`${p.window_id}-${p.first_sample_at}`}>
                  <th scope="row" className="btable__name" title={tip || undefined}>
                    <span className="btable__swatch" style={{ background: periodWasReset(p) ? "var(--warn)" : "var(--text-4)" }} />
                    <span className="btable__label">{periodRange(p)}</span>
                    {note && <span className="btable__sub">{note}</span>}
                  </th>
                  <td className="btable__tokens">{fmtCumulative(p)}</td>
                  <td className="btable__barcol">
                    <span className="btable__track">
                      <span className="btable__fill" style={{ width: `${Math.min(100, p.cumulative_pct)}%`, background: "var(--accent)" }} />
                    </span>
                    <span className="btable__pct">{p.cumulative_pct > 100 ? "超额" : ""}</span>
                  </td>
                  <td className="btable__hit">{fmtTokens(p.local_usage.tokens.total)}</td>
                  <td className="btable__cost">
                    <Cost usd={p.local_usage.cost_usd} unpriced={p.local_usage.unpriced_events} />
                  </td>
                  <td className="btable__cost" title={p.local_usage.unpriced_events > 0 ? "期内有缺价调用，这是下界" : undefined}>
                    <span className="cost">
                      <Mono>{p.full_cost_usd != null ? `$${p.full_cost_usd.toFixed(0)}` : "—"}</Mono>
                      {p.full_cost_usd != null && p.local_usage.unpriced_events > 0 && <span className="cost__mark" aria-hidden="true">†</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function CollectorsCard({
  collectors,
  failed,
  plan,
  nowMs,
  span,
}: {
  collectors: CodexCollector[] | null;
  failed: boolean;
  plan: string | null;
  nowMs: number;
  span: number;
}) {
  return (
    <Card title="采集器" span={span} mdSpan={6} aside={plan ? <Mono tone="muted">{plan}</Mono> : undefined}>
      {collectors === null ? (
        <Placeholder state={failed ? "error" : "loading"} height={148} />
      ) : collectors.length === 0 ? (
        <div className="btable__empty">
          <Mono tone="muted">还没有采集器上报</Mono>
        </div>
      ) : (
        <ul className="attr-list">
          {collectors.map((c) => {
            const at = msOf(c.collector.captured_at);
            const notes = [
              ...(c.parse_warnings_total > 0 ? [`扣留 ${c.parse_warnings_total} 条记录`] : []),
              ...(c.conflicting_observations > 0 ? [`${c.conflicting_observations} 处冲突`] : []),
            ];
            return (
              <li className="attr-list__row" key={c.machine_id} title={[c.machine_id, ...notes].join("\n")}>
                <Dot tone={collectorTone(c)} />
                <span className="attr-list__name">{collectorName(c)}</span>
                <span className="attr-list__n">{collectorStateLabel(c)}</span>
                <span className="attr-list__pct">{Number.isFinite(at) ? fmtWhen(at, nowMs) : "—"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
