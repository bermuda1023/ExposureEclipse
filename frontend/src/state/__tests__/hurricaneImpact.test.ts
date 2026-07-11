import { beforeEach, describe, expect, it } from "vitest";
import { useHurricaneImpactStore } from "../hurricaneImpact";
import type { HurricaneImpactResponse } from "../../api/hurricanes";

function impactFor(stormId: string): HurricaneImpactResponse {
  return {
    stormId,
    stormName: "TEST",
    year: 2024,
    currency: "USD",
    multiplier: 2.5,
    bbox: null,
    footprint: [],
    cone: [],
    outerCone: [],
    outerFootprint: [],
    summary: {
      countiesImpacted: 0,
      countiesWithData: 0,
      totalTiv: 0,
      totalLocationCount: 0,
    },
    counties: [],
  };
}

describe("hurricane impact store — stale-response guard", () => {
  beforeEach(() => useHurricaneImpactStore.getState().clear());

  it("accepts a payload for the currently-active storm", () => {
    useHurricaneImpactStore.getState().start("AL092024", {});
    useHurricaneImpactStore.getState().setData(impactFor("AL092024"));
    const s = useHurricaneImpactStore.getState();
    expect(s.data?.stormId).toBe("AL092024");
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("drops a stale payload after the user clicked a different storm", () => {
    useHurricaneImpactStore.getState().start("AL092024", {});
    useHurricaneImpactStore.getState().start("AL122024", {});
    // The first storm's fetch resolves late — must NOT overwrite the newer
    // storm's (still loading) state.
    useHurricaneImpactStore.getState().setData(impactFor("AL092024"));
    const s = useHurricaneImpactStore.getState();
    expect(s.activeStormId).toBe("AL122024");
    expect(s.data).toBeNull();
    expect(s.isLoading).toBe(true);
  });

  it("drops a payload arriving after clear()", () => {
    useHurricaneImpactStore.getState().start("AL092024", {});
    useHurricaneImpactStore.getState().clear();
    useHurricaneImpactStore.getState().setData(impactFor("AL092024"));
    const s = useHurricaneImpactStore.getState();
    expect(s.activeStormId).toBeNull();
    expect(s.data).toBeNull();
  });

  it("still accepts the matching storm's payload after a switch back", () => {
    useHurricaneImpactStore.getState().start("AL092024", {});
    useHurricaneImpactStore.getState().start("AL122024", {});
    useHurricaneImpactStore.getState().setData(impactFor("AL122024"));
    expect(useHurricaneImpactStore.getState().data?.stormId).toBe("AL122024");
  });
});
