import { beforeEach, describe, expect, it } from "vitest";
import type { LiveStormBundle, ModelTracksResponse } from "../../api/live";
import { useLiveStormStore, windGridUsable } from "../liveStorm";

describe("live storm reload", () => {
  beforeEach(() => {
    useLiveStormStore.getState().clear();
  });

  it("shows the wind field and consensus envelope by default", () => {
    const s = useLiveStormStore.getState();
    expect(s.showWindField).toBe(true);
    expect(s.showForecastCone).toBe(true);
    expect(s.showEnsembleEnvelope).toBe(true);
  });

  it("treats a frameless or all-zero model grid as unusable", () => {
    expect(windGridUsable(null)).toBe(false);
    expect(windGridUsable({
      model: "gfs",
      stepDeg: 0.25,
      cells: [{ lat: 22, lon: -94 }],
      frames: [],
    })).toBe(false);
    expect(windGridUsable({
      model: "gfs",
      stepDeg: 0.25,
      cells: [{ lat: 22, lon: -94 }],
      frames: [{
        hour: 0,
        validTimeUtc: "2026-10-07T12:00Z",
        windKt: [0],
        windDirDeg: [null],
      }],
    })).toBe(false);
    expect(windGridUsable({
      model: "ecmwf",
      stepDeg: 0.25,
      cells: [{ lat: 22, lon: -94 }],
      frames: [{
        hour: 0,
        validTimeUtc: "2026-10-07T12:00Z",
        windKt: [12],
        windDirDeg: [180],
      }],
    })).toBe(true);
  });

  it("retry refetches without blanking the storm already on the map", () => {
    useLiveStormStore.getState().start("AL092026");
    const bundle = { storm: { name: "Isaias" } } as unknown as LiveStormBundle;
    const tracks = { tracks: [{ techId: "GDMI" }] } as unknown as ModelTracksResponse;
    useLiveStormStore.getState().setData(bundle);
    useLiveStormStore.getState().setModelTracks(tracks);
    useLiveStormStore.getState().retryLoads();
    const next = useLiveStormStore.getState();
    expect(next.activeStormId).toBe("AL092026");
    expect(next.reloadNonce).toBe(1);
    expect(next.data).toBe(bundle);
    expect(next.modelTracks).toBe(tracks);
    expect(next.modelTracksStatus).toBe("loading");
    expect(next.isLoading).toBe(true);
    expect(next.error).toBeNull();
    expect(next.gfsAttemptNonce).toBe(-1);
    expect(next.ecmwfAttemptNonce).toBe(-1);
  });
});
