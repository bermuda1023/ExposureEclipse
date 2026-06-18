/**
 * Selection store — what the user is currently analyzing.
 *
 * Four mutually-exclusive selection types:
 *  - **cedent**: union of all the cedent's chains' latest programmes.
 *  - **office**: union of one cedent's chains FILTERED BY OFFICE (BDA/NYC/LON).
 *  - **chain**:  latest programme in the chain; YoY auto-pairs with prior.
 *  - **programme**: one specific programme/year.
 *
 * Set helpers below clear the other three so only one is active at a time.
 * `comparisonProgrammeId` is an optional override for the chain's auto-prior.
 */

import { create } from "zustand";

export type SelectionKind = "cedent" | "office" | "chain" | "programme" | null;

interface SelectionState {
  cedentId: string | null;
  officeKey: { cedentId: string; office: string } | null;
  chainId: string | null;
  programmeId: string | null;
  comparisonProgrammeId: string | null;

  selectCedent: (id: string | null) => void;
  selectOffice: (cedentId: string, office: string) => void;
  selectChain: (id: string | null) => void;
  selectProgramme: (id: string | null) => void;
  setComparisonProgramme: (id: string | null) => void;
  clear: () => void;

  kind: () => SelectionKind;
}

const empty = {
  cedentId: null,
  officeKey: null,
  chainId: null,
  programmeId: null,
  comparisonProgrammeId: null,
} as const;

export const useSelectionStore = create<SelectionState>((set, get) => ({
  ...empty,

  selectCedent: (id) => set({ ...empty, cedentId: id }),
  selectOffice: (cedentId, office) => set({ ...empty, officeKey: { cedentId, office } }),
  selectChain: (id) => set({ ...empty, chainId: id }),
  selectProgramme: (id) => set({ ...empty, programmeId: id }),
  setComparisonProgramme: (id) => set({ comparisonProgrammeId: id }),
  clear: () => set({ ...empty }),

  kind: () => {
    const s = get();
    if (s.cedentId) return "cedent";
    if (s.officeKey) return "office";
    if (s.chainId) return "chain";
    if (s.programmeId) return "programme";
    return null;
  },
}));
