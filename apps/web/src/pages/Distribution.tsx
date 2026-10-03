import { useMemo } from "react";
import type { AttributionLevel, DistributionBucket, UaApi } from "../api";
import { bucketLabel, cacheTrend, costSummary, hourCells, projectLabel, sessionLabel, sessionWhere, sharePct } from "../api/derive";
import { fmtPct, fmtTokens } from "../charts/base";
import { cacheTrendOption, hourHeatmapOption, projectTreemapOption } from "../charts/distribution";
import { colorMapFor } from "../charts/registry";
import { status, type Tokens } from "../charts/tokens";
import { Chart } from "../components/Chart";
import { Card, Cost, Mono, Placeholder } from "../components/primitives";
import { useAsync } from "../hooks/useAsync";
import { BreakdownTable } from "../components/UsagePanels";

interface Props {
  api: UaApi;
  t: Tokens;
  profileId: string;
  from: string;
  to: string;
  nonce: number;
}

/**
 * 归属可信度四档（CONTRACT §2.1a：by=attribution 时 key 取 attribution_level）。
 * 颜色按可信度递减取状态色，不走分类色板 —— 这里的语义是「可信 / 不可信」，不是「哪一类」。
 */
const ATTR_ORDER: AttributionLevel[] = ["proxy", "timeline", "fallback", "unknown"];

function attrColor(level: AttributionLevel, t: Tokens): string {
  const s = status(t);
  switch (level) {
    case "proxy":
      return s.ok;
    case "timeline":
      return s.info;
    case "fallback":
      return s.warn;
    case "unknown":
      return t["text-4"];
  }
}

