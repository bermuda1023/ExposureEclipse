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

// NHC-issued coastal Tropical Cyclone watches/warnings, split out of the
// generic NWS alerts stream so we can paint them in the NHC operational
// colour scheme (pink=Hurricane Warning, cyan=TS Watch, etc.) instead of the
// generic severity palette. Zone-coded alerts (no polygon) have geometry:null
// and are counted in the bundle's watchesWarningsZoneOnly field.
export interface NHCWatchWarn {
  alertId: string;
  event: string;
  family:
    | "hurricane"
    | "tropical_storm"
    | "storm_surge"
    | "extreme_wind"
    | "statement"
    | "other";
  color: string;             // NHC operational hex — feed straight to the map paint
  rank: number;              // higher = more severe; drives z-order
  headline: string;
  severity: string;
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

export interface SSTMeta {
  source: "mur" | "synthetic";
  stepDeg: number;
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

export interface ForecastCone {
  ring: [number, number][];   // NHC's cone-of-uncertainty outer boundary
}

export interface SurgePolygon {
  ring: [number, number][];   // one NHC peak-surge coastal band polygon
  surgeRange: string;         // "1-2 ft" | "3-6 ft" | ...
  color: string;              // NHC-provided colour hint (e.g. "blue")
}

export interface WindGridPoint {
  lat: number;
  lon: number;
  windKt: number;
  windDirDeg: number | null;
  sources: number;
  confidence: number;
  nearestObsKm: number | null;
  distScore: number;
  countScore: number;
  agreementScore: number;
  contributorSpreadKt: number | null;
}

export interface WindGridMeta {
  stepDeg: number;
  obsMaxAgeHours: number;
  idwRadiusKm: number;
}

export interface WindObs {
  lat: number;
  lon: number;
  windKt: number;
  windDirDeg: number | null;
  source: "buoy" | "land" | "unknown";
  stationId: string;
  observedAt: string;
}

export interface WindGridCoord {
  lat: number;
  lon: number;
}

export interface WindModelFrame {
  hour: number;                  // forecast hours from "now" (0, 6, 12, ...)
  validTimeUtc: string;
  windKt: number[];              // parallel to grid.cells
  windDirDeg: (number | null)[];
}

export interface WindModelGrid {
  model: "gfs" | "ecmwf";
  stepDeg: number;
  cells: WindGridCoord[];
  frames: WindModelFrame[];
}

export interface ModelForecast {
  model: "gfs" | "ecmwf";
  validTimeUtc: string;
  windKt: number;
  windDirDeg: number | null;
  windGustKt: number | null;
}

export interface PointForecast {
  lat: number;
  lon: number;
  fetchedAtUtc: string;
  forecasts: ModelForecast[];
}

export interface LiveStormBundle {
  storm: LiveStormRow;
  observedTrack: ObservedFix[];
  forecasts: ForecastAdvisory[];
  bbox: [number, number, number, number];
  alerts: WeatherAlert[];
  watchesWarnings: NHCWatchWarn[];
  watchesWarningsZoneOnly: number;
  buoys: BuoyObs[];
  landStations: LandObs[];
  sst: SSTPoint[];
  sstMinC: number | null;
  sstMaxC: number | null;
  sstMeta: SSTMeta;
  observedWindField: WindField;
  forecastWindField: WindField;
  forecastCone: ForecastCone | null;   // live storms only
  peakSurge: SurgePolygon[];           // live storms only; empty when N/A
  windMap: WindGridPoint[];
  windMapMeta: WindGridMeta;
  windObs: WindObs[];
}

// ─────────── ATCF a-deck spaghetti tracks (GEFS/ECMWF-ENS/AI) ───────────

export type ModelFamily =
  | "official"
  | "consensus"
  | "ai"
  | "gfs_det"
  | "gfs_mean"
  | "gefs_ens"
  | "ecmwf_det"
  | "ecmwf_mean"
  | "ecmwf_ens"
  | "regional"
  | "cmc"
  | "ukmet"
  | "navgem"
  | "baseline"
  | "analysis"
  | "other";

export interface ModelFix {
  hoursOut: number;
  lat: number;
  lon: number;
  windKt: number;
  pressureMb: number | null;
}

export interface ModelTrack {
  techId: string;
  label: string;
  family: ModelFamily;
  initCycle: string;
  fixes: ModelFix[];
}

export interface EnvelopeAnchor {
  hoursOut: number;
  lat: number;
  lon: number;
}

export interface EnsembleEnvelope {
  membersUsed: number;
  ring: [number, number][];        // closed lon/lat ring
  anchorHulls: Record<string, EnvelopeAnchor[]>;
}

export interface ModelFamilySummary {
  family: ModelFamily;
  trackCount: number;
  techIds: string[];
}

export interface ModelTracksResponse {
  stormId: string;
  initCycle: string | null;
  availableCycles: string[];
  tracks: ModelTrack[];
  families: ModelFamilySummary[];
  ensembleEnvelope: EnsembleEnvelope | null;
  aiEnvelope: EnsembleEnvelope | null;
  notes: string[];
  attribution: string;
}

export const fetchModelTracks = (
  stormId: string,
  options: { initCycle?: string; includeBaselines?: boolean } = {},
) =>
  apiGet<ModelTracksResponse>(
    `/live/storms/${encodeURIComponent(stormId)}/model-tracks`,
    {
      initCycle: options.initCycle,
      includeBaselines: options.includeBaselines ?? false,
    },
  );

// ─────────── ensemble strike-probability + intensity spread ───────────

export interface CountyStrikeProb {
  geoid: string;
  geographyId: string;
  name: string;
  stateUsps: string;
  centroidLat: number;
  centroidLon: number;
  strikeProbability: number;   // 0..1
  memberCount: number;
  ensembleTotal: number;
  maxIntensityKt: number;
}

export interface IntensityStat {
  hoursOut: number;
  memberCount: number;
  minKt: number;
  meanKt: number;
  maxKt: number;
  stdKt: number;
}

export interface EnsembleRiskResponse {
  stormId: string;
  initCycle: string | null;
  ensembleTotal: number;
  thresholdNm: number;
  strikeByCounty: CountyStrikeProb[];
  intensityByLead: IntensityStat[];
  notes: string[];
  attribution: string;
}

export const fetchEnsembleRisk = (
  stormId: string,
  options: { thresholdNm?: number; allStates?: boolean } = {},
) =>
  apiGet<EnsembleRiskResponse>(
    `/live/storms/${encodeURIComponent(stormId)}/ensemble-risk`,
    {
      thresholdNm: options.thresholdNm,
      allStates: options.allStates ?? false,
    },
  );

export const fetchLiveStormList = () =>
  apiGet<LiveStormListResponse>("/live/storms");

export const fetchWindPointForecast = (lat: number, lon: number) =>
  apiGet<PointForecast>("/live/wind-forecast", { lat, lon });

export const fetchWindModelGrid = (
  bbox: [number, number, number, number],
  model: "gfs" | "ecmwf",
) =>
  apiGet<WindModelGrid>("/live/wind-model-grid", {
    west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3], model,
  });

// POST body for the watch/warning exposure endpoint — mirrors the shape
// used by wildfire + flood.
export interface PolygonExposureInput {
  id: string;
  name?: string | null;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

export interface ClientExposure {
  client: string;
  tiv: number;
  locationCount: number;
}

export interface PolygonExposureOut {
  id: string;
  name: string | null;
  totalTiv: number;
  locationCount: number;
  byClient: ClientExposure[];
}

export interface WatchWarnExposureResponse {
  currency: string;
  synthetic: boolean;
  note: string;
  results: PolygonExposureOut[];
  combined: PolygonExposureOut;
  warnings: string[];
}

export const postWatchWarnExposure = async (
  polygons: PolygonExposureInput[],
): Promise<WatchWarnExposureResponse> => {
  const { apiPost } = await import("./client");
  return apiPost<WatchWarnExposureResponse>(
    "/live/watches-warnings/exposure",
    { polygons },
  );
};

export const fetchLiveStormBundle = (
  stormId: string,
  options: {
    includeObs?: boolean;
    includeAlerts?: boolean;
    includeSst?: boolean;
    includeLand?: boolean;
    includeSurge?: boolean;
    includeWindMap?: boolean;
  } = {},
) =>
  apiGet<LiveStormBundle>(`/live/storms/${encodeURIComponent(stormId)}`, {
    includeObs: options.includeObs ?? true,
    includeAlerts: options.includeAlerts ?? true,
    includeSst: options.includeSst ?? true,
    includeLand: options.includeLand ?? false, // NWS land station fetch is slow
    includeSurge: options.includeSurge ?? true,
    includeWindMap: options.includeWindMap ?? true,
  });
