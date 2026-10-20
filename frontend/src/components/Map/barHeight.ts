import type { ExpressionSpecification } from "mapbox-gl";

export type BarHeightStop = readonly [zoom: number, maxHeightMetres: number];

// Physical extrusion heights must fall by MORE than 2x per zoom for the bars
// to get shorter on screen: Web Mercator itself grows about 2x per zoom.
// States and counties use separate scales so switching to county-normalised
// values does not make the largest county jump to state-sized height.
export const STATE_BAR_HEIGHT_STOPS: readonly BarHeightStop[] = [
  [2, 800_000],
  [3, 350_000],
  [4, 150_000],
];

export const COUNTY_BAR_HEIGHT_STOPS: readonly BarHeightStop[] = [
  [4, 80_000],
  [5, 34_000],
  [6, 14_000],
  [7, 6_000],
  [8, 2_500],
  [9, 1_050],
  [10, 450],
  [11, 200],
  [12, 90],
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
