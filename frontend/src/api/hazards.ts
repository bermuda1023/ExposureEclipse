/** Per-county hail / tornado / wildfire hazard overlays. */

import { apiGet } from "./client";

export type HazardType = "tornado" | "hail" | "wildfire";

export interface HazardGridPoint {
  lat: number;
  lon: number;
  raw: number;
  normalised: number;
}

export interface HazardLegend {
  title: string;
  unit: string;
  source: string;
  sourceUrl: string;
  rawMin: number;
  rawMax: number;
  palette: string[];
  stops: number[];
  note: string | null;
}

export interface HazardResponse {
  hazard: HazardType;
  grid: HazardGridPoint[];
  stepDeg: number;
  legend: HazardLegend;
}

export const fetchHazard = (hazard: HazardType) =>
  apiGet<HazardResponse>(`/hazards/${hazard}`);
