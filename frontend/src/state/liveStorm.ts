/**
 * Live-storm mode state. When `activeStormId` is set, the map renders an
 * additional overlay: observed track + every forecast advisory (latest in
 * bold, older as ghost lines) + NWS alerts + buoys/land obs + SST grid.
 *
 * Disjoint from the historical-impact mode (`hurricaneImpact`): turning
 * one on doesn't auto-clear the other, but the panel UI only shows one
 * at a time so they don't visually overlap.
 */

import { create } from "zustand";
import type { LiveStormBundle, WindModelGrid, WindObs } from "../api/live";

export type WindMapMode =
  | "observed"
  | "gfs"
  | "ecmwf"
  | "diff-obs-vs-gfs"
  | "diff-obs-vs-ecmwf"
  | "diff-gfs-vs-ecmwf";

interface LiveStormState {
  activeStormId: string | null;
  data: LiveStormBundle | null;
  isLoading: boolean;
  error: string | null;
  // Layer toggles for the overlay — start with everything on except land
  // stations (NWS API is the slowest source).
  showForecastHistory: boolean;
  showAlerts: boolean;
  showBuoys: boolean;
  showLand: boolean;
  showSst: boolean;
  showWindField: boolean;     // Rmax + R64 cones on observed + forecast tracks
  showForecastCone: boolean;  // NHC's official cone of uncertainty
  showSurge: boolean;         // NHC peak storm surge coastal polygons
  showWindMap: boolean;       // interpolated surface-wind heatmap

  // Mode of the wind-map layer: obs / model / diff. On mode change we lazy
  // -fetch the required model grid(s) once per storm.
  windMapMode: WindMapMode;
  gfsGrid: WindModelGrid | null;
  ecmwfGrid: WindModelGrid | null;

  // "Show which stations contributed to this cell" drill-down. When set, the
  // map highlights these obs and dims all others.
  highlightObs: WindObs[] | null;

  start: (stormId: string) => void;
  setData: (data: LiveStormBundle) => void;
  setError: (msg: string) => void;
  clear: () => void;
  setToggle: (key: ToggleKey, value: boolean) => void;
  setWindMapMode: (mode: WindMapMode) => void;
  setGfsGrid: (g: WindModelGrid | null) => void;
  setEcmwfGrid: (g: WindModelGrid | null) => void;
  setHighlightObs: (obs: WindObs[] | null) => void;
}

export type ToggleKey =
  | "showForecastHistory"
  | "showAlerts"
  | "showBuoys"
  | "showLand"
  | "showSst"
  | "showWindField"
  | "showForecastCone"
  | "showSurge"
  | "showWindMap";

export const useLiveStormStore = create<LiveStormState>((set) => ({
  activeStormId: null,
  data: null,
  isLoading: false,
  error: null,
  showForecastHistory: true,
  showAlerts: true,
  showBuoys: true,
  showLand: false,
  showSst: true,
  showWindField: true,
  showForecastCone: true,
  showSurge: true,
  showWindMap: true,
  windMapMode: "observed" as WindMapMode,
  gfsGrid: null,
  ecmwfGrid: null,
  highlightObs: null,

  start: (stormId) =>
    set({
      activeStormId: stormId,
      isLoading: true,
      error: null,
      data: null,
      // Clear model grids on storm switch — bbox differs.
      gfsGrid: null,
      ecmwfGrid: null,
      highlightObs: null,
      windMapMode: "observed",
    }),
  setData: (data) => set({ data, isLoading: false, error: null }),
  setError: (msg) => set({ error: msg, isLoading: false }),
  clear: () => set({
    activeStormId: null, data: null, isLoading: false, error: null,
    gfsGrid: null, ecmwfGrid: null, highlightObs: null,
    windMapMode: "observed",
  }),
  setToggle: (key, value) => set({ [key]: value } as Partial<LiveStormState>),
  setWindMapMode: (mode) => set({ windMapMode: mode }),
  setGfsGrid: (g) => set({ gfsGrid: g }),
  setEcmwfGrid: (g) => set({ ecmwfGrid: g }),
  setHighlightObs: (obs) => set({ highlightObs: obs }),
}));
