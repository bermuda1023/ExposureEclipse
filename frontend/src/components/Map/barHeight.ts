import type { ExpressionSpecification } from "mapbox-gl";

export type BarPixelStop = readonly [zoom: number, tallestBarPixels: number];
export type BarHeightStop = readonly [zoom: number, maxHeightMetres: number];

// Mid-CONUS latitude used to convert on-screen pixels to metres. Bars further
// north render slightly taller and further south slightly shorter (cos(lat)).
export const BAR_REFERENCE_LATITUDE = 37;

// Mapbox GL's 512 px tiles: ground metres per screen pixel at zoom 0 on the
// equator.
const METRES_PER_PIXEL_Z0 = 78_271.517;

// Heights are specified as how tall the largest bar (feature-state bar = 1)
// stands on screen, then converted to metres. Specifying metres directly hid
// the fact that a "sensible" 650 m county column is ~5 px at zoom 9.
// Targets taper gently so zooming in never makes columns balloon, and the
// county scale starts below the state scale so the handover does not jump.
export const STATE_BAR_PIXEL_STOPS: readonly BarPixelStop[] = [
  [2, 110],
  [3, 105],
  [4, 100],
];

export const COUNTY_BAR_PIXEL_STOPS: readonly BarPixelStop[] = [
  [4, 90],
  [5, 88],
  [6, 86],
  [7, 84],
  [8, 82],
  [9, 80],
  [10, 78],
  [11, 76],
  [12, 74],
  [13, 72],
  [14, 70],
];

export function metresPerPixel(
  zoom: number,
  latitude: number = BAR_REFERENCE_LATITUDE,
): number {
  return (METRES_PER_PIXEL_Z0 * Math.cos((latitude * Math.PI) / 180)) / 2 ** zoom;
}

export function heightStopsFromPixels(
  stops: readonly BarPixelStop[],
): BarHeightStop[] {
  return stops.map(([zoom, px]) => [zoom, Math.round(px * metresPerPixel(zoom))]);
}

export const STATE_BAR_HEIGHT_STOPS = heightStopsFromPixels(STATE_BAR_PIXEL_STOPS);
export const COUNTY_BAR_HEIGHT_STOPS = heightStopsFromPixels(COUNTY_BAR_PIXEL_STOPS);

export function screenPixels([zoom, height]: BarHeightStop): number {
  return height / metresPerPixel(zoom);
}

export function barHeightExpression(
  stops: readonly BarHeightStop[],
): ExpressionSpecification {
  // Mapbox requires a zoom expression to be the input of a top-level
  // interpolate/step expression. Nesting interpolate(["zoom"]) inside a
  // multiplication makes addLayer reject the whole extrusion layer.
  // Base 0.5 matches Web Mercator's halving of metres-per-pixel per zoom, so
  // screen height stays on target between stops instead of bulging.
  const expression: unknown[] = ["interpolate", ["exponential", 0.5], ["zoom"]];
  for (const [zoom, height] of stops) {
    expression.push(
      zoom,
      ["*", ["coalesce", ["feature-state", "bar"], 0], height],
    );
  }
  return expression as ExpressionSpecification;
}
