import type { DistributionBucket } from "../api";
import { bucketCacheHitPct, byCostThenTokens, type UsageTotals } from "../api/derive";
import { fmtPct, fmtTokens } from "../charts/base";
import { Card, Cost, Mono, Placeholder } from "./primitives";

/**
 * 区间用量的「头条」—— 图二那块面板的主体：一个大数字、一个金额、
 * 然后是输入 / 输出 / 缓存读 / 缓存写四个小数字和缓存命中率。
 *
 * 以前看板上这些一个都没有：token 总量只在机器分布的柱子里、金额只在一张图的角落、
 * 缓存命中挂在模型环的标题栏里，谁也不是主角。
 */
export function UsageSummary({
  title,
  totals,
  state,
  span = 5,
  mdSpan,
}: {
  title: string;
  totals: UsageTotals | null;
  state: "loading" | "error";
  span?: number;
  mdSpan?: number;
}) {
  return (
    <Card
      title={title}
      span={span}
      mdSpan={mdSpan}
      aside={
        totals ? (
          <span>
            {totals.events.toLocaleString("en-US")} 次调用
            {totals.avgCostPerCall !== null && ` · 均 ${fmtUsdSmall(totals.avgCostPerCall)}`}
          </span>
        ) : undefined
      }
    >
      {totals ? (
        <div className="usum">
          <div className="usum__hero">
            <div className="usum__big">
              <span className="num num--xl">{fmtTokens(totals.totalTokens)}</span>
              <span className="usum__unit">tokens</span>
            </div>
            <div className="usum__big usum__big--end">
              <span className="usum__unit">≈</span>
              <span className="usum__cost">
                <Cost usd={totals.cost.usd} unpriced={totals.cost.unpricedEvents} />
              </span>
            </div>
          </div>

          {/* 第一行：比率与产出；第二行：输入侧的三个组成部分，三格加起来就是输入侧总量。
              「未缓存输入」以前叫「输入」—— Claude Code 几乎整段上下文都走缓存，
              这一格常年只有个位数 × 调用次数，不写明「未缓存」就像是漏了单位 */}
          <div className="usum__grid">
            <Stat k="缓存命中" v={totals.cacheHitPct === null ? "—" : fmtPct(totals.cacheHitPct)}>
              {totals.cacheHitPct !== null && <HitRing pct={totals.cacheHitPct} />}
            </Stat>
            <Stat k="平均上下文" v={totals.avgContext === null ? "—" : fmtTokens(totals.avgContext)} />
            <Stat k="输出" v={fmtTokens(totals.output)} />
            <Stat k="缓存读" v={fmtTokens(totals.cacheRead)} />
            <Stat k="缓存写" v={fmtTokens(totals.cacheWrite)} />
            <Stat k="未缓存输入" v={fmtTokens(totals.input)} />
          </div>
        </div>
      ) : (
        <Placeholder state={state} height={148} />
      )}
    </Card>
  );
}

/** 单次金额常在几分钱量级：两位小数会把 $0.045 显示成 $0.05，所以 1 毛以下给三位 */
export function fmtUsdSmall(v: number): string {
  return `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`;
}

function Stat({ k, v, children }: { k: string; v: string; children?: React.ReactNode }) {
  return (
    <div className="usum__stat">
      <span className="usum__k">{k}</span>
      <span className="usum__v">
        {children}
        {v}
      </span>
    </div>
  );
}

/** 纯 CSS 的小环：一个百分比不值得起一个 canvas。 */
function HitRing({ pct }: { pct: number }) {
  return (
    <span
      className="hitring"
      style={{ ["--p" as string]: Math.max(0, Math.min(100, pct)).toFixed(1) }}
      aria-hidden="true"
    />
  );
}

/**
 * 按模型 / 按机器的明细表。两张表同一个形状，读的人不用重新学怎么看。
 *
 * 列：名字 · token · 金额占比条 · 缓存命中 · 折算金额。
 * 按金额排序、占比条也按金额 —— 这张表回答的是「钱花在哪」，token 只是旁证。
 * 缺价的行金额显示「—†」，占比条留空，而不是按 $0 画一截短条冒充真值。
 */
