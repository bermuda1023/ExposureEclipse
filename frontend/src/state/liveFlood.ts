/**
 * Live-flood overlay state. One layer — NWS alert polygons — filtered by CAP
 * severity floor. `minSeverity` is the only severity signal that arrives
 * attached to the geometry, so it is how an underwriter narrows to "major
 * flooding". `selectedAlerts` drives the exposed-TIV-by-client rollup.
 */

import { create } from "zustand";
import type { FloodSeverity } from "../api/flood";

export interface SelectedAlert {
  id: string;
  name: string;
  severity: FloodSeverity;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

interface LiveFloodState {
  active: boolean;
  showAlerts: boolean;
  hideExposures: boolean;
  minSeverity: FloodSeverity;
  selectedAlerts: SelectedAlert[];
  toggle: () => void;
  setActive: (v: boolean) => void;
  setShowAlerts: (v: boolean) => void;
  setHideExposures: (v: boolean) => void;
  setMinSeverity: (v: FloodSeverity) => void;
  toggleAlert: (a: SelectedAlert) => void;
  clearAlerts: () => void;
  /** Drop selections no longer present upstream. */
  retainAlerts: (liveIds: Set<string>) => void;
}

export const useLiveFloodStore = create<LiveFloodState>((set, get) => ({
  active: false,
  showAlerts: true,
  hideExposures: false,
  // Severe is the practical "major flooding" floor; anything below is mostly
  // advisories, which would bury the warnings an underwriter cares about.
  minSeverity: "Severe",
  selectedAlerts: [],
  toggle: () => set({ active: !get().active, selectedAlerts: [] }),
  setActive: (v) => set({ active: v }),
  setShowAlerts: (v) => set({ showAlerts: v }),
  setHideExposures: (v) => set({ hideExposures: v }),
  // Raising the floor drops alerts from the map; keeping them selected would
  // leave invisible polygons contributing to the combined TIV.
  setMinSeverity: (v) => set({ minSeverity: v, selectedAlerts: [] }),
  toggleAlert: (a) => {
    const cur = get().selectedAlerts;
    const exists = cur.some((x) => x.id === a.id);
    set({ selectedAlerts: exists ? cur.filter((x) => x.id !== a.id) : [...cur, a] });
  },
  clearAlerts: () => set({ selectedAlerts: [] }),
  // NWS mints a NEW urn when an alert is updated or superseded, so a refetch
  // silently orphans the old one: it keeps its highlight and keeps feeding the
  // combined TIV, but its polygon is gone so it can't be clicked off.
  retainAlerts: (liveIds) => {
    const cur = get().selectedAlerts;
    const next = cur.filter((a) => liveIds.has(a.id));
    if (next.length !== cur.length) set({ selectedAlerts: next });
  },
}));
