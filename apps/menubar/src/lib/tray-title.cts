/**
 * 托盘标题的组织逻辑。纯函数，不碰 electron，方便单测。
 *
 * 标题 = 服务端给的 `tray_title_pct` + **本地算出的**倒计时。
 * 倒计时必须本地算（契约 §2.2）：服务端渲染的那个在两次轮询之间就过期了，
 * 所以主进程另开一条 30s 的心跳只重排标题，不发请求。
 *
 * 结构固定为 `[前缀字形] [数字]`，前缀互斥：
 *   - 正常：无前缀
 *   - 预计打满：`▲`（菜单栏不能上色，只能用字形做区分）
 *   - 陈旧 / profile 不一致 / 拉取失败但快照还在保鲜期：`⚠`，数字保留但已被明确标记
 *   - 快照超出保鲜期：只显示 `⚠ 离线`，**不展示过期数字**
 *   - 凭证失效：`⚠ 凭证失效`，数字也不展示 —— 用户必须动手，重试没用
 */
import type { PanelState, Summary } from "./types.cjs";

/** 与契约 §2.2 的 stale 定义对齐：15 分钟。 */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** 托盘标题的自刷新间隔。倒计时只到分钟，30s 心跳足够跟上。 */
export const TRAY_TICK_MS = 30_000;

export interface TrayView {
  title: string;
  tooltip: string;
}

/** 额度紧张 = 有窗口会耗尽，或任一窗口预计打满。 */
export function isTight(summary: Summary | null): boolean {
  if (!summary) return false;
  if (summary.soonest_exhaust !== null) return true;
  return summary.windows.some((w) => w.projected_pct >= 100);
}

/** 毫秒 → "1:48"；≥24h 走 "2d3h"；≤0 走 "0:00"。 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin >= 24 * 60) {
    const d = Math.floor(totalMin / (24 * 60));
    const h = Math.floor((totalMin % (24 * 60)) / 60);
    return h > 0 ? `${d}d${h}h` : `${d}d`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** 百分比部分：优先用服务端渲染的，缺失时取最吃紧窗口兜底。 */
export function pctPart(summary: Summary): string {
  const given = summary.tray_title_pct.trim();
  if (given) return given;
  const pct = summary.windows.reduce((max, w) => Math.max(max, w.pct), 0);
  return `${Math.round(pct)}%`;
}

/** 本地拼出完整数字段：`62% · 1:48`；没有耗尽预期时只留百分比。 */
export function composeNumbers(summary: Summary, now: number): string {
  const head = pctPart(summary);
  const eta = summary.soonest_exhaust;
  if (!eta) return head;
  const at = Date.parse(eta.eta);
  if (Number.isNaN(at)) return head;
  return `${head} · ${formatCountdown(at - now)}`;
}

export function ageText(ageSeconds: number | null): string {
  if (ageSeconds === null) return "无数据";
  if (ageSeconds < 90) return "刚刚";
  const min = Math.round(ageSeconds / 60);
  if (min < 60) return `${min} 分钟前`;
  return `${Math.round(min / 60)} 小时前`;
}

export function composeTray(state: PanelState, now: number = Date.now()): TrayView {
  const { status, summary, snapshotAgeSeconds, profileMismatch, error } = state;

  if (status === "unconfigured") {
    return { title: "未配置", tooltip: "UsageAccumulator · 点击填写服务器地址" };
  }
  if (status === "auth") {
    // 凭证类错误重试无用，数字一并收起，逼用户去动手；两种码的补救动作不同
    const revoked = state.errorCode === "machine_revoked";
    return revoked
      ? { title: "⚠ 已吊销", tooltip: `${error ?? "机器已吊销"} · 需重新 enroll` }
      : { title: "⚠ 凭证失效", tooltip: `${error ?? "凭证失效"} · 到设置里更新 Token` };
  }
  if (status === "loading" || !summary) {
    return { title: "—", tooltip: "UsageAccumulator · 正在获取" };
  }

  const numbers = composeNumbers(summary, now);
  // 快照是否还在保鲜期，由 captured_at 决定（额度新鲜度，不是网络新鲜度）
  const fresh = snapshotAgeSeconds !== null && snapshotAgeSeconds * 1000 < STALE_AFTER_MS;

  if (status === "offline") {
    return {
      title: fresh ? `⚠ ${numbers}` : "⚠ 离线",
      tooltip: `${error ?? "拉取失败"} · 快照 ${ageText(snapshotAgeSeconds)}`,
    };
  }

  if (profileMismatch) {
    // 数字是别的 profile 的，绝不能不声不响地显示
    return {
      title: `⚠ ${numbers}`,
      tooltip: `profile 与本地配置不一致 · 服务端用的是 ${summary.profile_id}`,
    };
  }

  if (status === "stale") {
    return {
      title: `⚠ ${numbers}`,
      tooltip: `额度快照陈旧 · ${ageText(snapshotAgeSeconds)}`,
    };
  }

  const tight = isTight(summary);
  return {
    title: tight ? `▲ ${numbers}` : numbers,
    tooltip: tight ? `预计打满 · ${numbers}` : numbers,
  };
}
