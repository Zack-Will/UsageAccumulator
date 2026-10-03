import { useMemo } from "react";
import type { UaApi, WindowState } from "../api";
import { costSummary } from "../api/derive";
import { fmtTokens, fmtUntil, fmtWhen, msOf } from "../charts/base";
import { ringTone } from "../charts/rings";
import type { Tokens } from "../charts/tokens";
import { useAsync } from "../hooks/useAsync";
import { Card, Cost, Dot, Mono, Num } from "./primitives";

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
  Number.isFinite(msOf(w.resets_at)) || w.utilization_pct > 0;

/** 当前是否有一个正在计时的窗口。5h 窗口到期后、下一条消息之前，官方给的是 0% 且没有重置时刻。 */
export const isActiveWindow = (w: WindowState): boolean => Number.isFinite(msOf(w.resets_at));

/**
 * 核心窗口：**永远占一个位置**，空闲时显示空闲态，而不是从页面上消失。
 * 顺序就是展示顺序。
 *
 * ★ 以前核心窗口和代号占位字段走同一个过滤：5h 窗口一到期（0%、没有重置时刻），
 * 整张卡就被当成噪音筛掉了 —— 顶部只剩两张，下一张卡被栅格自动排版挤上第一行，
 * 第二行凭空空出一块。而「5h 窗口空闲」本身就是一条有用的信息。
 */
/** 本地占比低于它时「满额约」不外推、改用历史参考：20 点里 ±0.5 的取整误差约 2.5%，再小就不可信了 */
const FULL_COST_MIN_LOCAL_PCT = 20;

export const CORE_WINDOW_KINDS = ["five_hour", "seven_day", "seven_day_fable", "seven_day_opus"] as const;

export function displayWindows(all: readonly WindowState[]): WindowState[] {
  const rank = (k: string): number => {
    const i = (CORE_WINDOW_KINDS as readonly string[]).indexOf(k);
    return i === -1 ? CORE_WINDOW_KINDS.length : i;
  };
  return all
    .filter((w) => rank(w.window_kind) < CORE_WINDOW_KINDS.length || isMeaningfulWindow(w))
    .sort((a, b) => rank(a.window_kind) - rank(b.window_kind) || a.window_kind.localeCompare(b.window_kind));
}

/**
 * 顶部一行的列宽按**实际张数**分，保证这一行永远正好铺满 12 栅格：
 * 张数一变（某个周限额不存在、官方多给了一个窗口），下面的卡不会被挤上来。
 */
export function quotaSpans(n: number): { span: number; mdSpan: number } {
  if (n <= 1) return { span: 12, mdSpan: 6 };
  if (n === 2) return { span: 6, mdSpan: 3 };
  if (n === 3) return { span: 4, mdSpan: 2 };
  if (n === 4) return { span: 3, mdSpan: 3 };
  return { span: 4, mdSpan: 2 };
}

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

/**
 * 额度条：已用实心、预计半透明、时间进度一根竖线。
 *
 * 与菜单栏同一套语言（那边是照 Usage Tracker 一比一复刻的）：竖线左边是「按时间
 * 均匀用完的话，现在该到哪」，实心条越过竖线就是用得比时间快。
 * 以前这里是一个 132px 高的圆环，只装得下一个数字；换成条之后同样的信息只要 8px，
 * 而且多出了「时间走到哪了」这一维。
 */
function QuotaBar({
  used,
  projected,
  pace,
  tone,
}: {
  used: number;
  projected: number;
  /** 0..1，窗口时间已过去的比例；null = 不知道窗口起点 */
  pace: number | null;
  tone: "ok" | "warn" | "danger";
}) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return (
    <div
      className={`qbar qbar--${tone}`}
      role="img"
      aria-label={`已用 ${used.toFixed(0)}%，重置时预计 ${projected.toFixed(0)}%${
        pace !== null ? `，窗口时间已过 ${(pace * 100).toFixed(0)}%` : ""
      }`}
    >
      <span className="qbar__proj" style={{ width: `${clamp(projected)}%` }} />
      <span className="qbar__used" style={{ width: `${clamp(used)}%` }} />
      {pace !== null && <span className="qbar__pace" style={{ left: `${clamp(pace * 100)}%` }} />}
    </div>
  );
}

