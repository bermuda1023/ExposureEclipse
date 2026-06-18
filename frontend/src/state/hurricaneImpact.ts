/**
 * Tracks the active hurricane-impact selection (which storm the user clicked)
 * + the resulting county set. Cleared when the user clicks elsewhere or
 * changes the underlying portfolio selection.
 */

import { create } from "zustand";
import type { HurricaneImpactResponse } from "../api/hurricanes";

interface HurricaneImpactState {
  activeStormId: string | null;
  data: HurricaneImpactResponse | null;
  isLoading: boolean;
  error: string | null;

  start: (stormId: string) => void;
  setData: (data: HurricaneImpactResponse) => void;
  setError: (msg: string) => void;
  clear: () => void;
}

export const useHurricaneImpactStore = create<HurricaneImpactState>((set) => ({
  activeStormId: null,
  data: null,
  isLoading: false,
  error: null,

  start: (stormId) => set({ activeStormId: stormId, isLoading: true, error: null, data: null }),
  setData: (data) => set({ data, isLoading: false, error: null }),
  setError: (msg) => set({ error: msg, isLoading: false }),
  clear: () => set({ activeStormId: null, data: null, isLoading: false, error: null }),
}));
