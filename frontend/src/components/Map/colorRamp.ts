/**
 * Color ramp helpers for the choropleth.
 *
 * MAPBOX_SPEC.md says: sequential ramp for unsigned metrics, diverging around 0
 * for signed metrics (YOY_CHANGE). Null values render muted ("no data").
 */

import { MetricKey, type MetricKey as Metric } from "../../types/contracts";
import type { MapFeature } from "../../api/types";

export interface RampStop {
  value: number;
  color: string;
}

const SEQ_COLORS = [
  "#f1eef6",
  "#bdc9e1",
  "#74a9cf",
  "#2b8cbe",
  "#045a8d",
] as const;

const DIVERGING_COLORS = [
  "#b2182b",
  "#ef8a62",
  "#fddbc7",
  "#f7f7f7",
  "#d1e5f0",
  "#67a9cf",
  "#2166ac",
] as const;

export const NO_DATA_COLOR = "#dddddd";
export const SELECTED_OUTLINE = "#1565c0";

function quantileStops(values: number[], colors: readonly string[]): RampStop[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const stops: RampStop[] = [];
  for (let i = 0; i < colors.length; i++) {
    const q = i / (colors.length - 1 || 1);
    const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
    stops.push({ value: sorted[idx]!, color: colors[i]! });
  }
  // Make ascending strictly monotonic (Mapbox `step`/`interpolate` requires it).
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.value <= stops[i - 1]!.value) {
      stops[i]!.value = stops[i - 1]!.value + 1e-9;
    }
  }
  return stops;
}

function divergingStops(values: number[]): RampStop[] {
  if (values.length === 0) return [];
  const abs = values.map(Math.abs).filter((v) => Number.isFinite(v));
  if (abs.length === 0) return [];
  const max = Math.max(...abs);
  if (max === 0) return [{ value: 0, color: DIVERGING_COLORS[3]! }];
  // Symmetric ramp around 0
  const bounds = [-max, -max / 2, -max / 4, 0, max / 4, max / 2, max];
  return bounds.map((value, i) => ({ value, color: DIVERGING_COLORS[i]! }));
}

export function rampForMetric(
  metric: Metric,
  features: MapFeature[],
  opts: { signed?: boolean } = {},
): RampStop[] {
  const values = features
    .map((f) => f.metricValue)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  // A signed view (YoY mode) must use a diverging ramp around 0 regardless of
  // which metric is selected — negative = warm, positive = cool. Otherwise
  // sequential metrics like TIV would let the most-negative get the lightest
  // shade, which reads as "looks good" when it's actually the worst.
  if (opts.signed || metric === MetricKey.YOY_CHANGE) return divergingStops(values);
  return quantileStops(values, SEQ_COLORS);
}

export function colorForValue(value: number | null | undefined, stops: RampStop[]): string {
  if (value === null || value === undefined || !Number.isFinite(value) || stops.length === 0) {
    return NO_DATA_COLOR;
  }
  let chosen = stops[0]!.color;
  for (const stop of stops) {
    if (value >= stop.value) chosen = stop.color;
    else break;
  }
  return chosen;
}
