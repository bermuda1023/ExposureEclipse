/**
 * Per-county exposed-fraction override.
 *
 * Captures the human judgement that a county was only PARTIALLY inside the
 * wind field — e.g. the western half of Charlotte County got hurricane
 * winds, the rest didn't. The exposed fraction multiplies the county's TIV
 * BEFORE the category damage ratio is applied:
 *
 *     effective_tiv   = tiv × exposedFraction
 *     loss_mean       = effective_tiv × DR_mean
 *     loss_low / high = effective_tiv × (DR_mean ∓ DR_sd)
 *
 * Keyed by (storm_id, geoid) since the same county can be partially-vs-
 * fully exposed depending on which storm hit it. Persisted to
 * localStorage so the user's overrides survive a reload.
 *
 * The same machinery would extend naturally to a per-county DR override
 * later (different mean+sd than the category default) if the category
 * picker proves too coarse for some counties.
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
      name: "ee-county-overrides",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
