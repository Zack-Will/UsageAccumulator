import { describe, expect, it } from "vitest";
import type { WindowState } from "../src/api/types";
import { displayWindows, isActiveWindow, quotaSpans } from "../src/components/WindowCards";

function win(kind: string, over: Partial<WindowState> = {}): WindowState {
  return {
    window_kind: kind,
    utilization_pct: 10,
    resets_at: "2026-09-23T13:10:00Z",
    starts_at: "2026-09-23T08:10:00Z",
    projected_pct: { p25: 10, mid: 12, p75: 14 },
    exhaust_eta: null,
    rate_pct_per_min: 0.01,
    burn_curve: [],
    projected_curve: [],
    captured_at: "2026-09-23T08:20:00Z",
    stale: false,
    metrics: {} as WindowState["metrics"],
    attribution: {} as WindowState["attribution"],
    ...over,
  };
}

/** 5h 窗口到期、下一条消息之前：官方给 0% 且没有重置时刻（实测 2026-09-23 16:18） */
const idle5h = win("five_hour", { utilization_pct: 0, resets_at: null, starts_at: null });

describe("displayWindows", () => {
  it("★ 5h 空闲时仍然占位 —— 以前它被当成噪音滤掉，下一张卡被挤上第一行", () => {
    const shown = displayWindows([idle5h, win("seven_day"), win("seven_day_fable")]);
    expect(shown.map((w) => w.window_kind)).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
  });

  it("代号占位字段（0%、没有重置时刻）照旧滤掉", () => {
    const placeholder = win("nimbus_quill", { utilization_pct: 0, resets_at: null, starts_at: null });
    const shown = displayWindows([win("seven_day"), placeholder, idle5h]);
    expect(shown.map((w) => w.window_kind)).toEqual(["five_hour", "seven_day"]);
  });

  it("未知 kind 只要有用量就展示，排在核心窗口之后", () => {
    const extra = win("seven_day_cowork", { utilization_pct: 3 });
    const shown = displayWindows([extra, win("seven_day"), win("five_hour")]);
    expect(shown.map((w) => w.window_kind)).toEqual(["five_hour", "seven_day", "seven_day_cowork"]);
  });

  it("顺序固定：不依赖服务端返回的先后", () => {
    const shown = displayWindows([win("seven_day_fable"), win("five_hour"), win("seven_day")]);
    expect(shown.map((w) => w.window_kind)).toEqual(["five_hour", "seven_day", "seven_day_fable"]);
  });
});

describe("isActiveWindow", () => {
  it("没有重置时刻 = 空闲", () => {
    expect(isActiveWindow(idle5h)).toBe(false);
    expect(isActiveWindow(win("five_hour"))).toBe(true);
  });
});

describe("quotaSpans", () => {
  it.each([1, 2, 3, 4])("%i 张卡正好铺满 12 栅格，中宽下铺满 6 栅格", (n) => {
    const { span, mdSpan } = quotaSpans(n);
    expect((span * n) % 12).toBe(0);
    expect((mdSpan * n) % 6).toBe(0);
  });
});
