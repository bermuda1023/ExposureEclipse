/**
 * Active hazard overlay (tornado / hail / wildfire / none).
 * At most one peril visible at a time — flipping between them is a
 * single store update which the layer + legend react to.
 */

import { create } from "zustand";
import type { HazardType } from "../api/hazards";

interface HazardOverlayState {
  active: HazardType | null;
  set: (h: HazardType | null) => void;
  toggle: (h: HazardType) => void;
}

export const useHazardOverlayStore = create<HazardOverlayState>((set, get) => ({
  active: null,
  set: (h) => set({ active: h }),
  toggle: (h) => set({ active: get().active === h ? null : h }),
}));
