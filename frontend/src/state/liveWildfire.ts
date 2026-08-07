/**
 * Live-wildfire overlay state. Three independent, toggleable layers:
 *   - perimeters  : official NIFC/WFIGS burn polygons
 *   - heatShapes  : our own footprints, clustered from FIRMS over `heatDays`
 *   - heat        : raw FIRMS satellite detections
 *
 * `heatDays` is the FIRMS look-back (chained ≤5-day windows, up to 14).
 * `minSize` cleans small hotspots (factories / one-off fires). `selectedFire`
 * drives the exposed-TIV-by-client rollup + perimeter highlight.
 */

import { create } from "zustand";

export type MinSize = "all" | "small" | "medium" | "large";

/** minSize → backend cluster filters (min distinct cells, min detections). */
export const MIN_SIZE_PARAMS: Record<MinSize, { minCells: number; minDetections: number }> = {
  all: { minCells: 1, minDetections: 1 },
  small: { minCells: 2, minDetections: 4 },
  medium: { minCells: 3, minDetections: 15 },
  large: { minCells: 5, minDetections: 40 },
};

export interface SelectedFire {
  id: string;
  name: string;
  source: "perimeter" | "heat";
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

interface LiveWildfireState {
  active: boolean;
  showPerimeters: boolean;
  showHeat: boolean;
  showHeatShapes: boolean;
  hideExposures: boolean;
  heatDays: number;
  minSize: MinSize;
  // Multi-select: click a few shapes to combine them into one "fire" for the
  // exposed-TIV rollup + layer calc.
  selectedFires: SelectedFire[];
  toggle: () => void;
  setActive: (v: boolean) => void;
  setShowPerimeters: (v: boolean) => void;
  setShowHeat: (v: boolean) => void;
  setShowHeatShapes: (v: boolean) => void;
  setHideExposures: (v: boolean) => void;
  setHeatDays: (d: number) => void;
  setMinSize: (m: MinSize) => void;
  toggleFire: (f: SelectedFire) => void;
  clearFires: () => void;
}

export const useLiveWildfireStore = create<LiveWildfireState>((set, get) => ({
  active: false,
  showPerimeters: true,
  showHeat: true,
  showHeatShapes: false,
  hideExposures: false,
  heatDays: 3,
  minSize: "small",
  selectedFires: [],
  toggle: () => set({ active: !get().active, selectedFires: [] }),
  setActive: (v) => set({ active: v }),
  setShowPerimeters: (v) => set({ showPerimeters: v }),
  setShowHeat: (v) => set({ showHeat: v }),
  setShowHeatShapes: (v) => set({ showHeatShapes: v }),
  setHideExposures: (v) => set({ hideExposures: v }),
  setHeatDays: (d) => set({ heatDays: d }),
  setMinSize: (m) => set({ minSize: m }),
  toggleFire: (f) => {
    const cur = get().selectedFires;
    const exists = cur.some((x) => x.id === f.id);
    set({ selectedFires: exists ? cur.filter((x) => x.id !== f.id) : [...cur, f] });
  },
  clearFires: () => set({ selectedFires: [] }),
}));
