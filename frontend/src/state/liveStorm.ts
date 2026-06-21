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
import type { LiveStormBundle } from "../api/live";

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

  start: (stormId: string) => void;
  setData: (data: LiveStormBundle) => void;
  setError: (msg: string) => void;
  clear: () => void;
  setToggle: (key: ToggleKey, value: boolean) => void;
}

export type ToggleKey =
  | "showForecastHistory"
  | "showAlerts"
  | "showBuoys"
  | "showLand"
  | "showSst";

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

  start: (stormId) =>
    set({ activeStormId: stormId, isLoading: true, error: null, data: null }),
  setData: (data) => set({ data, isLoading: false, error: null }),
  setError: (msg) => set({ error: msg, isLoading: false }),
  clear: () => set({ activeStormId: null, data: null, isLoading: false, error: null }),
  setToggle: (key, value) => set({ [key]: value } as Partial<LiveStormState>),
}));
