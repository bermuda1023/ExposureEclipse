/**
 * Live wildfire overlay — real burn-area perimeters (NIFC/WFIGS) + satellite
 * active-fire heat (NASA FIRMS). One call returns a GeoJSON FeatureCollection
 * of current fire polygons plus thermal-detection points and an affected-state
 * roll-up. Live layer, like the storm bundle — not part of the mock plane.
 */

import { apiGet } from "./client";

export interface WildfirePerimeterProps {
  incidentId: string;
  name: string;
  gisAcres: number | null;
  incidentSizeAcres: number | null;
  percentContained: number | null;
  cause: string | null;
  discoveryAt: string | null;
  perimeterUpdatedAt: string | null;
  state: string | null;
}

export type WildfirePerimeterFC = GeoJSON.FeatureCollection<
  GeoJSON.Polygon | GeoJSON.MultiPolygon,
  WildfirePerimeterProps
>;

export interface ActiveFire {
  lat: number;
  lon: number;
  brightnessK: number | null;
  frpMw: number | null;
  confidence: string | null;
  satellite: string;
  source: string;
  acquiredAt: string;
}

export interface HeatShapeProps {
  detectionCount: number;
  maxFrpMw: number | null;
  sumFrpMw: number | null;
  firstDetectedAt: string | null;
  lastDetectedAt: string | null;
}

export type HeatShapeFC = GeoJSON.FeatureCollection<GeoJSON.Polygon, HeatShapeProps>;

export interface AffectedState {
  state: string;
  fireCount: number;
  acres: number;
}

export interface WildfireAttribution {
  perimeters: string;
  perimetersUrl: string;
  activeFires: string;
  activeFiresUrl: string;
}

export interface WildfireResponse {
  generatedAt: string;
  bbox: [number, number, number, number] | null;
  dayRange: number;
  perimeters: WildfirePerimeterFC;
  heatShapes: HeatShapeFC;
  activeFires: ActiveFire[];
  affectedStates: AffectedState[];
  counts: {
    perimeters: number;
    activeFires: number;
    activeFiresTotal: number;
    heatShapes: number;
  };
  notes: string[];
  attribution: WildfireAttribution;
}

export const fetchLiveWildfire = (
  options: {
    bbox?: [number, number, number, number];
    dayRange?: number;
    includeHeat?: boolean;
  } = {},
) =>
  apiGet<WildfireResponse>("/wildfire/active", {
    bbox: options.bbox ? options.bbox.join(",") : undefined,
    dayRange: options.dayRange ?? 3,
    includeHeat: options.includeHeat ?? true,
  });
