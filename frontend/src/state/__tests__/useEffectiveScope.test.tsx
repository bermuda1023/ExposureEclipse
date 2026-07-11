/**
 * useEffectiveScope — the zero-match scope-filter branch (and its neighbours).
 *
 * The critical case: scope-filter chips are active but match ZERO chains.
 * `chainIds: []` means "portfolio" on the wire, so the hook must flag
 * `isEmpty` instead of falling through to the full-portfolio scope
 * ("Filtered scope" showing the entire portfolio TIV).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffectiveScope } from "../useEffectiveScope";
import { useScopeFiltersStore } from "../scopeFilters";
import { useSelectionStore } from "../selection";
import { queryKeys } from "../../api/hooks";
import { AggregationLevel, ErtStatus, Peril } from "../../types/contracts";
import type { CedentTreeResponse, Programme } from "../../api/cedents";

function prog(
  programmeId: string,
  chainId: string,
  cedentId: string,
  underwriter: string,
): Programme {
  return {
    programmeId,
    chainId,
    cedentId,
    programmeName: programmeId,
    treatyYear: 2027,
    perils: [Peril.WS],
    peril: Peril.WS,
    office: "BDA",
    underwriter,
    status: "BOUND",
    datasetId: `ds-${programmeId}`,
    edm: {
      serverName: "sql-test",
      edmDatabaseName: `edm_${programmeId}`,
      currency: "USD",
      ertStatus: ErtStatus.ERT_READY,
      availableGranularity: [AggregationLevel.STATE],
    },
  };
}

const CEDENTS: CedentTreeResponse = {
  cedents: [
    {
      cedentId: "ced-1",
      cedentName: "Cedent One",
      region: "Southeast",
      chains: [
        {
          chainId: "chain-1",
          cedentId: "ced-1",
          chainName: "Chain One",
          office: "BDA",
          defaultPeril: Peril.WS,
          programmes: [prog("prog-1", "chain-1", "ced-1", "Alice")],
        },
        {
          chainId: "chain-2",
          cedentId: "ced-1",
          chainName: "Chain Two",
          office: "NYC",
          defaultPeril: Peril.WS,
          programmes: [prog("prog-2", "chain-2", "ced-1", "Bob")],
        },
      ],
    },
  ],
};

function renderScope(opts: { seedCedents?: boolean } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (opts.seedCedents ?? true) {
    qc.setQueryData(queryKeys.cedents(), CEDENTS);
  }
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useEffectiveScope(), { wrapper });
}

describe("useEffectiveScope — scope-filter chips", () => {
  beforeEach(() => {
    useSelectionStore.getState().clear();
    useScopeFiltersStore.getState().clear();
  });

  it("no selection + no chips → portfolio mode (chainIds undefined, not empty)", () => {
    const { result } = renderScope();
    expect(result.current.chainIds).toBeUndefined();
    expect(result.current.hasScopeFilter).toBe(false);
    expect(result.current.isEmpty).toBe(false);
  });

  it("chips matching some chains → those chainIds", () => {
    useScopeFiltersStore.getState().setOffices(["BDA"]);
    const { result } = renderScope();
    expect(result.current.chainIds).toEqual(["chain-1"]);
    expect(result.current.hasScopeFilter).toBe(true);
    expect(result.current.isEmpty).toBe(false);
  });

  it("chips matching ZERO chains → isEmpty, never the portfolio fallback", () => {
    useScopeFiltersStore.getState().setOffices(["LON"]); // no LON chains exist
    const { result } = renderScope();
    expect(result.current.hasScopeFilter).toBe(true);
    expect(result.current.isEmpty).toBe(true);
    // chainIds stays undefined — consumers must gate on isEmpty because an
    // empty array would read as "portfolio" to the backend.
    expect(result.current.chainIds).toBeUndefined();
  });

  it("intersected chips (office ∩ underwriter) with no common chain → isEmpty", () => {
    useScopeFiltersStore.getState().setOffices(["BDA"]);
    useScopeFiltersStore.getState().setUnderwriters(["Bob"]); // Bob is NYC-only
    const { result } = renderScope();
    expect(result.current.isEmpty).toBe(true);
  });

  it("explicit selection wins over zero-match chips", () => {
    useScopeFiltersStore.getState().setOffices(["LON"]);
    useSelectionStore.getState().selectProgramme("prog-1");
    const { result } = renderScope();
    expect(result.current.programmeId).toBe("prog-1");
    expect(result.current.isEmpty).toBe(false);
    expect(result.current.chainIds).toBeUndefined();
  });

  it("is NOT empty while the cedent tree is still loading", () => {
    useScopeFiltersStore.getState().setOffices(["LON"]);
    const { result } = renderScope({ seedCedents: false });
    // Zero matches only because we don't know the chains yet — don't flash
    // the empty view during load.
    expect(result.current.isEmpty).toBe(false);
  });
});
