/**
 * Per-county judgment scale.
 *
 * The storm impact already splits each county into local-wind slices
 * (clear, tropical storm, Cat 1–5) and applies the category damage ratio
 * to each slice. This scale is an extra haircut on top of that split:
 *
 *     slice_tiv = county_tiv × areaFraction × scale
 *     loss      = Σ slice_tiv × DR(category)
 *
 * 100% means "use the area split as-is". It is not a substitute for the
 * split. Keyed by (storm_id, geoid). Persisted under a v2 key so haircuts
 * typed against the old whole-county wind stamp are not applied twice.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface CountyOverride {
  /** 0..1; defaults to 1.0 (whole county exposed). */
  exposedFraction: number;
}

interface CountyOverridesState {
  // stormId → geoid → override
  byStorm: Record<string, Record<string, CountyOverride>>;
  set: (stormId: string, geoid: string, partial: Partial<CountyOverride>) => void;
  resetCounty: (stormId: string, geoid: string) => void;
  resetStorm: (stormId: string) => void;
  get: (stormId: string, geoid: string) => CountyOverride;
}

const DEFAULT: CountyOverride = { exposedFraction: 1.0 };

export const useCountyOverridesStore = create<CountyOverridesState>()(
  persist(
    (set, get) => ({
      byStorm: {},
      set: (stormId, geoid, partial) =>
        set((state) => {
          const storm = state.byStorm[stormId] ?? {};
          const cur = storm[geoid] ?? DEFAULT;
          const next = { ...cur, ...partial };
          // If the override matches the default, drop it to keep state lean.
          const stormNext = { ...storm };
          if (next.exposedFraction === 1.0) {
            delete stormNext[geoid];
          } else {
            stormNext[geoid] = next;
          }
          return {
            byStorm: { ...state.byStorm, [stormId]: stormNext },
          };
        }),
      resetCounty: (stormId, geoid) =>
        set((state) => {
          const storm = { ...(state.byStorm[stormId] ?? {}) };
          delete storm[geoid];
          return { byStorm: { ...state.byStorm, [stormId]: storm } };
        }),
      resetStorm: (stormId) =>
        set((state) => {
          const next = { ...state.byStorm };
          delete next[stormId];
          return { byStorm: next };
        }),
      get: (stormId, geoid) =>
        get().byStorm[stormId]?.[geoid] ?? DEFAULT,
    }),
    {
      name: "ee-county-overrides-v2",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
