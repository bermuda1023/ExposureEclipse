/**
 * View store — current grain, metric, selected geography.
 *
 * Per CONTRACTS.md §13 the active view dimensions ARE the group key for
 * max-across-perils computation. For Phase 2 the view is just geography level
 * + metric + a clicked geography; pivot expands the grain in Phase 7.
 */

import { create } from "zustand";
import {
  AggregationLevel,
  MetricKey,
  type AggregationLevel as Level,
  type MetricKey as Metric,
} from "../types/contracts";

import type { Peril } from "../types/contracts";

interface ViewState {
  aggregationLevel: Level;
  metric: Metric;
  selectedGeographyId: string | null;
  /** When true, the map colors by YoY change of the selected metric (requires prior). */
  yoyMode: boolean;
  /** Top-of-page peril multi-select. Empty = all perils. */
  perils: Peril[];
  setAggregationLevel: (level: Level) => void;
  setMetric: (metric: Metric) => void;
  setSelectedGeographyId: (id: string | null) => void;
  setYoyMode: (yoyMode: boolean) => void;
  setPerils: (perils: Peril[]) => void;
  togglePeril: (peril: Peril) => void;
}

export const useViewStore = create<ViewState>((set, get) => ({
  aggregationLevel: AggregationLevel.STATE,
  metric: MetricKey.TIV,
  selectedGeographyId: null,
  yoyMode: false,
  perils: [],
  setAggregationLevel: (level) => set({ aggregationLevel: level, selectedGeographyId: null }),
  setMetric: (metric) => set({ metric }),
  setSelectedGeographyId: (id) => set({ selectedGeographyId: id }),
  setYoyMode: (yoyMode) => set({ yoyMode }),
  setPerils: (perils) => set({ perils }),
  togglePeril: (peril) => {
    const current = get().perils;
    set({
      perils: current.includes(peril)
        ? current.filter((p) => p !== peril)
        : [...current, peril],
    });
  },
}));
