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
import type {
  EnsembleRiskResponse,
  GTWOResponse,
  LiveStormBundle,
  ModelFamily,
  ModelTracksResponse,
  WindModelGrid,
  WindObs,
} from "../api/live";

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
  showWatchesWarnings: boolean;  // NHC coastal TC watches/warnings — split out
                                 // of generic alerts, NHC operational palette
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

  // Model ensemble spaghetti (Phase 2). Lazily fetched when the panel
  // "Model tracks" chip is enabled. Family visibility is per-family so the
  // legend chips can toggle GEFS members separately from AI models etc.
  modelTracks: ModelTracksResponse | null;
  modelTracksStatus: "idle" | "loading" | "ok" | "empty" | "error";
  visibleFamilies: Set<ModelFamily>;
  showModelTracks: boolean;
  showEnsembleEnvelope: boolean;
  showAiEnvelope: boolean;
  // Ensemble strike-probability grid (Phase 3). Same lazy-fetch pattern
  // as the model tracks — one endpoint call per storm per threshold.
  ensembleRisk: EnsembleRiskResponse | null;
  ensembleRiskStatus: "idle" | "loading" | "ok" | "empty" | "error";
  showStrikeProbability: boolean;
  strikeThresholdNm: number;

  // NHC Tropical Weather Outlook (basin-wide "what could become a storm").
  // Independent of the active storm selection — the underwriter can leave
  // this on all the time as a pre-invest signal.
  gtwoData: GTWOResponse | null;
  gtwoStatus: "idle" | "loading" | "ok" | "empty" | "error";
  showGTWO: boolean;
  gtwoWindow: "2" | "5" | "both";

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
  setModelTracks: (r: ModelTracksResponse | null) => void;
  setModelTracksStatus: (
    s: "idle" | "loading" | "ok" | "empty" | "error",
  ) => void;
  toggleFamily: (family: ModelFamily) => void;
  setVisibleFamilies: (families: Set<ModelFamily>) => void;
  setEnsembleRisk: (r: EnsembleRiskResponse | null) => void;
  setEnsembleRiskStatus: (
    s: "idle" | "loading" | "ok" | "empty" | "error",
  ) => void;
  setStrikeThresholdNm: (nm: number) => void;
  setGTWOData: (r: GTWOResponse | null) => void;
  setGTWOStatus: (
    s: "idle" | "loading" | "ok" | "empty" | "error",
  ) => void;
  setGTWOWindow: (w: "2" | "5" | "both") => void;
}

export type ToggleKey =
  | "showForecastHistory"
  | "showAlerts"
  | "showWatchesWarnings"
  | "showBuoys"
  | "showLand"
  | "showSst"
  | "showWindField"
  | "showForecastCone"
  | "showSurge"
  | "showWindMap"
  | "showWindParticles"
  | "showModelTracks"
  | "showEnsembleEnvelope"
  | "showAiEnvelope"
  | "showStrikeProbability"
  | "showGTWO";

export const useLiveStormStore = create<LiveStormState>((set, get) => ({
  activeStormId: null,
  data: null,
  isLoading: false,
  error: null,
  pickerOpen: false,
  showForecastHistory: true,
  showAlerts: true,
  // NHC watches/warnings default ON — they are the primary operational signal
  // for pre-loss underwriting during a live event.
  showWatchesWarnings: true,
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
  modelTracks: null,
  modelTracksStatus: "idle" as const,
  // Defaults: hide the fifty-strong GEFS + ECMWF members initially so the
  // panel doesn't paint fifty overlapping lines the first time it opens.
  // AI models and official + consensus are ON by default — they're the
  // signal an underwriter actually reads first.
  visibleFamilies: new Set<ModelFamily>([
    "official",
    "consensus",
    "ai",
    "gfs_det",
    "ecmwf_det",
    "gfs_mean",
    "ecmwf_mean",
  ]),
  showModelTracks: false,
  showEnsembleEnvelope: false,
  showAiEnvelope: false,
  ensembleRisk: null,
  ensembleRiskStatus: "idle" as const,
  showStrikeProbability: false,
  strikeThresholdNm: 60,
  gtwoData: null,
  gtwoStatus: "idle" as const,
  showGTWO: false,
  gtwoWindow: "5" as const,   // 5-day is the higher-signal default

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
      modelTracks: null,
      modelTracksStatus: "idle",
      ensembleRisk: null,
      ensembleRiskStatus: "idle",
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
  setModelTracks: (r) => set({ modelTracks: r }),
  setModelTracksStatus: (s) => set({ modelTracksStatus: s }),
  toggleFamily: (family) => {
    const cur = get().visibleFamilies;
    const next = new Set(cur);
    if (next.has(family)) next.delete(family);
    else next.add(family);
    set({ visibleFamilies: next });
  },
  setVisibleFamilies: (families) => set({ visibleFamilies: families }),
  setEnsembleRisk: (r) => set({ ensembleRisk: r }),
  setEnsembleRiskStatus: (s) => set({ ensembleRiskStatus: s }),
  setStrikeThresholdNm: (nm) => set({
    strikeThresholdNm: nm,
    // Changing the threshold invalidates the cached result.
    ensembleRisk: null,
    ensembleRiskStatus: "idle",
  }),
  setGTWOData: (r) => set({ gtwoData: r }),
  setGTWOStatus: (s) => set({ gtwoStatus: s }),
  setGTWOWindow: (w) => set({ gtwoWindow: w }),
}));