export function BreakdownTable({
  title,
  aside,
  buckets,
  colors,
  labelOf,
  state,
  span,
  mdSpan,
  emptyText = "区间内没有用量",
  subOf,
  limit,
}: {
  title: string;
  aside?: React.ReactNode;
  buckets: DistributionBucket[] | null;
  colors: Map<string, string>;
  labelOf: (b: DistributionBucket) => string;
  state: "loading" | "error";
  span: number;
  mdSpan?: number;
  emptyText?: string;
  /** 名字后面的灰色小字（按会话时是「项目 · 机器」） */
  subOf?: (b: DistributionBucket) => string | undefined;
  /** 只列前 N 行，其余合成一行「其余 N 个」—— 会话一多就是几百行 */
  limit?: number;
}) {
  const sorted = buckets ? [...buckets].sort(byCostThenTokens) : null;
  const totalCost = sorted?.reduce((a, b) => a + (b.cost_usd ?? 0), 0) ?? 0;
  const rows = sorted && limit && sorted.length > limit ? sorted.slice(0, limit) : sorted;
  const rest = sorted && rows && sorted.length > rows.length ? sorted.slice(rows.length) : null;

  return (
    <Card title={title} span={span} mdSpan={mdSpan} aside={aside}>
      {rows === null ? (
        <Placeholder state={state} height={148} />
      ) : rows.length === 0 ? (
        <div className="btable__empty">
          <Mono tone="muted">{emptyText}</Mono>
        </div>
      ) : (
        <table className="btable">
          <thead>
            <tr>
              <th scope="col" className="btable__name" />
              <th scope="col">tokens</th>
              <th scope="col" className="btable__barcol">占比</th>
              <th scope="col">缓存命中</th>
              <th scope="col">折算</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const share = b.cost_usd !== null && totalCost > 0 ? (b.cost_usd / totalCost) * 100 : null;
              const hit = bucketCacheHitPct(b);
              const color = colors.get(b.key);
              return (
                <tr key={b.key}>
                  <th scope="row" className="btable__name" title={[labelOf(b), subOf?.(b), b.key].filter(Boolean).join("\n")}>
                    <span className="btable__swatch" style={{ background: color }} />
                    <span className="btable__label">{labelOf(b)}</span>
                    {subOf?.(b) && <span className="btable__sub">{subOf(b)}</span>}
                  </th>
                  <td className="btable__tokens">{fmtTokens(b.total_tokens)}</td>
                  <td className="btable__barcol">
                    <span className="btable__track">
                      {share !== null && (
                        <span className="btable__fill" style={{ width: `${share}%`, background: color }} />
                      )}
                    </span>
                    <span className="btable__pct">{share !== null ? `${share.toFixed(0)}%` : "—"}</span>
                  </td>
                  <td className="btable__hit" data-label="命中">{hit === null ? "—" : fmtPct(hit, 0)}</td>
                  <td className="btable__cost">
                    <Cost usd={b.cost_usd} unpriced={b.unpriced_events} />
                  </td>
                </tr>
              );
            })}
            {rest && <RestRow rest={rest} totalCost={totalCost} />}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** 「其余 N 个」：合成一行，金额与 token 照样合计，免得表格底部的数字对不上总数 */
function RestRow({ rest, totalCost }: { rest: DistributionBucket[]; totalCost: number }) {
  const tokens = rest.reduce((a, b) => a + b.total_tokens, 0);
  const priced = rest.filter((b) => b.cost_usd !== null);
  const cost = priced.length ? priced.reduce((a, b) => a + (b.cost_usd ?? 0), 0) : null;
  const unpriced = rest.reduce((a, b) => a + b.unpriced_events, 0);
  const share = cost !== null && totalCost > 0 ? (cost / totalCost) * 100 : null;
  return (
    <tr className="btable__rest">
      <th scope="row" className="btable__name">
        <span className="btable__swatch" />
        <span className="btable__label">其余 {rest.length} 个</span>
      </th>
      <td className="btable__tokens">{fmtTokens(tokens)}</td>
      <td className="btable__barcol">
        <span className="btable__track">
          {share !== null && <span className="btable__fill btable__fill--rest" style={{ width: `${share}%` }} />}
        </span>
        <span className="btable__pct">{share !== null ? `${share.toFixed(0)}%` : "—"}</span>
      </td>
      <td className="btable__hit" data-label="命中">—</td>
      <td className="btable__cost">
        <Cost usd={cost} unpriced={unpriced} />
      </td>
    </tr>
  );
}
