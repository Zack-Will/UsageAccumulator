import { describe, expect, it } from "vitest";
import { quotaWeights } from "../src/windows-service.js";

describe("quotaWeights", () => {
  it("总周限对 Fable 按 2 倍计", () => {
    expect(quotaWeights("seven_day")).toEqual({ fable: 2 });
  });

  it("5h 与 Fable 周限不加倍率", () => {
    expect(quotaWeights("five_hour")).toEqual({});
    expect(quotaWeights("seven_day_fable")).toEqual({});
  });

  it("返回副本，调用方改了也不污染标定表", () => {
    quotaWeights("seven_day")["fable"] = 99;
    expect(quotaWeights("seven_day")).toEqual({ fable: 2 });
  });
});
