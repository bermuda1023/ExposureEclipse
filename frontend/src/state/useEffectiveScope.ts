/**
 * Single source of truth for "what programmes are we operating on right now?"
 *
 * Used by every place that talks to the backend (map, pivot, detail, hurricane
 * impact, Excel export) so they always agree. Without this they each had their
 * own copy of the logic — map went portfolio while pivot/export silently fell
 * back to a single deal.
 *
 * Resolution order, narrowest-first:
 *   1. explicit programme / chain / cedent  → that one target
 *   2. office tier                          → all chainIds in that office
 *   3. scope filter chips (office / region / underwriter) → matching chainIds
 *   4. nothing                              → empty target set ⇒ portfolio mode
 */

import { useMemo } from "react";
import { useCedents } from "../api/hooks";
import { useSelectionStore } from "./selection";
import { useScopeFiltersStore } from "./scopeFilters";

export interface EffectiveScope {
  /** Single-cedent target, or null. */
  cedentId: string | null;
  /** Single-chain target, or null. */
  chainId: string | null;
  /** Single-programme target, or null. */
  programmeId: string | null;
  /** Office tier's chainIds, scope filter's chainIds, or undefined for portfolio mode. */
  chainIds: string[] | undefined;
  /** True iff any explicit deal-tier selection is set (programme/chain/cedent/office). */
  hasExplicit: boolean;
  /** True iff one of the scope filter chips is currently active. */
  hasScopeFilter: boolean;
}

export function useEffectiveScope(): EffectiveScope {
  const cedentId = useSelectionStore((s) => s.cedentId);
  const officeKey = useSelectionStore((s) => s.officeKey);
  const chainId = useSelectionStore((s) => s.chainId);
  const programmeId = useSelectionStore((s) => s.programmeId);
  const scopeOffices = useScopeFiltersStore((s) => s.offices);
  const scopeRegions = useScopeFiltersStore((s) => s.regions);
  const scopeUnderwriters = useScopeFiltersStore((s) => s.underwriters);
  const { data: cedents } = useCedents();

  return useMemo(() => {
    const officeChainIds = (() => {
      if (!officeKey || !cedents) return [] as string[];
      const c = cedents.cedents.find((x) => x.cedentId === officeKey.cedentId);
      if (!c) return [] as string[];
      return c.chains.filter((ch) => ch.office === officeKey.office).map((ch) => ch.chainId);
    })();

    const scopeChainIds = (() => {
      if (!cedents) return [] as string[];
      const officeSet = scopeOffices.length ? new Set(scopeOffices) : null;
      const regionSet = scopeRegions.length ? new Set(scopeRegions) : null;
      const uwSet = scopeUnderwriters.length ? new Set(scopeUnderwriters) : null;
      if (!officeSet && !regionSet && !uwSet) return [] as string[];
      const out: string[] = [];
      for (const c of cedents.cedents) {
        if (regionSet && (!c.region || !regionSet.has(c.region))) continue;
        for (const ch of c.chains) {
          if (officeSet && !officeSet.has(ch.office)) continue;
          if (uwSet && !ch.programmes.some((p) => uwSet.has(p.underwriter))) continue;
          out.push(ch.chainId);
        }
      }
      return out;
    })();

    const hasExplicit = Boolean(cedentId || chainId || programmeId || officeChainIds.length > 0);
    const hasScopeFilter =
      scopeOffices.length + scopeRegions.length + scopeUnderwriters.length > 0;

    let chainIds: string[] | undefined;
    if (programmeId || chainId || cedentId) {
      chainIds = undefined;
    } else if (officeChainIds.length > 0) {
      chainIds = officeChainIds;
    } else if (hasScopeFilter && scopeChainIds.length > 0) {
      chainIds = scopeChainIds;
    } else {
      chainIds = undefined;
    }

    return {
      cedentId,
      chainId,
      programmeId,
      chainIds,
      hasExplicit,
      hasScopeFilter,
    };
  }, [
    cedentId,
    officeKey,
    chainId,
    programmeId,
    scopeOffices,
    scopeRegions,
    scopeUnderwriters,
    cedents,
  ]);
}
