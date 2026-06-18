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
