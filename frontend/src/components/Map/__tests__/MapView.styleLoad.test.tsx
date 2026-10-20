import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { MapResponse } from "../../../api/types";
import { AggregationLevel } from "../../../types/contracts";

type Handler = (event?: unknown) => void;
interface FakeMapRecord {
  fire: (event: string) => void;
  featureState: Array<{ target: { source: string; id: string }; state: Record<string, unknown> }>;
  layout: Array<[string, string, unknown]>;
}

const { maps } = vi.hoisted(() => ({ maps: [] as FakeMapRecord[] }));

vi.mock("mapbox-gl", () => {
  class FakeMap {
    handlers = new Map<string, Handler[]>();
    layers = new Map<string, unknown>();
    featureState: FakeMapRecord["featureState"] = [];
    layout: FakeMapRecord["layout"] = [];
    pitch = 0;

    constructor() {
      maps.push(this);
      // Overlay helpers call many more Map methods; they are inert here.
      return new Proxy(this, {
        get: (target, key) => (key in target ? target[key as keyof FakeMap] : () => undefined),
      });
    }

    on(event: string, layerOrHandler: string | Handler, handler?: Handler) {
      const fn = typeof layerOrHandler === "function" ? layerOrHandler : handler!;
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    off() { return this; }
    fire(event: string) { for (const fn of this.handlers.get(event) ?? []) fn({}); }
    addLayer(layer: { id: string }) { this.layers.set(layer.id, layer); }
    getLayer(id: string) { return this.layers.get(id); }
    getStyle() {
      return { layers: [{ id: "land", type: "background", paint: { "background-color": "#f4f3f0" } }, { id: "label", type: "symbol" }] };
    }
    setFeatureState(target: { source: string; id: string }, state: Record<string, unknown>) {
      this.featureState.push({ target, state });
    }
    setLayoutProperty(id: string, key: string, value: unknown) { this.layout.push([id, key, value]); }
    getPitch() { return this.pitch; }
    setPitch(pitch: number) { this.pitch = pitch; }
    getZoom() { return 3.6; }
    getCanvas() { return document.createElement("canvas"); }
    queryRenderedFeatures() { return []; }
  }
  const api = { Map: FakeMap, NavigationControl: class {}, ScaleControl: class {}, accessToken: "" };
  return { default: api, ...api };
});

for (const mod of [
  "HurricaneLayer", "HurricaneImpactPanel", "HazardOverlayLayer", "HazardOverlayLegend",
  "LiveImageryLayer", "LiveStormLayer", "MyLocationLayer", "LiveStormPanel", "ModelTrackLayer",
  "StrikeProbabilityLayer", "TWOLayer", "WildfireLayer", "WildfirePanel", "WildfireLegend",
  "FloodLayer", "FloodPanel", "WindMapLegend", "WindParticleLayer",
]) {
  vi.doMock(`../${mod}`, () => ({ [mod]: () => null }));
}

const response: MapResponse = {
  aggregationLevel: AggregationLevel.STATE,
  metric: "TIV",
  currency: "USD",
  warnings: [],
  features: [
    {
      geographyId: "US-FL", metricValue: 100, tiv: 100, locationCount: 1,
      dealShareOfPortfolioInGeography: null, geographyShareOfTotalPortfolio: null,
      selectedDealGeographyConcentration: null, clientMarketShare: null,
      yoyChange: null, yoyStatus: null, hasGeometry: true, warnings: [],
    },
  ],
} as MapResponse;

// MapView reads its token at import, so it and the store it subscribes to are
// imported after the env stub, from the same fresh module graph.
async function loadMapView() {
  const { MapView } = await import("../MapView");
  const { useViewStore } = await import("../../../state/view");
  useViewStore.setState({ aggregationLevel: AggregationLevel.STATE, mapDisplay: "fill" });
  return { MapView, useViewStore };
}

describe("MapView style load", () => {
  beforeEach(() => {
    maps.length = 0;
    vi.resetModules();
    vi.stubEnv("VITE_MAPBOX_TOKEN", "pk.test");
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("paints exposure data that arrived before the map style finished loading", async () => {
    const { MapView } = await loadMapView();
    const view = render(<MapView data={undefined} isLoading error={null} />);
    view.rerender(<MapView data={response} isLoading={false} error={null} />);
    expect(maps).toHaveLength(1);
    expect(maps[0].featureState).toHaveLength(0);

    act(() => maps[0].fire("load"));

    const florida = maps[0].featureState.filter(
      (f) => f.target.source === "boundaries-states" && f.target.id === "12",
    );
    expect(florida.at(-1)?.state).toMatchObject({ hasData: true, bar: 1 });
  });

  it("shows bars, not fills, when 3D bars was chosen before the style loaded", async () => {
    const { MapView, useViewStore } = await loadMapView();
    render(<MapView data={response} isLoading={false} error={null} />);
    act(() => useViewStore.getState().setMapDisplay("bars"));

    act(() => maps[0].fire("load"));

    const last = (id: string) =>
      maps[0].layout.filter(([layer, key]) => layer === id && key === "visibility").at(-1)?.[2];
    expect(last("state-bars")).toBe("visible");
    expect(last("state-fill")).toBe("none");
  });
});
