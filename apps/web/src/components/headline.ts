import type { WindowState } from "../api/types";
import { fmtUntil, fmtWhen, msOf } from "../charts/base";

/**
 * 页首那一行：一句问候 + 一句**当前最要紧的事**。
 *
 * 问候是 Claude 首页的招牌做法；第二句不写客套话，按优先级只挑一件事说：
 *   1. 有窗口会在重置前耗尽 → 哪个窗口、几点、还有多久（warn / danger）
 *   2. 有窗口重置时预计 ≥ 90% → 哪个窗口、预计多少（warn）
 *   3. 都安全 → 本周用了多少、重置时预计多少，再带一句 5h 的现状
 * 数字全部来自服务端的同一份 windows/current，不在这里另算。
 */

export function greeting(nowMs: number): string {
  const h = new Date(nowMs).getHours();
  if (h >= 5 && h < 11) return "早上好";
  if (h >= 11 && h < 13) return "中午好";
  if (h >= 13 && h < 18) return "下午好";
  if (h >= 18 && h < 23) return "晚上好";
  return "夜深了";
}

/** 一句话拆成普通片段与强调片段，渲染时强调片段加粗、按语气上色。 */
export type HeadPart = string | { strong: string };

export interface Headline {
  tone: "ok" | "warn" | "danger";
  parts: HeadPart[];
}

const LABEL: Record<string, string> = {
  five_hour: "5h 窗口",
  seven_day: "本周",
  seven_day_fable: "Fable 周限",
  seven_day_opus: "Fable 周限",
};
const labelOf = (k: string): string => LABEL[k] ?? k;
const pct = (v: number): string => `${Math.round(v)}%`;

export function headline(windows: readonly WindowState[], nowMs: number): Headline | null {
  if (windows.length === 0) return null;
  const active = windows.filter((w) => Number.isFinite(msOf(w.resets_at)));

  // 1. 会耗尽的，最早的那个
  const exhausting = active
    .map((w) => ({ w, eta: msOf(w.exhaust_eta) }))
    .filter((x) => Number.isFinite(x.eta))
    .sort((a, b) => a.eta - b.eta)[0];
  if (exhausting) {
    const remain = exhausting.eta - nowMs;
    return {
      tone: remain < 45 * 60_000 ? "danger" : "warn",
      parts: [
        `${labelOf(exhausting.w.window_kind)}预计 `,
        { strong: fmtWhen(exhausting.eta, nowMs) },
        " 耗尽 · ",
        { strong: fmtUntil(remain) },
      ],
    };
  }

  // 2. 重置时逼近上限的，最高的那个
  const hot = active
    .filter((w) => w.projected_pct.mid >= 90)
    .sort((a, b) => b.projected_pct.mid - a.projected_pct.mid)[0];
  if (hot) {
    return {
      tone: "warn",
      parts: [`${labelOf(hot.window_kind)}重置时预计 `, { strong: pct(hot.projected_pct.mid) }, "，接近上限"],
    };
  }

  // 3. 都安全：以周窗口为主语，带一句 5h
  const parts: HeadPart[] = [];
  const week = active.find((w) => w.window_kind === "seven_day");
  if (week) {
    parts.push("本周已用 ", { strong: pct(week.utilization_pct) }, "，重置时预计 ", {
      strong: pct(week.projected_pct.mid),
    });
  }
  const five = windows.find((w) => w.window_kind === "five_hour");
  if (five) {
    if (parts.length) parts.push(" · ");
    if (Number.isFinite(msOf(five.resets_at))) parts.push("5h 已用 ", { strong: pct(five.utilization_pct) });
    else parts.push("5h 窗口空闲");
  }
  return parts.length ? { tone: "ok", parts } : null;
}
