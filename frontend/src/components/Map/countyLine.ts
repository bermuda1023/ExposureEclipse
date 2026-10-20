import type { ExpressionSpecification } from "mapbox-gl";

// Storm-focused / storm-hit outlines stay visible at every zoom; plain county
// borders fade in just below the county threshold so the country view is not
// a wall of borders. The zoom interpolate must be the top-level expression:
// Mapbox rejects the whole layer when ["zoom"] is nested inside a case.
export function countyLineOpacityExpression(
  countyThreshold: number,
): ExpressionSpecification {
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
    countyThreshold - 0.4,
    opacity(0),
    countyThreshold,
    opacity(0.6),
  ] as unknown as ExpressionSpecification;
}
