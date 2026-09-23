import { describe, expect, it } from "vitest";
import type { WindowState } from "../src/api/types";
import { greeting, headline } from "../src/components/headline";

const NOW = new Date(2026, 8, 23, 16, 0).getTime(); // 本地 16:00
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

function win(kind: string, over: Partial<WindowState> = {}): WindowState {
  return {
    window_kind: kind,
    utilization_pct: 10,
    resets_at: iso(NOW + 3 * H),
    starts_at: iso(NOW - 2 * H),
    projected_pct: { p25: 20, mid: 25, p75: 30 },
    exhaust_eta: null,
    rate_pct_per_min: 0.01,
    burn_curve: [],
    projected_curve: [],
    captured_at: iso(NOW),
    stale: false,
    metrics: {} as WindowState["metrics"],
    attribution: {} as WindowState["attribution"],
    ...over,
  };
}

const text = (h: ReturnType<typeof headline>) =>
  h ? h.parts.map((p) => (typeof p === "string" ? p : p.strong)).join("") : null;

describe("greeting", () => {
  it.each([
    [7, "早上好"],
    [12, "中午好"],
    [16, "下午好"],
    [20, "晚上好"],
    [2, "夜深了"],
  ])("%i 点 → %s", (h, g) => {
    expect(greeting(new Date(2026, 8, 23, h, 0).getTime())).toBe(g);
  });
});

describe("headline / 只挑最要紧的一件事说", () => {
  it("有窗口会耗尽：说哪个窗口、几点、还有多久", () => {
    const h = headline(
      [win("five_hour", { exhaust_eta: iso(NOW + 105 * 60_000) }), win("seven_day")],
      NOW,
    );
    expect(h?.tone).toBe("warn");
    expect(text(h)).toBe("5h 窗口预计 17:45 耗尽 · 1 小时 45 分后");
  });

  it("不到 45 分钟就耗尽：升为 danger", () => {
    const h = headline([win("five_hour", { exhaust_eta: iso(NOW + 30 * 60_000) })], NOW);
    expect(h?.tone).toBe("danger");
  });

  it("多个会耗尽时说最早的那个", () => {
    const h = headline(
      [
        win("seven_day", { exhaust_eta: iso(NOW + 30 * H) }),
        win("five_hour", { exhaust_eta: iso(NOW + 2 * H) }),
      ],
      NOW,
    );
    expect(text(h)).toContain("5h 窗口");
  });

  it("不会耗尽但重置时预计 ≥ 90%：点名最高的那个", () => {
    const h = headline(
      [win("seven_day"), win("seven_day_fable", { projected_pct: { p25: 88, mid: 91, p75: 94 } })],
      NOW,
    );
    expect(h?.tone).toBe("warn");
    expect(text(h)).toBe("Fable 周限重置时预计 91%，接近上限");
  });

  it("都安全：以周窗口为主语，带一句 5h", () => {
    const h = headline(
      [win("five_hour", { utilization_pct: 3 }), win("seven_day", { utilization_pct: 11, projected_pct: { p25: 50, mid: 57, p75: 62 } })],
      NOW,
    );
    expect(h?.tone).toBe("ok");
    expect(text(h)).toBe("本周已用 11%，重置时预计 57% · 5h 已用 3%");
  });

  it("5h 空闲时如实说空闲，不写 0%", () => {
    const h = headline(
      [win("five_hour", { utilization_pct: 0, resets_at: null, starts_at: null }), win("seven_day")],
      NOW,
    );
    expect(text(h)).toContain("5h 窗口空闲");
  });

  it("空闲窗口不参与「会耗尽」的判断", () => {
    const h = headline(
      [win("five_hour", { resets_at: null, starts_at: null, exhaust_eta: iso(NOW + H) }), win("seven_day")],
      NOW,
    );
    expect(h?.tone).toBe("ok");
  });

  it("没有窗口就什么都不说", () => {
    expect(headline([], NOW)).toBeNull();
  });
});
