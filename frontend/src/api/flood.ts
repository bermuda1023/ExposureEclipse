/**
 * Live flood overlay — active NWS flood watches, warnings and advisories as
 * GeoJSON polygons, plus exposed TIV by client for a selected set of them.
 * Live layer, like the storm and wildfire bundles — not part of the mock plane.
 */

import { apiGet, apiPost } from "./client";

/** NWS CAP severity, ordered. `Severe` is the practical "major flooding" floor. */
export type FloodSeverity = "Unknown" | "Minor" | "Moderate" | "Severe" | "Extreme";

export const SEVERITY_OPTIONS: FloodSeverity[] = [
  "Unknown", "Minor", "Moderate", "Severe", "Extreme",
];

export interface FloodAlertProps {
  /** Stable NWS URN — used directly as the selection key. */
  alertId: string;
  event: string;
  headline: string;
  severity: FloodSeverity;
  /** Numeric twin of `severity` so the map ramp can interpolate. */
  severityRank: number;
  urgency: string;
  certainty: string;
  sentAt: string;
  expiresAt: string;
  areaDesc: string;
}

export type FloodAlertFC = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  FloodAlertProps
>;

export interface FloodAffectedState {
  state: string;
  alertCount: number;
}

export interface FloodResponse {
  generatedAt: string;
  bbox: [number, number, number, number] | null;
  minSeverity: FloodSeverity;
  alerts: FloodAlertFC;
  affectedStates: FloodAffectedState[];
  counts: {
    alerts: number;
    /** Matched the filter but carried no polygon, so cannot be mapped. */
    zoneOnly: number;
  };
  notes: string[];
  attribution: { alerts: string; alertsUrl: string };
}

export const fetchLiveFlood = (
  options: { bbox?: [number, number, number, number]; minSeverity?: FloodSeverity } = {},
) =>
  apiGet<FloodResponse>("/flood/active", {
    bbox: options.bbox ? options.bbox.join(",") : undefined,
    minSeverity: options.minSeverity ?? "Unknown",
  });

// ── Exposed TIV inside flood-alert polygons, by client ──

export interface FloodClientExposure {
  client: string;
  tiv: number;
  locationCount: number;
}

export interface FloodPolygonExposure {
  id: string;
  name: string | null;
  totalTiv: number;
  locationCount: number;
  byClient: FloodClientExposure[];
}

export interface FloodExposureResponse {
  currency: string;
  synthetic: boolean;
  note: string;
  results: FloodPolygonExposure[];
  /**
   * Union across every submitted polygon with each location counted once.
   * Use this rather than summing `results` — adjacent flood warnings overlap,
   * and summing double-counts the shared ground.
   */
  combined: FloodPolygonExposure;
  warnings: string[];
}

export const fetchFloodExposure = (
  polygons: { id: string; name?: string; geometry: GeoJSON.Geometry }[],
) => apiPost<FloodExposureResponse>("/flood/exposure", { polygons });
