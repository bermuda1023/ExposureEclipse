import { beforeEach, describe, expect, it } from "vitest";
import type { LiveStormBundle, ModelTracksResponse, ReconPoll } from "../../api/live";
import {
  liveStormHidesExposureFills,
  shearViewActive,
  useLiveStormStore,
  windGridUsable,
} from "../liveStorm";
import type { WindModelGrid } from "../../api/live";

describe("live storm reload", () => {
  beforeEach(() => {
    useLiveStormStore.getState().clear();
  });

  it("shows the wind field and consensus envelope by default", () => {
    const s = useLiveStormStore.getState();
    expect(s.showWindField).toBe(true);
    expect(s.showForecastCone).toBe(true);
    expect(s.showEnsembleEnvelope).toBe(true);
    expect(s.showSatellite).toBe(false);
    expect(s.showLightning).toBe(false);
    expect(s.showMyLocation).toBe(false);
    expect(s.hideExposures).toBe(false);
  });

  it("hides exposure fills only while live-storm mode is on and asked", () => {
    const base = {
      hideExposures: true,
      pickerOpen: false,
      pushedToDetail: false,
      activeStormId: null as string | null,
    };
    expect(liveStormHidesExposureFills(base)).toBe(false);
    expect(liveStormHidesExposureFills({ ...base, pickerOpen: true })).toBe(true);
    expect(liveStormHidesExposureFills({ ...base, pushedToDetail: true })).toBe(true);
    expect(liveStormHidesExposureFills({ ...base, activeStormId: "AL012026" })).toBe(true);
    expect(liveStormHidesExposureFills({
      ...base,
      hideExposures: false,
      activeStormId: "AL012026",
    })).toBe(false);
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

  it("treats shear as the painted field only after that hour has a magnitude", () => {
    const surface: WindModelGrid = {
      model: "gfs",
      stepDeg: 1,
      cells: [{ lat: 22, lon: -90 }],
      frames: [
        { hour: 0, validTimeUtc: "2026-10-07T12:00Z", windKt: [10], windDirDeg: [0] },
        { hour: 6, validTimeUtc: "2026-10-07T18:00Z", windKt: [12], windDirDeg: [0] },
      ],
    };
    const shear: WindModelGrid = {
      model: "gfs",
      stepDeg: 1,
      cells: [{ lat: 22, lon: -90 }],
      frames: [
        { hour: 6, validTimeUtc: "2026-10-07T18:00Z", windKt: [22], windDirDeg: [270] },
      ],
    };
    const view = {
      showWindShear: true,
      windMapMode: "gfs" as const,
      windMapFrameIndex: 1,
      gfsGrid: surface,
      ecmwfGrid: null,
      gfsShear: shear,
      ecmwfShear: null,
      gfsShearStatus: "ok" as const,
      ecmwfShearStatus: "idle" as const,
    };
    expect(shearViewActive(view)).toBe(true);
    expect(shearViewActive({ ...view, showWindShear: false })).toBe(false);
    expect(shearViewActive({ ...view, windMapMode: "observed" })).toBe(false);
    expect(shearViewActive({ ...view, gfsShearStatus: "loading" })).toBe(false);
    expect(shearViewActive({
      ...view,
      gfsShear: {
        ...shear,
        frames: [{ hour: 6, validTimeUtc: "2026-10-07T18:00Z", windKt: [null], windDirDeg: [null] }],
      },
    })).toBe(false);
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

  it("keeps the wind heatmap when a hunter poll has no fresh blend", () => {
    useLiveStormStore.getState().start("AL012026");
    const windMap = [{ lat: 22, lon: -90, windKt: 10 }];
    const windObs = [{ stationId: "41000", lat: 22, lon: -90, windKt: 10 }];
    const bundle = {
      recon: [],
      vortex: null,
      windMap,
      windObs,
      bbox: [-95, 20, -85, 30],
    } as unknown as LiveStormBundle;
    useLiveStormStore.getState().setData(bundle);
    const patch: ReconPoll = {
      recon: [{ lat: 23, lon: -91, surfaceKt: 70 } as ReconPoll["recon"][number]],
      vortex: null,
      windMap: null,
      windObs: null,
      polledAt: "2026-10-07T12:00:00Z",
    };
    useLiveStormStore.getState().patchRecon(patch);
    const next = useLiveStormStore.getState().data;
    expect(next?.recon).toHaveLength(1);
    expect(next?.windMap).toBe(windMap);
    expect(next?.windObs).toBe(windObs);

    const blended = [{ lat: 23, lon: -93.7, windKt: 80 }];
    useLiveStormStore.getState().patchRecon({
      ...patch,
      windMap: blended as unknown as ReconPoll["windMap"],
      windObs: windObs as unknown as ReconPoll["windObs"],
    });
    expect(useLiveStormStore.getState().data?.windMap).toBe(blended);
  });
});
