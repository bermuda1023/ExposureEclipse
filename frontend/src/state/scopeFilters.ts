/**
 * Scope filters — distinct from the analytical `filters` store (which gates
 * peril / occupancy / etc on the fact rows). These filters narrow WHICH
 * programmes participate in the aggregated view: office, region, underwriter.
 *
 * Empty arrays = no filter on that dimension (everything passes).
 * The active filter set is intersected (office ∩ region ∩ underwriter).
 *
 * When the user picks an individual programme / chain / cedent in the rail,
 * the explicit selection wins and these scope filters are ignored for the
 * aggregation request (they keep operating on what's *displayed* in the rail).
 */

import { create } from "zustand";

interface ScopeFiltersState {
  offices: string[];
  regions: string[];
  underwriters: string[];

  setOffices: (vs: string[]) => void;
  setRegions: (vs: string[]) => void;
  setUnderwriters: (vs: string[]) => void;
  clear: () => void;
  hasAny: () => boolean;
}

export const useScopeFiltersStore = create<ScopeFiltersState>((set, get) => ({
  offices: [],
  regions: [],
  underwriters: [],

  setOffices: (vs) => set({ offices: vs }),
  setRegions: (vs) => set({ regions: vs }),
  setUnderwriters: (vs) => set({ underwriters: vs }),
  clear: () => set({ offices: [], regions: [], underwriters: [] }),
  hasAny: () => {
    const s = get();
    return s.offices.length + s.regions.length + s.underwriters.length > 0;
  },
}));
