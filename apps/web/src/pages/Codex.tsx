import { useMemo, useState } from "react";
import type { CodexAggregate, CodexCollector, CodexQuotaResponse, CodexQuotaWindow, UaApi } from "../api";
import {
  codexBucket,
  codexBuckets,
  codexDaySeries,
  codexPace,
  codexWindowTitle,
  collectorStateLabel,
  collectorTone,
  localDayTicks,
  sortCodexWindows,
} from "../api/codex";
import { usageTotals, type UsageMetric } from "../api/derive";
import { fmtClock, fmtUntil, fmtWhen, msOf } from "../charts/base";
import { usageTimelineOption } from "../charts/distribution";
import { colorMapFor } from "../charts/registry";
import { ringTone } from "../charts/rings";
import type { Tokens } from "../charts/tokens";
import { Chart } from "../components/Chart";
import { Card, Dot, Mono, Num, Placeholder, Segmented } from "../components/primitives";
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
 */
export function Codex({ api, t, from, to, rangeLabel, nonce, nowMs }: Props) {
  const accounts = useAsync((s) => api.codexAccounts(s), [api, nonce]);
  const account = accounts.data?.[0] ?? null;
  const accountId = account?.account_id ?? null;

  const quota = useAsync(
    (s) => (accountId ? api.codexQuota(accountId, s) : Promise.resolve(null)),
    [api, accountId, nonce],
  );
  const usageQuery = (by: "day" | "model" | "project") => (s: AbortSignal) =>
    accountId ? api.codexUsage({ account_id: accountId, from, to, by, timezone: TIME_ZONE }, s) : Promise.resolve(null);
  const byDay = useAsync(usageQuery("day"), [api, accountId, from, to, nonce]);
  const byModel = useAsync(usageQuery("model"), [api, accountId, from, to, nonce]);
  const byProject = useAsync(usageQuery("project"), [api, accountId, from, to, nonce]);
  const collectors = useAsync(
    (s) => (accountId ? api.codexCollectors(accountId, s) : Promise.resolve(null)),
    [api, accountId, nonce],
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

  // 账户列表回来了但是空的：这台服务端没接入 Codex。一张卡说清楚，别摆一屏骨架
  if (accounts.data && accounts.data.length === 0) {
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

  return (
    <div className="grid">
      <QuotaRow quota={quota.data} failed={Boolean(quota.error || accounts.error)} nowMs={nowMs} />

      <UsageSummary
        title={`${rangeLabel} 用量`}
        totals={totals}
        state={byModel.error || accounts.error ? "error" : "loading"}
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
          <Chart
            option={timeline}
            height={176}
            ariaLabel={metric === "cost" ? "Codex 按天的折算费用" : "Codex 按天的 token 用量"}
          />
        ) : (
          <Placeholder state={byDay.error || accounts.error ? "error" : "loading"} height={176} />
        )}
      </Card>

      <BreakdownTable
        title="按模型"
        buckets={modelBuckets}
        colors={modelColors}
        labelOf={(b) => b.key}
        state={byModel.error || accounts.error ? "error" : "loading"}
        span={5}
        mdSpan={3}
      />
      <BreakdownTable
        title="按项目"
        buckets={projectBuckets}
        colors={projectColors}
        labelOf={(b) => b.key.split("/").filter(Boolean).at(-1) ?? b.key}
        state={byProject.error || accounts.error ? "error" : "loading"}
        span={4}
        mdSpan={3}
        limit={8}
      />
      <CollectorsCard
        collectors={collectors.data ?? null}
        failed={Boolean(collectors.error || accounts.error)}
        plan={account?.plan_type ?? null}
        nowMs={nowMs}
      />
    </div>
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
            <Placeholder state={failed ? "error" : "loading"} height={110} />
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
  const spans = quotaSpans(windows.length);
  return (
    <>
      {windows.map((w) => (
        <CodexWindowCard
          key={w.window_id}
          w={w}
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
  title,
  reached,
  stale,
  capturedAt,
  nowMs,
  span,
  mdSpan,
}: {
  w: CodexQuotaWindow;
  title: string;
  reached: boolean;
  stale: boolean;
  capturedAt: string;
  nowMs: number;
  span: number;
  mdSpan: number;
}) {
  // 官方只给已用百分比，没有速率可外推：预计值就是已用值，条上不画半透明的预计段
  const tone = reached ? "danger" : ringTone(w.used_percent, w.used_percent);
  const resetMs = msOf(w.resets_at);
  const pace = codexPace(w, nowMs);
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
        </div>
        <QuotaBar used={w.used_percent} projected={w.used_percent} pace={pace} tone={tone} />
        <div className={`quota__eta quota__eta--${reached ? "danger" : stale ? "warn" : "muted"}`}>
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
          ) : (
            <span>{fmtClock(msOf(capturedAt))} 采集</span>
          )}
        </div>
      </div>
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
                <span className="attr-list__name">{c.hostname ?? c.machine_id.slice(0, 8)}</span>
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
