/**
 * True when the selection resolves to the Industry client: the cedent itself,
 * one of its offices, chains, or programmes.
 */

import { useMemo } from "react";
import { useCedents } from "../api/hooks";
import { useSelectionStore } from "./selection";

export const INDUSTRY_CEDENT_ID = "ced-industry";

export function useIsIndustryScope(): boolean {
  const cedentId = useSelectionStore((s) => s.cedentId);
  const officeKey = useSelectionStore((s) => s.officeKey);
  const chainId = useSelectionStore((s) => s.chainId);
  const programmeId = useSelectionStore((s) => s.programmeId);
  const { data: cedents } = useCedents();

  return useMemo(() => {
    if (cedentId === INDUSTRY_CEDENT_ID) return true;
    if (officeKey?.cedentId === INDUSTRY_CEDENT_ID) return true;
    if (!chainId && !programmeId) return false;
    const industry = cedents?.cedents.find((c) => c.cedentId === INDUSTRY_CEDENT_ID);
    if (!industry) return false;
    return industry.chains.some(
      (ch) =>
        ch.chainId === chainId ||
        (programmeId != null && ch.programmes.some((p) => p.programmeId === programmeId)),
    );
  }, [cedentId, officeKey, chainId, programmeId, cedents]);
}
