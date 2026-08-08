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

// ── Modelled inundation extent (NOAA National Water Model) ──

/**
 * Mirrors `MAX_BBOX_DEG2` in backend/app/services/nwm_inundation.py. Checked
 * here as well so a wide viewport shows "zoom in" instead of firing a request
 * that can only 422 — the extent is reach-resolution and a wider box is
 * truncated upstream.
 */
export const MAX_INUNDATION_BBOX_DEG2 = 25;

export const bboxAreaDeg2 = (b: [number, number, number, number]) =>
  Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1]);

/**
 * The viewport as an inundation-fetchable bbox, or `null` if it isn't one.
 *
 * Shared by FloodLayer and FloodPanel so their TanStack query keys are
 * identical and one fetch serves both. Rejects rather than clamps: a viewport
 * that wraps the antimeridian, or one wider than the cap, has no single honest
 * bbox, and quietly substituting a different one would draw an extent for
 * ground the user isn't looking at.
 */
export function inundationBbox(
  view: [number, number, number, number] | null,
): [number, number, number, number] | null {
  if (!view) return null;
  const [w, s, e, n] = view;
  if (!(w < e && s < n)) return null;               // wrapped past ±180
  if (w < -180 || e > 180 || s < -90 || n > 90) return null;
  return bboxAreaDeg2(view) <= MAX_INUNDATION_BBOX_DEG2 ? view : null;
}

export interface InundationProps {
  reachId: number | null;
  streamflowCfs: number | null;
}

export type InundationFC = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  InundationProps
>;

export interface InundationResponse {
  generatedAt: string;
  bbox: [number, number, number, number];
  /** Model run the extent came from; null when the service was unreachable. */
  referenceTime: string | null;
  /** Upstream hit its feature cap — water is missing from this view. */
  truncated: boolean;
  /**
   * The model could not be reached. Zero reaches then means "unknown", not
   * "dry" — branch on this rather than on the wording of `notes`.
   */
  unavailable: boolean;
  inundation: InundationFC;
  counts: { reaches: number };
  notes: string[];
  attribution: { model: string; modelUrl: string };
}

export const fetchInundation = (bbox: [number, number, number, number]) =>
  apiGet<InundationResponse>("/flood/inundation", { bbox: bbox.join(",") });

export interface InundationExposureResponse {
  currency: string;
  synthetic: boolean;
  note: string;
  reaches: number;
  truncated: boolean;
  /**
   * The extent is narrower than the synthetic locations are spaced, so a zero
   * means "too small to sample", not "no exposure". Render the caveat, never a
   * bare $0.
   */
  belowResolution: boolean;
  combined: FloodPolygonExposure;
  warnings: string[];
  notes: string[];
}

export const fetchInundationExposure = (bbox: [number, number, number, number]) =>
  apiPost<InundationExposureResponse>("/flood/inundation/exposure", { bbox });
