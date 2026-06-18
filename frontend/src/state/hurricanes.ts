/**
 * Hurricane-overlay state: layer on/off + filters (year range, min category).
 *
 * Defaults are tuned for "interesting at a glance" — recent 15 years of
 * Cat 3+ storms is ~20–30 tracks, dense enough to show patterns but not
 * a wall of spaghetti.
 */

import { create } from "zustand";

export interface HurricaneFiltersState {
  enabled: boolean;
  yearMin: number;
  yearMax: number;
  minCategory: number; // -2..5 (-2 = include no-landfall storms, 0 = TS+, 1..5 = Cat 1..5)
  landfallOnly: boolean;

  setEnabled: (v: boolean) => void;
  setYearRange: (yearMin: number, yearMax: number) => void;
  setMinCategory: (c: number) => void;
  setLandfallOnly: (v: boolean) => void;
  reset: () => void;
}

const DEFAULTS = {
  enabled: false,
  yearMin: 2010,
  yearMax: 2024,
  minCategory: 3,
  landfallOnly: true,
} as const;

export const useHurricaneStore = create<HurricaneFiltersState>((set) => ({
  ...DEFAULTS,
  setEnabled: (v) => set({ enabled: v }),
  setYearRange: (yearMin, yearMax) => set({ yearMin, yearMax }),
  setMinCategory: (c) => set({ minCategory: c }),
  setLandfallOnly: (v) => set({ landfallOnly: v }),
  reset: () => set({ ...DEFAULTS }),
}));
