/**
 * Live-wildfire overlay state. When `active`, the map draws current WFIGS
 * burn-area perimeters and (optionally) NASA FIRMS satellite-heat points.
 *
 * Independent of the historical hazard-grid wildfire chip: this is live
 * incident data, so it sits *on top* of the TIV choropleth rather than
 * replacing it. `selectedIncidentId` drives the perimeter highlight + panel.
 */

import { create } from "zustand";

interface LiveWildfireState {
  active: boolean;
  showHeat: boolean;
  selectedIncidentId: string | null;
  toggle: () => void;
  setActive: (v: boolean) => void;
  setShowHeat: (v: boolean) => void;
  selectIncident: (id: string | null) => void;
}

export const useLiveWildfireStore = create<LiveWildfireState>((set, get) => ({
  active: false,
  showHeat: true,
  selectedIncidentId: null,
  toggle: () => set({ active: !get().active, selectedIncidentId: null }),
  setActive: (v) => set({ active: v }),
  setShowHeat: (v) => set({ showHeat: v }),
  selectIncident: (id) => set({ selectedIncidentId: id }),
}));
