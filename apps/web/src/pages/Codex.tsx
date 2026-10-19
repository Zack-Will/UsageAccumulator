import { useMemo, useState } from "react";
import type {
  CodexAggregate,
  CodexCollector,
  CodexPeriodRecord,
  CodexQuotaResponse,
  CodexQuotaWindow,
  CodexResetCredits,
  CodexSessionStatus,
  CodexWindowAnalysis,
  UaApi,
} from "../api";
import {
  codexBucket,
  codexBuckets,
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
import { CodexSessionDialog, codexSessionLine, codexSessionTone } from "../components/CodexSession";
import { Card, Cost, Dot, Mono, Num, Placeholder, Segmented } from "../components/primitives";
import { BreakdownTable, UsageSummary } from "../components/UsagePanels";
import { QuotaBar, quotaSpans } from "../components/WindowCards";
import { useAsync } from "../hooks/useAsync";

interface Props {
  api: UaApi;
  t: Tokens;
  from: string;
  to: string;
  rangeLabel: string;
  nonce: number;
  nowMs: number;
}

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

/**
 * Codex 独立账本。与 Claude 的 profile 无关：额度、本地用量、采集器三份数据各说各的，不相加。
 * 额度由服务端直接抓（服务端专用的 ChatGPT 登录），并按官方提前重置切期与段。
 */
export function Codex({ api, t, from, to, rangeLabel, nonce, nowMs }: Props) {
  const accounts = useAsync((s) => api.codexAccounts(s), [api, nonce]);
  const account = accounts.data?.[0] ?? null;
  const accountId = account?.account_id ?? null;

  const [sessionTick, setSessionTick] = useState(0);
  const [sessionOpen, setSessionOpen] = useState(false);
  const session = useAsync((s) => api.codexSession(s), [api, nonce, sessionTick]);

  const quota = useAsync(
    (s) => (accountId ? api.codexQuota(accountId, s) : Promise.resolve(null)),
    [api, accountId, nonce, sessionTick],
  );
  const periods = useAsync(
    (s) => (accountId ? api.codexPeriods({ account_id: accountId, weeks: 8, timezone: TIME_ZONE }, s) : Promise.resolve(null)),
    [api, accountId, nonce, sessionTick],
  );
  const usageQuery = (by: "day" | "model" | "project") => (s: AbortSignal) =>
    accountId ? api.codexUsage({ account_id: accountId, from, to, by, timezone: TIME_ZONE }, s) : Promise.resolve(null);
  const byDay = useAsync(usageQuery("day"), [api, accountId, from, to, nonce]);
  const byModel = useAsync(usageQuery("model"), [api, accountId, from, to, nonce]);
  const byProject = useAsync(usageQuery("project"), [api, accountId, from, to, nonce]);
  const collectors = useAsync(
    (s) => (accountId ? api.codexCollectors(accountId, s) : Promise.resolve(null)),
    [api, accountId, nonce, sessionTick],
  );

  const [metric, setMetric] = useState<UsageMetric>("cost");
  const timeline = useMemo(() => {
    if (!byDay.data) return null;
    const ticks = localDayTicks(Date.parse(from), Date.parse(to));
    const series = codexDaySeries(byDay.data.buckets, ticks, metric, "Codex");
    return usageTimelineOption(t, ticks, series, new Map([["codex", t.cat1]]), "day", metric);
  }, [t, byDay.data, from, to, metric]);

  const modelBuckets = useMemo(() => (byModel.data ? codexBuckets(byModel.data.buckets) : null), [byModel.data]);
  const projectBuckets = useMemo(() => (byProject.data ? codexBuckets(byProject.data.buckets) : null), [byProject.data]);
  const modelColors = useMemo(() => colorMapFor("model", (modelBuckets ?? []).map((b) => b.key), t), [modelBuckets, t]);
  const projectColors = useMemo(() => colorMapFor("project", (projectBuckets ?? []).map((b) => b.key), t), [projectBuckets, t]);

  // 汇总读服务端的 totals，不自己把桶加起来：totals 才带账户级的完整性判断
  const totalsData = byModel.data?.totals ?? null;
  const totals = useMemo(() => (totalsData ? usageTotals([codexBucket("total", totalsData)]) : null), [totalsData]);
  const warnings = (collectors.data ?? []).reduce((n, c) => n + c.parse_warnings_total, 0);

  const analyses = quota.data?.analysis ?? [];
  const failed = Boolean(accounts.error);

  // 账户列表回来了但是空的：服务端没收到过任何 Codex 数据。登录入口照样给，否则没处开始
  if (accounts.data && accounts.data.length === 0) {
    return (
      <div className="grid">
        <Card title="Codex" span={12} aside={<SessionButton status={session.data} nowMs={nowMs} onOpen={() => setSessionOpen(true)} />}>
          <div className="btable__empty">
            <Mono tone="muted">未接入</Mono>
          </div>
        </Card>
        {sessionOpen && (
          <CodexSessionDialog api={api} status={session.data} onClose={() => setSessionOpen(false)} onChanged={() => setSessionTick((n) => n + 1)} />
        )}
      </div>
    );
  }

  return (
    <div className="grid">
      <QuotaRow quota={quota.data} failed={Boolean(quota.error) || failed} nowMs={nowMs} />

      <BurnCard analyses={analyses} windows={quota.data?.snapshot?.windows ?? []} t={t} nowMs={nowMs} failed={Boolean(quota.error) || failed} loading={!quota.data} />
      <CreditsCard
        credits={quota.data?.snapshot?.reset_credits}
        loading={!quota.data}
        session={session.data}
        nowMs={nowMs}
        onOpen={() => setSessionOpen(true)}
      />

      <UsageSummary
        title={`${rangeLabel} 用量`}
        totals={totals}
        state={byModel.error || failed ? "error" : "loading"}
        span={4}
        mdSpan={2}
        incomplete={totalsData ? coverageNote(totalsData, warnings) : undefined}
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
        {timeline ? (
          <Chart option={timeline} height={176} ariaLabel={metric === "cost" ? "Codex 按天的折算费用" : "Codex 按天的 token 用量"} />
        ) : (
          <Placeholder state={byDay.error || failed ? "error" : "loading"} height={176} />
        )}
      </Card>

      <PeriodsCard periods={periods.data ? longPeriods(periods.data.periods) : null} failed={Boolean(periods.error) || failed} nowMs={nowMs} />

      <BreakdownTable
        title="按模型"
        buckets={modelBuckets}
        colors={modelColors}
        labelOf={(b) => b.key}
        state={byModel.error || failed ? "error" : "loading"}
        span={5}
        mdSpan={3}
      />
      <BreakdownTable
        title="按项目"
        buckets={projectBuckets}
        colors={projectColors}
        labelOf={(b) => b.key.split("/").filter(Boolean).at(-1) ?? b.key}
        state={byProject.error || failed ? "error" : "loading"}
        span={4}
        mdSpan={3}
        limit={8}
      />
      <CollectorsCard collectors={collectors.data ?? null} failed={Boolean(collectors.error) || failed} plan={account?.plan_type ?? null} nowMs={nowMs} />

      {sessionOpen && (
        <CodexSessionDialog api={api} status={session.data} onClose={() => setSessionOpen(false)} onChanged={() => setSessionTick((n) => n + 1)} />
      )}
    </div>
  );
}

/** 卡片右上角的登录状态：点开就是登录框 —— 登录失效时要做的事就在这里 */
function SessionButton({ status, nowMs, onOpen }: { status: CodexSessionStatus | null; nowMs: number; onOpen: () => void }) {
  const tone = codexSessionTone(status?.state);
  return (
    <button
      type="button"
      className={`sync${tone === "danger" || tone === "warn" ? " sync--alert" : ""}`}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Codex 登录：${codexSessionLine(status, nowMs)}`}
      title={status?.error ?? undefined}
    >
      <Dot tone={tone} />
      <span>{status?.state === "ok" ? "已登录" : codexSessionLine(status, nowMs)}</span>
    </button>
  );
}

function QuotaRow({ quota, failed, nowMs }: { quota: CodexQuotaResponse | null; failed: boolean; nowMs: number }) {
  const snapshot = quota?.snapshot ?? null;
  if (!snapshot) {
    // 还在取 / 取失败：骨架。取到了但从没采到过（snapshot = null）：一张卡写「暂无」
    if (quota && !failed) {
      return (
        <Card title="额度" span={12}>
          <div className="btable__empty">
            <Mono tone="muted">暂无快照</Mono>
          </div>
        </Card>
      );
    }
    return (
      <>
        {[0, 1].map((i) => (
          <Card key={i} span={6} mdSpan={3}>
            <Placeholder state={failed ? "error" : "loading"} height={130} />
          </Card>
        ))}
      </>
    );
  }
  const windows = sortCodexWindows(snapshot.windows);
  // 最近一次采到了，但官方没给任何窗口 —— 和「从没采到」是两回事
  if (windows.length === 0) {
    return (
      <Card title="额度" span={12} aside={<Mono tone="muted">{fmtClock(msOf(snapshot.captured_at))}</Mono>}>
        <div className="btable__empty">
          <Mono tone="muted">当前没有限额窗口</Mono>
        </div>
      </Card>
    );
  }
  const multipleLimits = new Set(windows.map((w) => w.limit_id)).size > 1;
  const reached = new Set(snapshot.limits.filter((l) => l.limit_reached).map((l) => l.limit_id));
  const byWindow = new Map((quota?.analysis ?? []).map((a) => [a.window_id, a]));
  const spans = quotaSpans(windows.length);
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
          span={spans.span}
          mdSpan={spans.mdSpan}
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
        {/* 本期被重置过：现值只是重置之后的那一截，本期真正用掉的是各段之和 */}
        {period && periodWasReset(period) && (
          <div className="quota__money" title={resetTimes}>
            <div className="quota__money-col">
              <span className="quota__k">本期累计</span>
              <span className="quota__v quota__v--strong">{fmtCumulative(period)}</span>
            </div>
            <div className="quota__money-col quota__money-col--end">
              <span className="quota__k">官方重置</span>
              <span className="quota__v">{period.resets.length + (period.opened_by_reset ? 1 : 0)} 次</span>
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
      span={8}
      mdSpan={4}
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
  session,
  nowMs,
  onOpen,
}: {
  /** undefined = 当前快照不是服务端抓的（探针读不到券）—— 不知道，不是 0 张 */
  credits: CodexResetCredits | null | undefined;
  loading: boolean;
  session: CodexSessionStatus | null;
  nowMs: number;
  onOpen: () => void;
}) {
  const expiry = earliestCreditExpiry(credits);
  const available = (credits?.credits ?? []).filter((c) => c.status === "available");
  return (
    <Card title="重置券" span={4} mdSpan={2} aside={<SessionButton status={session} nowMs={nowMs} onOpen={onOpen} />}>
      {loading ? (
        <Placeholder state="loading" height={200} />
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
}: {
  collectors: CodexCollector[] | null;
  failed: boolean;
  plan: string | null;
  nowMs: number;
}) {
  return (
    <Card title="采集器" span={3} mdSpan={6} aside={plan ? <Mono tone="muted">{plan}</Mono> : undefined}>
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
