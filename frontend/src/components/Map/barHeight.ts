import type { ExpressionSpecification } from "mapbox-gl";

export type BarHeightStop = readonly [zoom: number, maxHeightMetres: number];

// Physical extrusion heights must fall by MORE than 2x per zoom for the bars
// to get shorter on screen: Web Mercator itself grows about 2x per zoom.
// States and counties use separate scales so switching to county-normalised
// values does not make the largest county jump to state-sized height.
export const STATE_BAR_HEIGHT_STOPS: readonly BarHeightStop[] = [
  [2, 300_000],
  [3, 100_000],
  [4, 30_000],
];

export const COUNTY_BAR_HEIGHT_STOPS: readonly BarHeightStop[] = [
  [4, 15_000],
  [5, 6_300],
  [6, 2_600],
  [7, 1_100],
  [8, 460],
  [9, 195],
  [10, 82],
  [11, 36],
  [12, 16],
];

export function barHeightExpression(
  stops: readonly BarHeightStop[],
): ExpressionSpecification {
  const maxHeight: unknown[] = ["interpolate", ["linear"], ["zoom"]];
  for (const [zoom, height] of stops) maxHeight.push(zoom, height);
  return [
    "*",
    ["coalesce", ["feature-state", "bar"], 0],
    maxHeight,
  ] as ExpressionSpecification;
}

// Screen size is proportional to physical height × 2^zoom. Kept exported so
// tests can guard against accidentally restoring constant/taller screen bars.
export function relativeScreenHeight([zoom, height]: BarHeightStop): number {
  return height * 2 ** zoom;
}
