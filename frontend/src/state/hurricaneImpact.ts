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
  /** Selection payload used for the fetch; kept so the export button can reuse it. */
  selectionPayload: Record<string, unknown> | null;
  /** When true, the right-rail detail panel takes over with the impact view
   * (instead of the usual county detail). */
  pushedToDetail: boolean;

  start: (stormId: string, selectionPayload: Record<string, unknown>) => void;
  setData: (data: HurricaneImpactResponse) => void;
  setError: (msg: string) => void;
  pushToDetail: () => void;
  popFromDetail: () => void;
  clear: () => void;
}

export const useHurricaneImpactStore = create<HurricaneImpactState>((set) => ({
  activeStormId: null,
  data: null,
  isLoading: false,
  error: null,
  selectionPayload: null,
  pushedToDetail: false,

  start: (stormId, selectionPayload) =>
    set({
      activeStormId: stormId,
      isLoading: true,
      error: null,
      data: null,
      selectionPayload,
    }),
  setData: (data) => set({ data, isLoading: false, error: null }),
  setError: (msg) => set({ error: msg, isLoading: false }),
  pushToDetail: () => set({ pushedToDetail: true }),
  popFromDetail: () => set({ pushedToDetail: false }),
  clear: () =>
    set({
      activeStormId: null,
      data: null,
      isLoading: false,
      error: null,
      selectionPayload: null,
      pushedToDetail: false,
    }),
}));
