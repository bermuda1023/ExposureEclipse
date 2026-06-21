/**
 * Live / replay hurricane endpoints — current Atlantic storms from NHC plus
 * the curated replay set (notable retired storms with full IBTrACS coverage).
 *
 * The bundle endpoint returns everything the live overlay needs in one shot:
 * observed track + forecast advisories (latest + history) + active NWS
 * alerts in the cone + NDBC buoys + NWS land stations + an SST grid.
 */

import { apiGet } from "./client";

export interface LiveStormRow {
  stormId: string;
  name: string;
  year: number;
  classification: string;
  intensityKt: number;
  pressureMb: number | null;
  lat: number | null;
  lon: number | null;
  isLive: boolean;
  label: string;
}

export interface LiveStormListResponse {
  active: LiveStormRow[];
  replay: LiveStormRow[];
  hasActive: boolean;
  note: string | null;
}

export interface ObservedFix {
  lat: number;
  lon: number;
  windKt: number;
  category: number;
  status: string;
  datetime: string;
}

export interface ForecastFix {
  lat: number;
  lon: number;
  windKt: number;
  hoursOut: number;
  validTime: string;
}

export interface ForecastAdvisory {
  advisoryNumber: number;
  issuedAt: string;
  points: ForecastFix[];
  synthetic: boolean;
}

export interface WeatherAlert {
  alertId: string;
  event: string;
  headline: string;
  severity: "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
  urgency: string;
  certainty: string;
  sentAt: string;
  expiresAt: string;
  areasAffected: string;
  geometry: GeoJSON.Geometry | null;
}

export interface BuoyObs {
  stationId: string;
  lat: number;
  lon: number;
  windKt: number | null;
  windDirDeg: number | null;
  gustKt: number | null;
  waveHeightFt: number | null;
  pressureMb: number | null;
  airTempF: number | null;
  waterTempF: number | null;
  observedAt: string;
}

export interface LandObs {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  windKt: number | null;
  windDirDeg: number | null;
  gustKt: number | null;
  pressureMb: number | null;
  tempF: number | null;
  observedAt: string;
}

export interface SSTPoint {
  lat: number;
  lon: number;
  tempC: number;
  favorableForIntensification: boolean;
}

export interface ConeQuad {
  corners: [number, number][];   // closed ring
  windKt: number;
  startWindKt: number;
  endWindKt: number;
}

export interface OuterRing {
  corners: [number, number][];
  windKt: number;
  r64Nm: number;
  r64Source: "ibtracs" | "fallback";
}

export interface WindField {
  innerCone: ConeQuad[];
  outerCone: ConeQuad[];
  outerRings: OuterRing[];
}

export interface LiveStormBundle {
  storm: LiveStormRow;
  observedTrack: ObservedFix[];
  forecasts: ForecastAdvisory[];
  bbox: [number, number, number, number];
  alerts: WeatherAlert[];
  buoys: BuoyObs[];
  landStations: LandObs[];
  sst: SSTPoint[];
  sstMinC: number | null;
  sstMaxC: number | null;
  observedWindField: WindField;
  forecastWindField: WindField;
}

export const fetchLiveStormList = () =>
  apiGet<LiveStormListResponse>("/live/storms");

export const fetchLiveStormBundle = (
  stormId: string,
  options: {
    includeObs?: boolean;
    includeAlerts?: boolean;
    includeSst?: boolean;
    includeLand?: boolean;
  } = {},
) =>
  apiGet<LiveStormBundle>(`/live/storms/${encodeURIComponent(stormId)}`, {
    includeObs: options.includeObs ?? true,
    includeAlerts: options.includeAlerts ?? true,
    includeSst: options.includeSst ?? true,
    includeLand: options.includeLand ?? false, // NWS land station fetch is slow
  });
