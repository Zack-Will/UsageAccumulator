import { afterEach, describe, expect, it, vi } from "vitest";
import { appBridge } from "../src/app-bridge";

const bridge = { openSettings: vi.fn(), setTheme: vi.fn(), version: () => "0.1.0" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("appBridge", () => {
  it("在外壳里：UA 标记与 window.UaApp 同时存在", () => {
    vi.stubGlobal("UaApp", bridge);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 17) Chrome/140 UsageAccumulatorApp/0.1.0" });
    expect(appBridge()).toBe(bridge);
  });

  it("普通浏览器：没有桥对象", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 UsageAccumulatorApp/0.1.0" });
    expect(appBridge()).toBeNull();
  });

  it("有桥对象但 UA 不对：不认", () => {
    vi.stubGlobal("UaApp", bridge);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Chrome/140" });
    expect(appBridge()).toBeNull();
  });
});