export function Distribution({ api, t, profileId, from, to, nonce }: Props) {
  const projects = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "project" }, s),
    [api, profileId, from, to, nonce],
  );
  // 一次 by=hour 同时喂星期×小时热力图与缓存命中率趋势
  const hours = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "hour" }, s),
    [api, profileId, from, to, nonce],
  );
  const attribution = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "attribution" }, s),
    [api, profileId, from, to, nonce],
  );
  // 按会话：回答「这块用量到底是哪条对话」—— 尤其是临时工作区那种没有项目归属的会话
  const sessions = useAsync(
    (s) => api.distribution({ profile_id: profileId, from, to, by: "session" }, s),
    [api, profileId, from, to, nonce],
  );
  // 会话的色点取所在项目的颜色：和上面树图里那块同色，一眼对得上是哪个项目下的会话
  const sessionColors = useMemo(() => {
    const buckets = sessions.data?.buckets ?? [];
    const byProject = colorMapFor("project", buckets.map((b) => b.project_slug ?? b.key), t);
    return new Map(buckets.map((b) => [b.key, byProject.get(b.project_slug ?? b.key) ?? t.cat1]));
  }, [sessions.data, t]);

  const treemap = useMemo(() => {
    if (!projects.data) return null;
    const colors = colorMapFor("project", projects.data.buckets.map((b) => b.key), t);
    return projectTreemapOption(t, projects.data.buckets, colors, (b) => bucketLabel(b, projectLabel));
  }, [t, projects.data]);

  const heatmap = useMemo(
    () => (hours.data ? hourHeatmapOption(t, hourCells(hours.data.buckets)) : null),
    [t, hours.data],
  );

  const trendPoints = useMemo(
    () => (hours.data ? cacheTrend(hours.data.buckets) : []),
    [hours.data],
  );

  const trend = useMemo(
    () => (trendPoints.length > 0 ? cacheTrendOption(t, trendPoints) : null),
    [t, trendPoints],
  );

  const attrRows = useMemo(() => {
    const buckets = attribution.data?.buckets ?? [];
    return ATTR_ORDER.map((level) => {
      const b = buckets.find((x) => x.key === level);
      return b ? { level, bucket: b, share: sharePct(buckets, b) } : null;
    }).filter((x): x is { level: AttributionLevel; bucket: DistributionBucket; share: number } =>
      Boolean(x),
    );
  }, [attribution.data]);

  const projectCost = projects.data ? costSummary(projects.data.buckets) : null;

  return (
    <div className="grid">
      <Card
        title="项目"
        span={7}
        aside={
          projectCost ? (
            <span className="aside-row">
              <Mono tone="muted">{projects.data?.buckets.length ?? 0}</Mono>
              <Cost usd={projectCost.usd} unpriced={projectCost.unpricedEvents} partial={projectCost.partialOutputEvents} />
            </span>
          ) : undefined
        }
      >
        {treemap ? (
          <Chart option={treemap} height={300} ariaLabel="各项目 token 消耗 treemap" />
        ) : (
          <Placeholder state={projects.error ? "error" : "loading"} height={300} />
        )}
      </Card>

      <Card
        title="归属可信度"
        span={5}
        aside={
          // 必须按 level 精确取 proxy，不能拿排序后的第一行。
          // 没有 proxy 数据时第一行是 timeline，若沿用 "proxy" 这个标签，
          // 就会把「启发式推断」报成「逐请求精确」—— 而这张卡的全部意义
          // 恰恰是诚实展示可信度。proxy 为 0 本身就是有用信息
          // （说明 cc-switch 代理没开，见 ARCHITECTURE §4.2）。
          attrRows.length > 0 ? (
            <Mono tone="muted">
              proxy {fmtPct(attrRows.find((r) => r.level === "proxy")?.share ?? 0)}
            </Mono>
          ) : undefined
        }
      >
        {attrRows.length > 0 ? (
          <>
            <div
              className="stackbar"
              role="img"
              aria-label={attrRows.map((i) => `${i.level} ${i.share.toFixed(1)}%`).join("，")}
            >
              {attrRows.map((i) => (
                <span
                  key={i.level}
                  className="stackbar__seg"
                  style={{ width: `${i.share}%`, background: attrColor(i.level, t) }}
                />
              ))}
            </div>
            <ul className="attr-list">
              {attrRows.map((i) => (
                <li className="attr-list__row" key={i.level}>
                  <span
                    className="attr-list__swatch"
                    style={{ background: attrColor(i.level, t) }}
                    aria-hidden="true"
                  />
                  <span className="attr-list__name">{i.level}</span>
                  <span className="attr-list__n">{i.bucket.events.toLocaleString("en-US")}</span>
                  <span className="attr-list__pct">{fmtPct(i.share)}</span>
                </li>
              ))}
            </ul>
            <div className="ring__foot">
              <Mono tone="muted">tokens</Mono>
              <Mono>{fmtTokens(attrRows.reduce((a, b) => a + b.bucket.total_tokens, 0))}</Mono>
            </div>
          </>
        ) : (
          <Placeholder state={attribution.error ? "error" : "loading"} height={300} />
        )}
      </Card>

      <BreakdownTable
        title="按会话"
        buckets={sessions.data?.buckets ?? null}
        colors={sessionColors}
        labelOf={sessionLabel}
        subOf={sessionWhere}
        state={sessions.error ? "error" : "loading"}
        span={12}
        limit={12}
        emptyText="区间内没有会话"
      />

      <Card title="星期 × 小时" span={7}>
        {heatmap ? (
          <Chart option={heatmap} height={230} ariaLabel="星期与小时的 token 消耗热力图" />
        ) : (
          <Placeholder state={hours.error ? "error" : "loading"} height={230} />
        )}
      </Card>

      <Card
        title="缓存命中率"
        span={5}
        aside={
          trendPoints.length > 0 ? (
            <Mono>{fmtPct(trendPoints[trendPoints.length - 1]?.cacheReadPct ?? 0)}</Mono>
          ) : undefined
        }
      >
        {trend ? (
          <Chart option={trend} height={230} ariaLabel="cache_read 占比随时间的变化" />
        ) : (
          <Placeholder state={hours.error ? "error" : "loading"} height={230} />
        )}
      </Card>
    </div>
  );
}
