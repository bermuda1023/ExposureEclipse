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
  /** Modelled water extent (NWM) — additive to the alert layer, never a
   *  replacement: it is EXPERIMENTAL, riverine-only, and partial-coverage. */
  showInundation: boolean;
  hideExposures: boolean;
  minSeverity: FloodSeverity;
  /** Current map viewport, rounded. The inundation extent is fetched per-view
   *  because a nationwide request truncates upstream. */
  viewBbox: [number, number, number, number] | null;
  selectedAlerts: SelectedAlert[];
  toggle: () => void;
  setActive: (v: boolean) => void;
  setShowAlerts: (v: boolean) => void;
  setShowInundation: (v: boolean) => void;
  setHideExposures: (v: boolean) => void;
  setMinSeverity: (v: FloodSeverity) => void;
  setViewBbox: (b: [number, number, number, number]) => void;
  toggleAlert: (a: SelectedAlert) => void;
  clearAlerts: () => void;
  /** Drop selections no longer present upstream. */
  retainAlerts: (liveIds: Set<string>) => void;
}

export const useLiveFloodStore = create<LiveFloodState>((set, get) => ({
  active: false,
  showAlerts: true,
  // Off by default: it is viewport-scoped and costs a fetch on every pan, and
  // the alert layer is the one that covers the whole country.
  showInundation: false,
  hideExposures: false,
  // Severe is the practical "major flooding" floor; anything below is mostly
  // advisories, which would bury the warnings an underwriter cares about.
  minSeverity: "Severe",
  viewBbox: null,
  selectedAlerts: [],
  // `viewBbox` is cleared alongside every switch that stops it being updated.
  // The layer only pushes the viewport while the extent is on, so a stale box
  // would survive an off-pan-on cycle: the panel would still hold consent for
  // it, both queries would still be inside their 10-minute staleTime, and the
  // underwriter would see the previous city's exposed TIV over the new one.
  toggle: () => set({ active: !get().active, selectedAlerts: [], viewBbox: null }),
  setActive: (v) => set({ active: v, viewBbox: null }),
  setShowAlerts: (v) => set({ showAlerts: v }),
  setShowInundation: (v) => set({ showInundation: v, viewBbox: null }),
  setHideExposures: (v) => set({ hideExposures: v }),
  // Raising the floor drops alerts from the map; keeping them selected would
  // leave invisible polygons contributing to the combined TIV.
  setMinSeverity: (v) => set({ minSeverity: v, selectedAlerts: [] }),
  // Snapped to 0.05° and only stored on a real change: this fires on every pan,
  // and a fresh tuple each time would re-key the inundation query and refetch
  // when nothing meaningful moved.
  //
  // Snapped OUTWARD, not to nearest: rounding all four edges would shrink the
  // box by up to 0.025° a side, so water along the edge of the map would be
  // missing from an extent the user is looking straight at.
  setViewBbox: (b) => {
    const q = 20; // 1/0.05°
    const next: [number, number, number, number] = [
      Math.floor(b[0] * q) / q, Math.floor(b[1] * q) / q,
      Math.ceil(b[2] * q) / q, Math.ceil(b[3] * q) / q,
    ];
    const cur = get().viewBbox;
    if (cur && cur.every((v, i) => v === next[i])) return;
    set({ viewBbox: next });
  },
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
