import { describe, expect, it } from "vitest";
import { formatItemsShort, formatResetTime, formatWindowLabel, quotaLabel } from "../src/utils/format.js";

describe("formatWindowLabel", () => {
  it("derives standard labels", () => {
    expect(formatWindowLabel(1800)).toBe("30m");
    expect(formatWindowLabel(5 * 3600)).toBe("5h");
    expect(formatWindowLabel(3 * 86_400)).toBe("3d");
    expect(formatWindowLabel(604_800)).toBe("1w");
    expect(formatWindowLabel(2 * 604_800)).toBe("2w");
    expect(formatWindowLabel(30 * 86_400)).toBe("1mon");
    expect(formatWindowLabel(90)).toBe("90s");
  });
});

describe("quotaLabel", () => {
  it("prefers windowSeconds-derived label over name", () => {
    expect(quotaLabel({ type: "quota", name: "weekly", windowSeconds: 604_800, remain_time: 0, total: 1, remain: 1 }))
      .toBe("1w");
  });

  it("falls back to name without windowSeconds", () => {
    expect(quotaLabel({ type: "quota", name: "5h", remain_time: 0, total: 1, remain: 1 })).toBe("5h");
  });
});

describe("formatResetTime", () => {
  it("formats countdowns", () => {
    expect(formatResetTime(3 * 86_400)).toBe("3d");
    expect(formatResetTime(2.5 * 86_400)).toBe("2.5d");
    expect(formatResetTime(2 * 3600 + 13 * 60)).toBe("2.2h");
    expect(formatResetTime(300)).toBe("5m");
    expect(formatResetTime(45)).toBe("45s");
    expect(formatResetTime(0)).toBe("");
  });
});

describe("formatItemsShort", () => {
  it("quota with countdown: <周期>(in 剩余时间) 余量", () => {
    expect(
      formatItemsShort([{ type: "quota", name: "5h", remain_time: 2 * 3600 + 30 * 60, total: 100, remain: 37 }]),
    ).toBe("5h(in 2.5h) 37%");
  });

  it("quota label derived from windowSeconds", () => {
    expect(
      formatItemsShort([
        { type: "quota", name: "weekly", windowSeconds: 604_800, remain_time: 3 * 86_400, total: 5, remain: 3 },
      ]),
    ).toBe("1w(in 3d) 60%");
  });

  it("quota without reset time omits countdown", () => {
    expect(formatItemsShort([{ type: "quota", name: "24h", remain_time: 0, total: 100, remain: 80 }])).toBe("24h 80%");
  });

  it("mixed items join with space", () => {
    expect(
      formatItemsShort([
        { type: "quota", name: "5h", remain_time: 300, total: 100, remain: 50 },
        { type: "balance", currency: "cny", balance: 12.5 },
      ]),
    ).toBe("5h(in 5m) 50% ¥12.50");
  });

  it("total<=0 shows raw value", () => {
    expect(formatItemsShort([{ type: "quota", name: "1h", remain_time: 60, total: 0, remain: 3.5 }])).toBe(
      "1h(in 1m) 3.50",
    );
  });
});