export function WindowCard({
  w,
  nowMs,
  api,
  profileId,
  to,
  nonce,
  span = 4,
  mdSpan = 2,
}: {
  w: WindowState;
  nowMs: number;
  api: UaApi;
  profileId: string;
  /** 页面的区间右端（≈现在）。用它而不是 nowMs 当依赖，否则每秒都会重新取数。 */
  to: string;
  nonce: number;
  span?: number;
  mdSpan?: number;
}) {
  // 空闲：上一个窗口已到期、下一条消息还没来。没有起点，也就没有「窗口内」的任何量
  const idle = !isActiveWindow(w);
  const tone = ringTone(w.utilization_pct, w.projected_pct.mid);
  // 预计值单独取色：它才是「会不会超」的答案，已用量只是现状
  const projTone = w.projected_pct.mid >= 100 ? "danger" : w.projected_pct.mid >= 90 ? "warn" : undefined;
  // 带宽不足 1 个百分点就不写 ±：「±0」不是「很确定」，是区间塌成了一个点，写出来是假精度
  const band = Math.round((w.projected_pct.p75 - w.projected_pct.p25) / 2);

  const etaMs = w.exhaust_eta ? Date.parse(w.exhaust_eta) : NaN;
  const remain = Number.isFinite(etaMs) ? etaMs - nowMs : null;
  const resetMs = msOf(w.resets_at);
  const startMs = msOf(w.starts_at);
  const pace =
    Number.isFinite(resetMs) && Number.isFinite(startMs) && resetMs > startMs
      ? Math.max(0, Math.min(1, (nowMs - startMs) / (resetMs - startMs)))
      : null;
  const label = labelOf(w.window_kind);

  /**
   * 本窗口内的折算 API 费用。
   *
   * 官方只给百分比，不给金额；这里是**按公开价目表把本窗口的 token 折算成
   * 等价 API 费用**，不是实际扣费（订阅制下实际扣的是固定月费）。
   * 取数区间是窗口自己的 starts_at → 现在，与百分比同一段时间。
   */
  const spend = useAsync(
    // ★ 空闲时 starts_at 是 null：照发请求会带上 from=null，服务端按缺省回看 7 天，
    //   5h 卡上就会出现一周的花费。空闲窗口里确实什么都没发生，不必去问。
    (sig) =>
      idle || !w.starts_at
        ? Promise.resolve(null)
        : api.distribution({ profile_id: profileId, from: w.starts_at, to, by: "model" }, sig),
    [api, profileId, w.starts_at, to, nonce, idle],
  );
  // 按模型分桶后再按窗口的家族过滤：7d Fable 只该算 Fable 的量
  const family = windowModelFamily(w.window_kind);
  const buckets = useMemo(() => {
    if (idle) return [];
    const all = spend.data?.buckets ?? null;
    if (!all) return null;
    return family ? all.filter((b) => modelInFamily(b.key, family)) : all;
  }, [spend.data, family, idle]);

  const cost = buckets ? costSummary(buckets) : null;
  const events = buckets ? buckets.reduce((a, b) => a + b.events, 0) : 0;
  const tokens = buckets ? buckets.reduce((a, b) => a + b.total_tokens, 0) : 0;

  /**
   * 这个窗口**打满**值多少钱：$已花 ÷ (本地吃掉的 pct/100)。
   * 7d 上就是周限额的美元等价 —— 回答「这个订阅一周能换多少 API 额度」，
   * 而不是「按当前速率我会花多少」（那是燃尽曲线的问题）。
   *
   * ★ 分母必须是**本地 Claude Code 吃掉的百分比**，不是官方的总百分比。
   * 官方计的是整个账号：网页/App 的聊天窗、手机端、没装探针的机器都算在里面，
   * 而分子（$已花）只有本地事件。分母混进别处的消耗就会把结果系统性压低 ——
   * 2026-09-22 实测有 8 个百分点是在「两小时以上没碰过 Claude Code」时涨的。
   * attribution.local_utilization_pct 已经扣掉了那部分：7d 按官方「按产品」拆分扣，
   * 5h 按差额法与拆分合成扣（没有拆分的组织退回差额法下界）。
   *
   * 归因覆盖不全时**照样扣**：被判定为安静的区间确实没有本地活动，这件事不因为
   * 别处有洞而改变，扣掉它只会让下界更紧。覆盖不全只意味着还有没看见的部分。
   *
   * 不设百分比下限：刚重置时外推倍数大、误差也大，但那是使用者知情的取舍。
   * 与其显示「—」让人什么都看不到，不如给出数字由人自己判断。
   *
   * ★ 但花费为 0 时必须给「—」而不是 $0：那不是「误差大」，是根本没有可外推的
   * 东西（比如本周还没用过 Fable）。算出来的 0 会被读成「周限额是零美元」。
   */
  const attr = w.attribution;
  const localPct = attr ? attr.local_utilization_pct : w.utilization_pct;
  const extrapolated =
    cost?.usd != null && cost.usd > 0 && localPct > 0 ? cost.usd / (localPct / 100) : null;
  /**
   * ★ 本地占比太小时不外推，改用历史参考（服务端 full_cost_reference）。
   * 分母只有几个点时，整数取整（±0.5）加上一两个归属判不清的点，外推误差在 ±20% 以上 ——
   * 2026-10-03 一个 7% 的 5h 窗口外推出 $302，而这个订阅 5h 满额通常在 $100 上下。
   */
  const ref = w.full_cost_reference ?? null;
  const useRef = ref !== null && localPct < FULL_COST_MIN_LOCAL_PCT;
  const fullWindowCost = useRef ? ref.usd : extrapolated;
  const fullWindowPartial = useRef ? ref.partial_output_events : (cost?.partialOutputEvents ?? 0);
  /** 只在真的测到别处的消耗时才占一行字；测到 0 就什么都不说。空闲窗口里没有「窗口内」 */
  const otherPct = idle ? 0 : (attr?.other_pct ?? attr?.other_pct_lower_bound ?? 0);
  /**
   * ★ 显示成「占本窗口已用量的份额」，不是占限额的百分点。
   * 以前写的是 other_pct 本身（占限额）：7d 用了 15%、其中 23% 是 Cowork/聊天时显示「3% 非 Code」，
   * 旁边「本周按产品」卡却写着 Claude Code 77% —— 两个带 % 的数口径不同，读起来就是算错了。
   */
  const otherShare = w.utilization_pct > 0 ? Math.min(100, (otherPct / w.utilization_pct) * 100) : 0;

  const etaTone = remain === null ? "muted" : remain < 45 * 60_000 ? "danger" : "warn";

  return (
    <Card
      title={label}
      span={span}
      mdSpan={mdSpan}
      tone={idle || tone === "ok" ? "plain" : tone}
      aside={
        idle ? (
          <Mono tone="muted">未开始计时</Mono>
        ) : (
          <Mono tone="muted">
            {fmtWhen(resetMs, nowMs)} 重置 · {fmtUntil(resetMs - nowMs)}
          </Mono>
        )
      }
    >
      <div className="quota">
        <div className="quota__head">
          <Num
            value={w.utilization_pct}
            digits={0}
            suffix="%"
            size="xl"
            tone={idle ? "muted" : tone === "ok" ? undefined : tone}
          />
          {/* 空闲窗口没有「重置时」，预计值无从谈起 —— 留空，不写一个假的 0% */}
          {!idle && (
            <span className="quota__proj">
              <Mono tone="muted">重置时预计</Mono>
              <Num value={w.projected_pct.mid} digits={0} suffix="%" size="md" tone={projTone} />
              {band >= 1 && <Mono tone="muted">±{band}</Mono>}
            </span>
          )}
        </div>

        <QuotaBar
          used={idle ? 0 : w.utilization_pct}
          projected={idle ? 0 : w.projected_pct.mid}
          pace={idle ? null : pace}
          tone={tone}
        />

        {/* 会耗尽就是这张卡最响的一句话；不会耗尽就安静地说一声 */}
        <div className={`quota__eta quota__eta--${etaTone}`} title={`${w.rate_pct_per_min.toFixed(2)} %/min`}>
          {idle ? (
            <span>空闲 · 下次使用时开始计时</span>
          ) : remain !== null ? (
            <>
              <Dot tone={etaTone} />
              <span>
                {fmtWhen(etaMs, nowMs)} 耗尽 · {fmtUntil(remain)}
              </span>
            </>
          ) : (
            <span>按当前速率不会耗尽</span>
          )}
        </div>

        {/* 折算费用：官方只给百分比，金额是按价目表折的等价成本，不是实际扣费 */}
        <div className="quota__money">
          <div className="quota__money-col">
            <span className="quota__k">已用</span>
            {/* 过滤后一个桶都不剩 = 这个家族本窗口确实没用过，是 $0 而不是「未知」 */}
            {buckets === null ? (
              <Mono tone="muted">—</Mono>
            ) : (
              <span className="quota__v">
                <Cost
                  usd={buckets.length === 0 ? 0 : cost!.usd}
                  unpriced={cost?.unpricedEvents ?? 0}
                  partial={cost?.partialOutputEvents ?? 0}
                />
              </span>
            )}
            <Mono tone="muted">
              {events.toLocaleString("en-US")} 次调用 · {fmtTokens(tokens)}
            </Mono>
          </div>
          <div className="quota__money-col quota__money-col--end">
            <span className="quota__k">满额约</span>
            <span
              className={`quota__v quota__v--strong${useRef ? " quota__v--ref" : ""}`}
              title={useRef ? `最近 ${ref.windows} 个窗口的中位数` : undefined}
            >
              {/* 已花是下界（有事件的最终输出量没写进 JSONL）→ 满额约也是下界 */}
              {fullWindowCost !== null ? `${fullWindowPartial > 0 ? "≥" : ""}$${fullWindowCost.toFixed(0)}` : "—"}
            </span>
            {/* 不到 1% 时留一位小数，别四舍五入成「0% 非 Code」 */}
            {otherShare >= 0.05 ? (
              <span title={`占限额 ${otherPct.toFixed(2)} 个百分点`}>
                <Mono tone="muted">{otherShare.toFixed(otherShare < 1 ? 1 : 0)}% 非 Code</Mono>
              </span>
            ) : (
              <Mono tone="muted">&nbsp;</Mono>
            )}
          </div>
        </div>
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
