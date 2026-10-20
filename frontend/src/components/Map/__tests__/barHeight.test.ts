import { describe, expect, it } from "vitest";
import {
  COUNTY_BAR_HEIGHT_STOPS,
  STATE_BAR_HEIGHT_STOPS,
  barHeightExpression,
  relativeScreenHeight,
} from "../barHeight";

describe("3D bar height scaling", () => {
  it.each([
    ["state", STATE_BAR_HEIGHT_STOPS],
    ["county", COUNTY_BAR_HEIGHT_STOPS],
  ] as const)("%s bars get shorter on screen at every zoom stop", (_name, stops) => {
    const heights = stops.map(relativeScreenHeight);
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]).toBeLessThan(heights[i - 1]);
    }
  });

  it("steps down when the map switches from states to counties", () => {
    const stateAtTransition = relativeScreenHeight(STATE_BAR_HEIGHT_STOPS.at(-1)!);
    const countyAtTransition = relativeScreenHeight(COUNTY_BAR_HEIGHT_STOPS[0]);
    expect(countyAtTransition).toBeLessThan(stateAtTransition * 0.6);
  });

  it("keeps feature-state normalization in the Mapbox expression", () => {
    expect(barHeightExpression(COUNTY_BAR_HEIGHT_STOPS)).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      4, ["*", ["coalesce", ["feature-state", "bar"], 0], 15_000],
      5, ["*", ["coalesce", ["feature-state", "bar"], 0], 6_300],
      6, ["*", ["coalesce", ["feature-state", "bar"], 0], 2_600],
      7, ["*", ["coalesce", ["feature-state", "bar"], 0], 1_250],
      8, ["*", ["coalesce", ["feature-state", "bar"], 0], 600],
      9, ["*", ["coalesce", ["feature-state", "bar"], 0], 280],
      10, ["*", ["coalesce", ["feature-state", "bar"], 0], 130],
      11, ["*", ["coalesce", ["feature-state", "bar"], 0], 60],
      12, ["*", ["coalesce", ["feature-state", "bar"], 0], 28],
    ]);
  });
});
