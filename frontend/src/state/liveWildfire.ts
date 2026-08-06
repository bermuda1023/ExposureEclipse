/**
 * Live-wildfire overlay state. Three independent layers, each toggleable:
 *   - perimeters  : official NIFC/WFIGS burn-area polygons
 *   - heat        : NASA FIRMS satellite active-fire points
 *   - heatShapes  : our own footprints, clustered from FIRMS over `heatDays`
 *
 * Independent of the historical hazard-grid wildfire chip: this is live
 * incident data, so it sits *on top* of the TIV choropleth. `heatDays` is
 * the FIRMS look-back window (FIRMS NRT caps at 5 days).
 */

import { create } from "zustand";

interface LiveWildfireState {
  active: boolean;
  showPerimeters: boolean;
  showHeat: boolean;
  showHeatShapes: boolean;
  heatDays: number;
  selectedIncidentId: string | null;
  toggle: () => void;
  setActive: (v: boolean) => void;
  setShowPerimeters: (v: boolean) => void;
  setShowHeat: (v: boolean) => void;
  setShowHeatShapes: (v: boolean) => void;
  setHeatDays: (d: number) => void;
  selectIncident: (id: string | null) => void;
}

export const useLiveWildfireStore = create<LiveWildfireState>((set, get) => ({
  active: false,
  showPerimeters: true,
  showHeat: true,
  showHeatShapes: false,
  heatDays: 3,
  selectedIncidentId: null,
  toggle: () => set({ active: !get().active, selectedIncidentId: null }),
  setActive: (v) => set({ active: v }),
  setShowPerimeters: (v) => set({ showPerimeters: v }),
  setShowHeat: (v) => set({ showHeat: v }),
  setShowHeatShapes: (v) => set({ showHeatShapes: v }),
  setHeatDays: (d) => set({ heatDays: d }),
  selectIncident: (id) => set({ selectedIncidentId: id }),
}));
