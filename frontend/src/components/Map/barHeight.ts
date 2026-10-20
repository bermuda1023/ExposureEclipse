import type { ExpressionSpecification } from "mapbox-gl";

export type BarHeightStop = readonly [zoom: number, maxHeightMetres: number];

// Physical extrusion heights must fall by MORE than 2x per zoom for the bars
// to get shorter on screen: Web Mercator itself grows about 2x per zoom.
// States and counties use separate scales so switching to county-normalised
// values does not make the largest county jump to state-sized height.
export const STATE_BAR_HEIGHT_STOPS: readonly BarHeightStop[] = [
  [2, 600_000],
  [3, 250_000],
  [4, 100_000],
];

export const COUNTY_BAR_HEIGHT_STOPS: readonly BarHeightStop[] = [
  [4, 55_000],
  [5, 23_000],
  [6, 9_500],
  [7, 3_900],
  [8, 1_600],
  [9, 650],
  [10, 260],
  [11, 105],
  [12, 42],
];

export function barHeightExpression(
  stops: readonly BarHeightStop[],
): ExpressionSpecification {
  // Mapbox requires a zoom expression to be the input of a top-level
  // interpolate/step expression. Nesting interpolate(["zoom"]) inside a
  // multiplication makes addLayer reject the whole extrusion layer.
  const expression: unknown[] = ["interpolate", ["linear"], ["zoom"]];
  for (const [zoom, height] of stops) {
    expression.push(
      zoom,
      ["*", ["coalesce", ["feature-state", "bar"], 0], height],
    );
  }
  return expression as ExpressionSpecification;
}

// Screen size is proportional to physical height × 2^zoom. Kept exported so
// tests can guard against accidentally restoring constant/taller screen bars.
export function relativeScreenHeight([zoom, height]: BarHeightStop): number {
  return height * 2 ** zoom;
}
