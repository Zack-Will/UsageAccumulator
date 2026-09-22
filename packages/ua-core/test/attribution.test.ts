import { describe, expect, it } from "vitest";
import {
  attributeQuota,
  attributionIsUsable,
  localPctUpperBound,
  type AttributionEvent,
} from "../src/attribution.js";
import type { QuotaSample } from "../src/windows.js";

const T0 = new Date("2026-09-22T00:00:00Z").getTime();
const min = (m: number) => new Date(T0 + m * 60_000);

/** 按 [分钟, 百分比] 造采样序列 */
function samples(pairs: Array<[number, number]>): QuotaSample[] {
  return pairs.map(([m, pct]) => ({ ts: min(m), pct }));
}
function events(mins: number[]): AttributionEvent[] {
  return mins.map((m) => ({ ts: min(m) }));
}

describe("attributeQuota / 基本判定", () => {
  it("完全没有本地事件时，上升全部记成「别处的」", () => {
    const r = attributeQuota(samples([[0, 10], [5, 12], [10, 13]]), []);
    expect(r.observedPct).toBe(3);
    expect(r.otherPctLowerBound).toBe(3);
    expect(r.ambiguousPct).toBe(0);
    expect(r.quietSpans).toBe(2);
  });

  it("区间内有本地事件 → 判不了，进 ambiguous", () => {
    const r = attributeQuota(samples([[0, 10], [5, 13]]), events([2]));
    expect(r.otherPctLowerBound).toBe(0);
    expect(r.ambiguousPct).toBe(3);
    expect(r.quietSpans).toBe(0);
  });

  it("窗口重置造成的下跌不计入观测量", () => {
    const r = attributeQuota(samples([[0, 90], [5, 95], [10, 2], [15, 4]]), []);
    // 只累加 +5 与 +2，跳过 95→2 的重置
    expect(r.observedPct).toBe(7);
  });
});

describe("attributeQuota / 滞后护栏", () => {
  /**
   * 2026-09-22 实测的中间簇：会话收尾后 13~16 分钟官方表才涨。
   * 区间本身零事件，但离上一条事件还不够远 —— 必须算「判不了」，不能算聊天。
   */
  it("区间零事件、但离上一条事件只有 16 分钟 → 判不了", () => {
    const r = attributeQuota(samples([[35, 20], [40, 21]]), events([24]));
    expect(r.otherPctLowerBound).toBe(0);
    expect(r.ambiguousPct).toBe(1);
  });

  /** 实测的远簇：140 / 399 分钟没碰过 Claude Code，额度照涨。 */
  it("离上一条事件两个多小时 → 确定是别处的", () => {
    const r = attributeQuota(samples([[140, 20], [145, 24]]), events([0]));
    expect(r.otherPctLowerBound).toBe(4);
    expect(r.quietSpans).toBe(1);
  });

  it("护栏长度可调；调短会把滞后误判进来（所以默认要够长）", () => {
    const short = attributeQuota(samples([[35, 20], [40, 21]]), events([24]), {
      quietLeadMs: 5 * 60_000,
    });
    expect(short.otherPctLowerBound).toBe(1);
    const long = attributeQuota(samples([[35, 20], [40, 21]]), events([24]), {
      quietLeadMs: 30 * 60_000,
    });
    expect(long.otherPctLowerBound).toBe(0);
  });
});

describe("attributeQuota / 采样有洞", () => {
  it("间隔超过 maxGapMs 的一段整个跳过，并标记 hasSamplingGap", () => {
    // 0→5 正常 +1；5→200 是个大洞，即使涨了 9 也不能算
    const r = attributeQuota(samples([[0, 10], [5, 11], [200, 20]]), []);
    expect(r.observedPct).toBe(1);
    expect(r.hasSamplingGap).toBe(true);
  });

  it("有洞时归因不可用 —— 调用方该显示「未知」", () => {
    const r = attributeQuota(samples([[0, 10], [5, 11], [200, 20]]), []);
    expect(attributionIsUsable(r)).toBe(false);
  });
});

describe("attributionIsUsable / 0 与「未知」必须分开", () => {
  it("覆盖完整、全程有本地活动 → 可用，other 就是实打实的 0", () => {
    const r = attributeQuota(samples([[0, 0], [5, 3]]), events([2]));
    expect(r.otherPctLowerBound).toBe(0);
    expect(r.ambiguousPct).toBe(3);
    expect(attributionIsUsable(r)).toBe(true);
  });

  it("窗口开头没采到 → 不可用，即使中间测到了安静区间", () => {
    const r = attributeQuota(samples([[0, 10], [5, 11]]), []);
    expect(r.quietSpans).toBe(1);
    expect(attributionIsUsable(r)).toBe(false);
  });

  it("一个采样点都没有 → 不可用", () => {
    expect(attributionIsUsable(attributeQuota([], []))).toBe(false);
  });
});

describe("localPctUpperBound", () => {
  it("从观测总量里扣掉确定属于别处的部分", () => {
    const r = attributeQuota(samples([[0, 0], [5, 4]]), []);
    expect(localPctUpperBound(10, r)).toBe(6);
  });

  it("扣成负数时收敛到 0，不返回负百分比", () => {
    const r = attributeQuota(samples([[0, 0], [5, 20]]), []);
    expect(localPctUpperBound(10, r)).toBe(0);
  });
});

describe("attributeQuota / 输入鲁棒性", () => {
  it("乱序输入不影响结果", () => {
    const ordered = attributeQuota(samples([[0, 10], [5, 11], [10, 13]]), []);
    const shuffled = attributeQuota(samples([[10, 13], [0, 10], [5, 11]]), []);
    expect(shuffled).toEqual(ordered);
  });

  it("不足两个采样点返回空结果", () => {
    expect(attributeQuota(samples([[0, 10]]), []).observedPct).toBe(0);
    expect(attributeQuota([], []).observedPct).toBe(0);
  });

  it("NaN 采样被丢掉而不是污染合计", () => {
    const r = attributeQuota(
      [{ ts: min(0), pct: 10 }, { ts: min(5), pct: Number.NaN }, { ts: min(10), pct: 13 }],
      [],
    );
    expect(r.observedPct).toBe(3);
  });
});

describe("attributeQuota / 窗口开头没采到的部分", () => {
  it("第一个采样点就已经是 12% → 这 12% 单列为 unobserved", () => {
    const r = attributeQuota(samples([[0, 12], [5, 13]]), []);
    expect(r.unobservedPct).toBe(12);
    expect(r.observedPct).toBe(1);
    expect(r.otherPctLowerBound).toBe(1);
  });

  it("窗口从 0 采起时 unobserved 为 0", () => {
    expect(attributeQuota(samples([[0, 0], [5, 2]]), []).unobservedPct).toBe(0);
  });

  it("有没采到的开头 → 归因不可用（分母修不了，只能显示未知）", () => {
    const r = attributeQuota(samples([[0, 12], [5, 13]]), []);
    expect(r.quietSpans).toBe(1);
    expect(attributionIsUsable(r)).toBe(false);
  });
});
