import { describe, expect, it } from "vitest";
import { colorForValue, NO_DATA_COLOR, rampForMetric } from "../colorRamp";
import { MetricKey } from "../../../types/contracts";
import type { MapFeature } from "../../../api/types";

function f(geographyId: string, metricValue: number | null): MapFeature {
  return {
    geographyId,
    geographyName: geographyId,
    metricValue,
    tiv: metricValue,
    locationCount: null,
    dealShareOfPortfolioInGeography: null,
    geographyShareOfTotalPortfolio: null,
    selectedDealGeographyConcentration: null,
    clientMarketShare: null,
    yoyChange: null,
    yoyStatus: null,
    hasGeometry: true,
    warnings: [],
  };
}

describe("rampForMetric", () => {
  it("returns sequential stops for TIV", () => {
    const stops = rampForMetric(MetricKey.TIV, [f("A", 1), f("B", 5), f("C", 9)]);
    expect(stops).toHaveLength(5);
    expect(stops[0]!.value).toBeLessThan(stops.at(-1)!.value);
  });
  it("returns diverging stops for YOY_CHANGE around 0", () => {
    const stops = rampForMetric(MetricKey.YOY_CHANGE, [
      f("A", -0.2),
      f("B", 0),
      f("C", 0.3),
    ]);
    const values = stops.map((s) => s.value);
    expect(Math.min(...values)).toBeLessThan(0);
    expect(Math.max(...values)).toBeGreaterThan(0);
  });
  it("returns empty stops for all-null", () => {
    expect(rampForMetric(MetricKey.TIV, [f("A", null), f("B", null)])).toEqual([]);
  });
});

describe("colorForValue", () => {
  it("returns NO_DATA_COLOR for null", () => {
    const stops = rampForMetric(MetricKey.TIV, [f("A", 1), f("B", 9)]);
    expect(colorForValue(null, stops)).toBe(NO_DATA_COLOR);
  });
  it("returns a stop color for in-range values", () => {
    const stops = rampForMetric(MetricKey.TIV, [f("A", 1), f("B", 5), f("C", 9)]);
    const c = colorForValue(5, stops);
    expect(c).toMatch(/^#/);
  });
});
