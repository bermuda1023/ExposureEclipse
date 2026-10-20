import { describe, expect, it } from "vitest";
import { validate } from "mapbox-gl/dist/style-spec/index.es.js";
import {
  COUNTY_BAR_HEIGHT_STOPS,
  STATE_BAR_HEIGHT_STOPS,
  barHeightExpression,
  metresPerPixel,
  screenPixels,
} from "../barHeight";
import { countyLineOpacityExpression } from "../countyLine";

// Below this the tallest column reads as flat at a pitched view — the
// production failure where county bars were 5-13 px tall.
const MIN_TALLEST_BAR_PX = 60;
const MAX_TALLEST_BAR_PX = 160;

function styleErrors(type: "line" | "fill-extrusion", paint: Record<string, unknown>) {
  return validate({
    version: 8,
    sources: { tiles: { type: "vector", url: "mapbox://example.tiles" } },
    layers: [{ id: "probe", type, source: "tiles", "source-layer": "probe", paint }],
  }).map((error: { message: string }) => error.message);
}

describe("3D bar height scaling", () => {
  it.each([
    ["state", STATE_BAR_HEIGHT_STOPS],
    ["county", COUNTY_BAR_HEIGHT_STOPS],
  ] as const)("%s bars stay clearly visible but bounded on screen", (_name, stops) => {
    for (const stop of stops) {
      const px = screenPixels(stop);
      expect(px).toBeGreaterThanOrEqual(MIN_TALLEST_BAR_PX);
      expect(px).toBeLessThanOrEqual(MAX_TALLEST_BAR_PX);
    }
  });

  it.each([
    ["state", STATE_BAR_HEIGHT_STOPS],
    ["county", COUNTY_BAR_HEIGHT_STOPS],
  ] as const)("%s bars never grow on screen as the user zooms in", (_name, stops) => {
    const heights = stops.map(screenPixels);
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]).toBeLessThanOrEqual(heights[i - 1]);
    }
  });

  it("does not jump taller when the map switches from states to counties", () => {
    expect(screenPixels(COUNTY_BAR_HEIGHT_STOPS[0])).toBeLessThan(
      screenPixels(STATE_BAR_HEIGHT_STOPS.at(-1)!),
    );
  });

  it("converts pixels with Web Mercator scale", () => {
    expect(metresPerPixel(9) * 2).toBeCloseTo(metresPerPixel(8));
    expect(COUNTY_BAR_HEIGHT_STOPS.find(([z]) => z === 9)![1]).toBeGreaterThan(9_000);
  });

  it("drives height from the normalised feature-state", () => {
    const expression = barHeightExpression(COUNTY_BAR_HEIGHT_STOPS) as unknown[];
    expect(expression.slice(0, 3)).toEqual(["interpolate", ["exponential", 0.5], ["zoom"]]);
    expect(expression[4]).toEqual([
      "*",
      ["coalesce", ["feature-state", "bar"], 0],
      COUNTY_BAR_HEIGHT_STOPS[0][1],
    ]);
  });
});

describe("map paint expressions pass Mapbox style validation", () => {
  it.each([
    ["state", STATE_BAR_HEIGHT_STOPS],
    ["county", COUNTY_BAR_HEIGHT_STOPS],
  ] as const)("%s bar height", (_name, stops) => {
    expect(
      styleErrors("fill-extrusion", { "fill-extrusion-height": barHeightExpression(stops) }),
    ).toEqual([]);
  });

  it("county line opacity", () => {
    expect(styleErrors("line", { "line-opacity": countyLineOpacityExpression(4) })).toEqual([]);
  });

  it("rejects a zoom expression nested below the top level", () => {
    expect(
      styleErrors("line", {
        "line-opacity": [
          "case",
          ["==", ["feature-state", "stormHit"], true],
          0.95,
          ["interpolate", ["linear"], ["zoom"], 3.6, 0, 4, 0.6],
        ],
      }),
    ).not.toEqual([]);
  });
});
