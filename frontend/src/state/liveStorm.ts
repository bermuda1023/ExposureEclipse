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
  // Picker panel open/closed — driven by the toolbar chip (LiveStormControls).
  pickerOpen: boolean;
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
  showWindParticles: boolean; // animated windy.com-style particles

  // Mode of the wind-map layer: obs / model / diff. On mode change we lazy
  // -fetch the required model grid(s) once per storm. Status is exposed so
  // the panel can distinguish "loading" from "no data available at this
  // bbox" (Open-Meteo's ECMWF variants return nulls over the mid-Pacific).
  windMapMode: WindMapMode;
  gfsGrid: WindModelGrid | null;
  ecmwfGrid: WindModelGrid | null;
  gfsGridStatus: "idle" | "loading" | "ok" | "empty" | "error";
  ecmwfGridStatus: "idle" | "loading" | "ok" | "empty" | "error";
  // Index into the model grid's frames array. 0 = now; higher = further
  // into the forecast. Observed mode ignores this (obs is always "now").
  windMapFrameIndex: number;

  // "Show which stations contributed to this cell" drill-down. When set, the
  // map highlights these obs and dims all others.
  highlightObs: WindObs[] | null;

  start: (stormId: string) => void;
  setData: (data: LiveStormBundle) => void;
  setError: (msg: string) => void;
  clear: () => void;
  setPickerOpen: (v: boolean) => void;
  togglePicker: () => void;
  setToggle: (key: ToggleKey, value: boolean) => void;
  setWindMapMode: (mode: WindMapMode) => void;
  setGfsGrid: (g: WindModelGrid | null) => void;
  setEcmwfGrid: (g: WindModelGrid | null) => void;
  setGfsGridStatus: (s: "idle" | "loading" | "ok" | "empty" | "error") => void;
  setEcmwfGridStatus: (s: "idle" | "loading" | "ok" | "empty" | "error") => void;
  setHighlightObs: (obs: WindObs[] | null) => void;
  setWindMapFrameIndex: (i: number) => void;
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
  | "showWindMap"
  | "showWindParticles";

export const useLiveStormStore = create<LiveStormState>((set, get) => ({
  activeStormId: null,
  data: null,
  isLoading: false,
  error: null,
  pickerOpen: false,
  showForecastHistory: true,
  showAlerts: true,
  // NDBC buoys, wind-field cone, and NHC peak-surge polygons all default
  // OFF now — they get busy fast and users mostly want them on-demand.
  showBuoys: false,
  showLand: false,
  showSst: false,
  showWindField: false,
  showForecastCone: true,
  showSurge: false,
  showWindMap: true,
  showWindParticles: true,
  windMapMode: "observed" as WindMapMode,
  gfsGrid: null,
  ecmwfGrid: null,
  gfsGridStatus: "idle" as const,
  ecmwfGridStatus: "idle" as const,
  windMapFrameIndex: 0,
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
      gfsGridStatus: "idle",
      ecmwfGridStatus: "idle",
      windMapFrameIndex: 0,
      highlightObs: null,
      windMapMode: "observed",
    }),
  setData: (data) => set({ data, isLoading: false, error: null }),
  setError: (msg) => set({ error: msg, isLoading: false }),
  setPickerOpen: (v) => set({ pickerOpen: v }),
  togglePicker: () => set({ pickerOpen: !get().pickerOpen }),
  clear: () => set({
    activeStormId: null, data: null, isLoading: false, error: null,
    gfsGrid: null, ecmwfGrid: null,
    gfsGridStatus: "idle", ecmwfGridStatus: "idle",
    windMapFrameIndex: 0,
    highlightObs: null,
    windMapMode: "observed",
  }),
  setToggle: (key, value) => set({ [key]: value } as Partial<LiveStormState>),
  setWindMapMode: (mode) => set({ windMapMode: mode, windMapFrameIndex: 0 }),
  setGfsGrid: (g) => set({ gfsGrid: g }),
  setEcmwfGrid: (g) => set({ ecmwfGrid: g }),
  setGfsGridStatus: (s) => set({ gfsGridStatus: s }),
  setEcmwfGridStatus: (s) => set({ ecmwfGridStatus: s }),
  setHighlightObs: (obs) => set({ highlightObs: obs }),
  setWindMapFrameIndex: (i) => set({ windMapFrameIndex: i }),
}));
