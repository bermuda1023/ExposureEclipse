import { beforeEach, describe, expect, it } from "vitest";
import { useFiltersStore } from "../filters";
import { useSelectionStore } from "../selection";
import { useViewStore } from "../view";
import { AggregationLevel, MetricKey, Peril } from "../../types/contracts";

describe("selection store", () => {
  beforeEach(() => useSelectionStore.getState().clear());

  it("selecting a chain clears any cedent / programme selection", () => {
    useSelectionStore.getState().selectCedent("ced-farmers");
    useSelectionStore.getState().selectChain("chain-farmers-bda-ws");
    const s = useSelectionStore.getState();
    expect(s.chainId).toBe("chain-farmers-bda-ws");
    expect(s.cedentId).toBeNull();
    expect(s.programmeId).toBeNull();
  });

  it("selecting a programme clears the chain + comparison override", () => {
    useSelectionStore.getState().selectChain("chain-farmers-bda-ws");
    useSelectionStore.getState().setComparisonProgramme("prog-farmers-bda-ws-2025");
    useSelectionStore.getState().selectProgramme("prog-farmers-bda-ws-2027");
    const s = useSelectionStore.getState();
    expect(s.programmeId).toBe("prog-farmers-bda-ws-2027");
    expect(s.chainId).toBeNull();
    expect(s.comparisonProgrammeId).toBeNull();
  });

  it("kind() reports which selection level is active", () => {
    expect(useSelectionStore.getState().kind()).toBeNull();
    useSelectionStore.getState().selectChain("chain-1");
    expect(useSelectionStore.getState().kind()).toBe("chain");
  });
});

describe("filters store", () => {
  beforeEach(() => useFiltersStore.getState().reset());

  it("defaults peril to ALL and lists empty", () => {
    const s = useFiltersStore.getState();
    expect(s.peril).toBe(Peril.ALL);
    expect(s.occupancy).toEqual([]);
  });

  it("toggle adds and removes a value", () => {
    useFiltersStore.getState().toggle("occupancy", "Res-MFD");
    expect(useFiltersStore.getState().occupancy).toEqual(["Res-MFD"]);
    useFiltersStore.getState().toggle("occupancy", "Res-MFD");
    expect(useFiltersStore.getState().occupancy).toEqual([]);
  });
});

describe("view store", () => {
  beforeEach(() => {
    useViewStore.getState().setPerils([]);
    useViewStore.getState().setSelectedGeographyId(null);
  });

  it("changing aggregation level clears the selected geography", () => {
    useViewStore.getState().setSelectedGeographyId("US-FL");
    useViewStore.getState().setAggregationLevel(AggregationLevel.COUNTY);
    expect(useViewStore.getState().selectedGeographyId).toBeNull();
    expect(useViewStore.getState().aggregationLevel).toBe(AggregationLevel.COUNTY);
  });

  it("default metric is TIV", () => {
    expect(useViewStore.getState().metric).toBe(MetricKey.TIV);
  });

  it("togglePeril adds then removes from the multi-select", () => {
    useViewStore.getState().togglePeril(Peril.WS);
    expect(useViewStore.getState().perils).toEqual([Peril.WS]);
    useViewStore.getState().togglePeril(Peril.WS);
    expect(useViewStore.getState().perils).toEqual([]);
  });
});
