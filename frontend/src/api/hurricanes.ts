/**
 * NOAA HURDAT2 historical Atlantic hurricane tracks via the backend.
 * The backend fetches NOAA on cold-start, caches in memory, and filters
 * to keep the payload manageable.
 */

import { apiGet } from "./client";

export interface HurricaneTrackPoint {
  lat: number;
  lon: number;
  windKt: number;
  /** Saffir-Simpson: -1=TD, 0=TS, 1..5=Cat 1..5. */
  category: number;
  /** HURDAT2 status code: TD, TS, HU, EX, SD, SS, LO, WV, DB. */
  status: string;
  datetime: string;
  isLandfall: boolean;
}

export interface HurricaneStorm {
  stormId: string;
  name: string;
  year: number;
  landfallCategory: number; // -2 = none, -1 = TD, 0 = TS, 1..5 = SS
  landfallState: string | null;
  peakWindKt: number;
  /** What the min-category filter compared against: landfall cat if the
   * storm hit land, else peak cat over the lifetime. */
  effectiveCategory: number;
  track: HurricaneTrackPoint[];
}

export interface HurricaneListResponse {
  storms: HurricaneStorm[];
  count: number;
  filters: { yearMin: number; yearMax: number; minCategory: number; landfallOnly: boolean };
}

export interface HurricaneFiltersParams {
  yearMin?: number;
  yearMax?: number;
  minCategory?: number;
  landfallOnly?: boolean;
}

export const listHurricanes = (params: HurricaneFiltersParams = {}) =>
  apiGet<HurricaneListResponse>("/hurricanes", { ...params });

// ───────────────────────── impact ─────────────────────────

export interface ImpactProgrammeContribution {
  datasetId: string;
  tiv: number;
  locationCount: number;
}

export interface ImpactedCounty {
  geographyId: string;        // "US-FL-12086"
  geoid: string;              // "12086"
  name: string;               // "Charlotte"
  state: string;              // "FL"
  centroidLat: number;
  centroidLon: number;
  maxWindKt: number;
  maxCategory: number;
  closestDistanceNm: number;
  rmaxAtClosestNm: number;
  /** Provenance of the Rmax used at closest approach: IBTrACS recon
   * measurement or the Willoughby parametric fallback. */
  rmaxSource: "ibtracs" | "willoughby";
  tiv: number;
  locationCount: number;
  hasData: boolean;
  byProgramme: ImpactProgrammeContribution[];
}

export interface FootprintPoint {
  lat: number;
  lon: number;
  windKt: number;
  rmaxNm: number;
  radiusNm: number;       // 2.5×Rmax legacy "damaging-winds" radius
  rmaxSource: "ibtracs" | "willoughby";
  /** Mean radius of 64-kt winds across the four IBTrACS quadrants, or
   * 2.5×Rmax fallback for pre-2004 storms with no R64 measurement. */
  r64Nm: number;
  r64Source: "ibtracs" | "fallback";
  /** Per-quadrant R64 in nautical miles (NE, SE, SW, NW). null when no
   * IBTrACS measurement — caller falls back to symmetric r64Nm. */
  r64QuadsNm: [number, number, number, number] | null;
}

/** Asymmetric outer-footprint polygon for one fix — the cap that blends
 * with the asymmetric outer cone. Sampled by the backend from per-bearing
 * R64 interpolation so left/right/front/rear widths reflect the storm's
 * actual measured wind asymmetry. */
export interface OuterFootprintRing {
  corners: [number, number][];
  windKt: number;
  r64Nm: number;
  r64Source: "ibtracs" | "fallback";
}

/** One tapered-quad cone segment between two adjacent footprint points.
 * ``corners`` is a closed GeoJSON ring (first vertex repeated at the end).
 * ``windKt`` is the segment midpoint, used to drive Mapbox color interpolation. */
export interface ConeQuad {
  corners: [number, number][];
  windKt: number;
  startWindKt: number;
  endWindKt: number;
}

export interface ImpactSummary {
  countiesImpacted: number;
  countiesWithData: number;
  totalTiv: number;
  totalLocationCount: number;
}

export interface HurricaneImpactResponse {
  stormId: string;
  stormName: string;
  year: number;
  currency: string;
  multiplier: number;
  /** [west, south, east, north] of the impacted-county centroids; null if no impact. */
  bbox: [number, number, number, number] | null;
  /** Contributing track points (each ≥ 64 kt sustained wind, US bbox) with
   * the Rmax used. Frontend renders the visible wind buffer from these so it
   * uses IBTrACS-measured Rmax wherever recon data is available. */
  footprint: FootprintPoint[];
  /** Inner cone — tapered quads at Rmax (eyewall / wind-max core). */
  cone: ConeQuad[];
  /** Outer cone — tapered quads at R64 (hurricane-wind extent). Lopsided
   * to reflect the per-quadrant IBTrACS R64 measurements; rendered with
   * lower opacity so the eyewall core stays readable on top. */
  outerCone: ConeQuad[];
  /** Outer-footprint asymmetric rings (one per ≥64 kt fix). Shape matches
   * the asymmetric outerCone so cap + quad seam reads as one piece. */
  outerFootprint: OuterFootprintRing[];
  summary: ImpactSummary;
  counties: ImpactedCounty[];
}

import { API_BASE, apiPost } from "./client";

export const fetchHurricaneImpact = (
  stormId: string,
  selection: Record<string, unknown>,
  multiplier = 2.5,
) =>
  apiPost<HurricaneImpactResponse>(
    `/hurricanes/${encodeURIComponent(stormId)}/impact?multiplier=${multiplier}`,
    selection,
  );

/** POSTs selection to the export endpoint and triggers a browser download. */
export async function downloadHurricaneImpactXlsx(
  stormId: string,
  selection: Record<string, unknown>,
  multiplier = 2.5,
): Promise<void> {
  const url = `${API_BASE}/hurricanes/${encodeURIComponent(stormId)}/impact/export?multiplier=${multiplier}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(selection),
  });
  if (!resp.ok) {
    throw new Error(`Export failed (${resp.status})`);
  }
  const blob = await resp.blob();
  const cd = resp.headers.get("content-disposition") || "";
  const match = /filename="?([^"]+)"?/.exec(cd);
  const filename = match?.[1] ?? `impact_${stormId}.xlsx`;
  const link = document.createElement("a");
  const objUrl = URL.createObjectURL(blob);
  link.href = objUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objUrl);
}
