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
  ReconPoll,
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
  // Overlay chrome minimized to a one-line bar (storm stays on the map).
  collapsed: boolean;
  // Overlay chrome moved to the right-rail Detail panel (map is clear).
  pushedToDetail: boolean;
  // Layer toggles for the overlay — start with everything on except land
  // stations (NWS API is the slowest source).
  showForecastHistory: boolean;
  showAlerts: boolean;
  showWatchesWarnings: boolean;  // NHC coastal TC watches/warnings — split out
                                 // of generic alerts, NHC operational palette
  showBuoys: boolean;
  showRecon: boolean;         // hurricane hunter HDOB + vortex fix
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
  // Nonce of the reload that last started a GFS/Euro fetch. A finished
  // attempt (ok / empty / error) for the current reload is not repeated;
  // Retry bumps `reloadNonce` so the panel fetches again.
  gfsAttemptNonce: number;
  ecmwfAttemptNonce: number;
  // Bumped by Retry. The bundle effect refetches without changing
  // activeStormId and without blanking data already on the map.
  reloadNonce: number;
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

  start: (stormId: string) => void;
  setData: (data: LiveStormBundle) => void;
  setError: (msg: string) => void;
  clear: () => void;
  setPickerOpen: (v: boolean) => void;
  togglePicker: () => void;
  setCollapsed: (v: boolean) => void;
  pushToDetail: () => void;
  popFromDetail: () => void;
  setToggle: (key: ToggleKey, value: boolean) => void;
  setWindMapMode: (mode: WindMapMode) => void;
  setGfsGrid: (g: WindModelGrid | null) => void;
  setEcmwfGrid: (g: WindModelGrid | null) => void;
  setGfsGridStatus: (s: "idle" | "loading" | "ok" | "empty" | "error") => void;
  setEcmwfGridStatus: (s: "idle" | "loading" | "ok" | "empty" | "error") => void;
  setGfsAttemptNonce: (n: number) => void;
  setEcmwfAttemptNonce: (n: number) => void;
  retryLoads: () => void;
  // Swap hunter points (and, when the server still has the buoy field,
  // the observed wind grid) without blanking the rest of the bundle.
  patchRecon: (patch: ReconPoll) => void;
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
}

/** A model grid the map can draw. Cells with no frames, or frames whose
 * winds are all zero, are a failed Open-Meteo response — not a calm Gulf. */
export function windGridUsable(grid: WindModelGrid | null | undefined): boolean {
  if (!grid || !grid.cells?.length || !grid.frames?.length) return false;
  return grid.frames.some(
    (frame) => Array.isArray(frame?.windKt) && frame.windKt.some((kt) => kt > 0),
  );
}

export type ToggleKey =
  | "showForecastHistory"
  | "showAlerts"
  | "showWatchesWarnings"
  | "showBuoys"
  | "showRecon"
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
  collapsed: false,
  pushedToDetail: false,
  showForecastHistory: true,
  showAlerts: true,
  // NHC watches/warnings default ON — they are the primary operational signal
  // for pre-loss underwriting during a live event.
  showWatchesWarnings: true,
  // NDBC buoys and NHC peak-surge polygons default off — they get busy
  // and are usually wanted on demand. The wind swath stays on.
  showBuoys: false,
  showRecon: true,
  showLand: false,
  showSst: false,
  // Wind swath and the consensus envelope are the products underwriters
  // open a live storm to see. They used to default off, so a successful
  // load still looked like "nothing drew".
  showWindField: true,
  showForecastCone: true,
  showSurge: false,
  showWindMap: true,
  showWindParticles: true,
  windMapMode: "observed" as WindMapMode,
  gfsGrid: null,
  ecmwfGrid: null,
  gfsGridStatus: "idle" as const,
  ecmwfGridStatus: "idle" as const,
  gfsAttemptNonce: -1,
  ecmwfAttemptNonce: -1,
  reloadNonce: 0,
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
  showEnsembleEnvelope: true,
  showAiEnvelope: false,
  ensembleRisk: null,
  ensembleRiskStatus: "idle" as const,
  showStrikeProbability: false,
  strikeThresholdNm: 60,
  gtwoData: null,
  gtwoStatus: "idle" as const,
  showGTWO: false,

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
      gfsAttemptNonce: -1,
      ecmwfAttemptNonce: -1,
      reloadNonce: 0,
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
  setPickerOpen: (v) => set({ pickerOpen: v, collapsed: v ? get().collapsed : false }),
  togglePicker: () => set({ pickerOpen: !get().pickerOpen }),
  setCollapsed: (v) => set({ collapsed: v }),
  pushToDetail: () => set({ pushedToDetail: true, pickerOpen: true, collapsed: false }),
  popFromDetail: () => set({ pushedToDetail: false, pickerOpen: true, collapsed: false }),
  clear: () => set({
    activeStormId: null, data: null, isLoading: false, error: null,
    pickerOpen: false, collapsed: false, pushedToDetail: false,
    gfsGrid: null, ecmwfGrid: null,
    gfsGridStatus: "idle", ecmwfGridStatus: "idle",
    gfsAttemptNonce: -1, ecmwfAttemptNonce: -1,
    reloadNonce: 0,
    windMapFrameIndex: 0,
    highlightObs: null,
    windMapMode: "observed",
    // Reset ALL storm-specific data slices — otherwise ModelTrackLayer /
    // StrikeProbabilityLayer keep painting whatever they held from the
    // previous storm. GTWO is intentionally NOT reset — it's a basin-wide
    // overlay independent of any storm selection.
    modelTracks: null,
    modelTracksStatus: "idle",
    ensembleRisk: null,
    ensembleRiskStatus: "idle",
  }),
  setToggle: (key, value) => set({ [key]: value } as Partial<LiveStormState>),
  setWindMapMode: (mode) => set({ windMapMode: mode, windMapFrameIndex: 0 }),
  setGfsGrid: (g) => set({ gfsGrid: g }),
  setEcmwfGrid: (g) => set({ ecmwfGrid: g }),
  setGfsGridStatus: (s) => set({ gfsGridStatus: s }),
  setEcmwfGridStatus: (s) => set({ ecmwfGridStatus: s }),
  setGfsAttemptNonce: (n) => set({ gfsAttemptNonce: n }),
  setEcmwfAttemptNonce: (n) => set({ ecmwfAttemptNonce: n }),
  retryLoads: () => {
    const cur = get();
    if (!cur.activeStormId) return;
    // Keep the bundle and any model grid already on the map. The panel
    // effects watch reloadNonce and replace them when the new response lands.
    set({
      reloadNonce: cur.reloadNonce + 1,
      isLoading: true,
      error: null,
      gfsGridStatus: "idle",
      ecmwfGridStatus: "idle",
      gfsAttemptNonce: -1,
      ecmwfAttemptNonce: -1,
      modelTracksStatus: "loading",
      ensembleRisk: null,
      ensembleRiskStatus: "idle",
    });
  },
  patchRecon: (patch) => {
    const cur = get();
    if (!cur.data) return;
    set({
      data: {
        ...cur.data,
        recon: patch.recon,
        vortex: patch.vortex,
        ...(patch.windMap ? { windMap: patch.windMap } : {}),
        ...(patch.windObs ? { windObs: patch.windObs } : {}),
      },
    });
  },
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
}));
