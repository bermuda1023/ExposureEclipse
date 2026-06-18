/**
 * Filters store — fed into every analytical request body's `filters` block.
 */

import { create } from "zustand";
import { Peril, type ExposureFilters } from "../types/contracts";

type ListDim = Exclude<keyof ExposureFilters, "peril">;

type FiltersState = ExposureFilters & {
  setPeril: (p: Peril) => void;
  toggle: (dim: ListDim, value: string) => void;
  setMulti: (dim: ListDim, values: string[]) => void;
  reset: () => void;
};

const initial: ExposureFilters = {
  peril: Peril.ALL,
  occupancy: [],
  distanceToCoast: [],
  geocoding: [],
  construction: [],
  numberOfStories: [],
  yearBuilt: [],
};

export const useFiltersStore = create<FiltersState>((set, get) => ({
  ...initial,
  setPeril: (p) => set({ peril: p }),
  toggle: (dim, value) => {
    const current = get()[dim];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    set({ [dim]: next } as Pick<FiltersState, ListDim>);
  },
  setMulti: (dim, values) =>
    set({ [dim]: values } as Pick<FiltersState, ListDim>),
  reset: () => set({ ...initial }),
}));
