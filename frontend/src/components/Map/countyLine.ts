import type { ExpressionSpecification } from "mapbox-gl";

// Storm-focused / storm-hit outlines stay visible at every zoom; plain county
// borders fade in above the county threshold so the country view is not a
// wall of borders. The zoom interpolate must be the top-level expression:
// Mapbox rejects the whole layer when ["zoom"] is nested inside a case.
// Because the value also reads feature-state, Mapbox evaluates it at whole
// tile zooms and blends between them, so a fade must start and end on whole
// zooms: a 3.6 -> 4 fade would draw borders at ~36% across the state view.
export function countyLineOpacityExpression(
  countyThreshold: number,
): ExpressionSpecification {
  const fadeStart = Math.ceil(countyThreshold);
  const opacity = (plain: number) => [
    "case",
    ["==", ["feature-state", "stormFocused"], true],
    1.0,
    ["==", ["feature-state", "stormHit"], true],
    0.95,
    plain,
  ];
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    fadeStart,
    opacity(0),
    fadeStart + 1,
    opacity(0.6),
  ] as unknown as ExpressionSpecification;
}
