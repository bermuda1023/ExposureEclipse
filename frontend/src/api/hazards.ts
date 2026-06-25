/** Per-county hail / tornado / wildfire hazard overlays. */

import { apiGet } from "./client";

export type HazardType = "tornado" | "hail" | "wildfire";

export interface HazardScore {
  geoid: string;
  raw: number;
  normalised: number;
  rankPct: number;
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
  scores: HazardScore[];
  legend: HazardLegend;
}

export const fetchHazard = (hazard: HazardType) =>
  apiGet<HazardResponse>(`/hazards/${hazard}`);
