import { describe, expect, it } from "vitest";
import { formatMoneyCompact, formatMoneyFull, formatPercent, formatCount } from "../format";

describe("formatMoneyCompact", () => {
  it("renders billions with currency suffix", () => {
    expect(formatMoneyCompact(12_400_000_000, "USD")).toBe("12.4B USD");
  });
  it("renders millions", () => {
    expect(formatMoneyCompact(2_500_000, "EUR")).toBe("2.5M EUR");
  });
  it("returns em-dash for null", () => {
    expect(formatMoneyCompact(null, "USD")).toBe("—");
  });
});

describe("formatPercent", () => {
  it("formats ratio with one decimal", () => {
    expect(formatPercent(0.182)).toBe("18.2%");
  });
  it("returns em-dash for null", () => {
    expect(formatPercent(null)).toBe("—");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(42318)).toBe("42,318");
  });
});

describe("formatMoneyFull", () => {
  it("uses Intl currency formatting when possible", () => {
    const result = formatMoneyFull(12_400_000_000, "USD");
    expect(result).toContain("12,400,000,000");
  });
});
