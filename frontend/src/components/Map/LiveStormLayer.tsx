/**
 * Map overlay for the active live / replay storm:
 *
 *   1. Observed track (solid coloured line)
 *   2. Latest forecast track (bold coloured line) + ghost lines for older
 *      advisories (lighter / dashed)
 *   3. NWS active alerts (coloured polygons per severity)
 *   4. NDBC buoys (markers with wind-barb glyph via emoji fallback)
 *   5. NWS land stations (markers, distinct from buoys)
 *   6. SST grid (translucent fill cells)
 *
 * Everything fades out when the panel toggle is off; no state cleanup
 * needed beyond removing the layer's data.
 */

import type { GeoJSONSource, Map as MbMap } from "mapbox-gl";
import { useEffect, useRef } from "react";
import { useLiveStormStore } from "../../state/liveStorm";

const SRC_OBSERVED = "live-observed";
const SRC_FORECAST_LATEST = "live-forecast-latest";
const SRC_FORECAST_HISTORY = "live-forecast-history";
const SRC_ALERTS = "live-alerts";
const SRC_BUOYS = "live-buoys";
const SRC_LAND = "live-land";
const SRC_SST = "live-sst";

const LAYER_OBSERVED = "live-observed-line";
const LAYER_FORECAST_LATEST = "live-forecast-latest-line";
const LAYER_FORECAST_HISTORY = "live-forecast-history-line";
const LAYER_ALERTS_FILL = "live-alerts-fill";
const LAYER_ALERTS_LINE = "live-alerts-line";
const LAYER_BUOYS = "live-buoys-circle";
const LAYER_LAND = "live-land-circle";
const LAYER_SST = "live-sst-fill";

// NWS severity → colour for the alert polygons.
const SEVERITY_COLOR: Record<string, string> = {
  Extreme: "#7f1d1d",
  Severe: "#b91c1c",
  Moderate: "#ea580c",
  Minor: "#f59e0b",
  Unknown: "#a3a3a3",
};

// SST step palette (°C → hex). Cooler = blue; warmer through orange to red.
const SST_COLOR_STOPS: (number | string)[] = [
  "#1e3a8a",        // < 18 (cold)
  18, "#2563eb",
  22, "#22d3ee",
  25, "#a3e635",
  26.5, "#facc15",  // intensification threshold (warm)
  28, "#fb923c",
  29, "#dc2626",
  30, "#7f1d1d",
];

interface Props {
  map: MbMap | null;
}

function buildLineFC(coords: { lat: number; lon: number; windKt?: number }[], windFallback = 64) {
  const features: GeoJSON.Feature[] = [];
  if (coords.length < 2) return { type: "FeatureCollection" as const, features };
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [[a.lon, a.lat], [b.lon, b.lat]],
      },
      properties: { windKt: Math.max(a.windKt ?? windFallback, b.windKt ?? windFallback) },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildForecastHistoryFC(advisories: import("../../api/live").ForecastAdvisory[]) {
  // Each prior advisory becomes one polyline feature so we can colour them
  // collectively via a single layer with a `case` expression keyed on
  // `properties.advisoryNumber` (newest = brightest, older = fainter).
  const features: GeoJSON.Feature[] = [];
  const sorted = [...advisories].sort((a, b) => a.advisoryNumber - b.advisoryNumber);
  const maxAdv = sorted[sorted.length - 1]?.advisoryNumber ?? 0;
  for (const adv of sorted) {
    if (adv.points.length < 2) continue;
    if (adv.advisoryNumber === maxAdv) continue; // latest is rendered separately
    const coords = adv.points.map((p) => [p.lon, p.lat]);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        advisoryNumber: adv.advisoryNumber,
        synthetic: adv.synthetic,
        age: maxAdv - adv.advisoryNumber,
      },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildAlertsFC(alerts: import("../../api/live").WeatherAlert[]) {
  const features: GeoJSON.Feature[] = [];
  for (const a of alerts) {
    if (!a.geometry) continue;
    features.push({
      type: "Feature",
      geometry: a.geometry as GeoJSON.Geometry,
      properties: {
        event: a.event,
        severity: a.severity,
        headline: a.headline,
      },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildBuoyFC(buoys: import("../../api/live").BuoyObs[]) {
  return {
    type: "FeatureCollection" as const,
    features: buoys.map((b) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [b.lon, b.lat] },
      properties: {
        stationId: b.stationId,
        windKt: b.windKt ?? 0,
        gustKt: b.gustKt ?? 0,
        pressureMb: b.pressureMb,
      },
    })),
  };
}

function buildLandFC(stations: import("../../api/live").LandObs[]) {
  return {
    type: "FeatureCollection" as const,
    features: stations.map((s) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
      properties: {
        stationId: s.stationId,
        name: s.name,
        windKt: s.windKt ?? 0,
      },
    })),
  };
}

function buildSstFC(sst: import("../../api/live").SSTPoint[], step = 1.5) {
  // Each grid cell rendered as a small square polygon centred on (lat, lon).
  // Step matches the backend's sst_grid step.
  const half = step / 2;
  return {
    type: "FeatureCollection" as const,
    features: sst.map((p) => ({
      type: "Feature" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [
          [
            [p.lon - half, p.lat - half],
            [p.lon + half, p.lat - half],
            [p.lon + half, p.lat + half],
            [p.lon - half, p.lat + half],
            [p.lon - half, p.lat - half],
          ],
        ],
      },
      properties: { tempC: p.tempC },
    })),
  };
}

export function LiveStormLayer({ map }: Props) {
  const data = useLiveStormStore((s) => s.data);
  const showForecastHistory = useLiveStormStore((s) => s.showForecastHistory);
  const showAlerts = useLiveStormStore((s) => s.showAlerts);
  const showBuoys = useLiveStormStore((s) => s.showBuoys);
  const showLand = useLiveStormStore((s) => s.showLand);
  const showSst = useLiveStormStore((s) => s.showSst);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      // Below = drawn first; we want SST at the bottom, then alerts, then
      // tracks, then observation markers on top.

      // SST grid
      setSource(map, SRC_SST, buildSstFC(data?.sst ?? [], 1.5), false);
      ensureLayer(map, LAYER_SST, {
        id: LAYER_SST,
        type: "fill",
        source: SRC_SST,
        paint: {
          "fill-color": [
            "step", ["get", "tempC"], ...SST_COLOR_STOPS,
          ] as unknown as never,
          "fill-opacity": showSst && data ? 0.30 : 0,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");

      // Alerts (polygons) — above SST, below tracks
      setSource(map, SRC_ALERTS, buildAlertsFC(data?.alerts ?? []), false);
      ensureLayer(map, LAYER_ALERTS_FILL, {
        id: LAYER_ALERTS_FILL,
        type: "fill",
        source: SRC_ALERTS,
        paint: {
          "fill-color": [
            "match", ["get", "severity"],
            "Extreme", SEVERITY_COLOR.Extreme,
            "Severe", SEVERITY_COLOR.Severe,
            "Moderate", SEVERITY_COLOR.Moderate,
            "Minor", SEVERITY_COLOR.Minor,
            SEVERITY_COLOR.Unknown,
          ] as unknown as never,
          "fill-opacity": showAlerts && data ? 0.20 : 0,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_ALERTS_LINE, {
        id: LAYER_ALERTS_LINE,
        type: "line",
        source: SRC_ALERTS,
        paint: {
          "line-color": [
            "match", ["get", "severity"],
            "Extreme", SEVERITY_COLOR.Extreme,
            "Severe", SEVERITY_COLOR.Severe,
            "Moderate", SEVERITY_COLOR.Moderate,
            "Minor", SEVERITY_COLOR.Minor,
            SEVERITY_COLOR.Unknown,
          ] as unknown as never,
          "line-width": 0.8,
          "line-opacity": showAlerts && data ? 0.55 : 0,
        },
      }, "county-line");

      // Forecast history (ghost lines, older advisories)
      setSource(map, SRC_FORECAST_HISTORY, buildForecastHistoryFC(data?.forecasts ?? []), false);
      ensureLayer(map, LAYER_FORECAST_HISTORY, {
        id: LAYER_FORECAST_HISTORY,
        type: "line",
        source: SRC_FORECAST_HISTORY,
        paint: {
          "line-color": "#475569",
          "line-width": 1.6,
          "line-dasharray": [3, 2],
          // Older advisories more transparent: opacity = clamp(0.35 - 0.05*age, 0.05, 0.4)
          "line-opacity": [
            "case",
            [">", ["get", "age"], 0],
            [
              "max",
              0.05,
              ["-", 0.40, ["*", 0.05, ["get", "age"]]],
            ],
            0.6,
          ] as unknown as never,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Latest forecast (single bold polyline)
      const latestForecast = (() => {
        if (!data?.forecasts.length) return [];
        const latest = data.forecasts.reduce((a, b) =>
          a.advisoryNumber >= b.advisoryNumber ? a : b,
        );
        return latest.points.map((p) => ({ lat: p.lat, lon: p.lon, windKt: p.windKt }));
      })();
      setSource(map, SRC_FORECAST_LATEST, buildLineFC(latestForecast), false);
      ensureLayer(map, LAYER_FORECAST_LATEST, {
        id: LAYER_FORECAST_LATEST,
        type: "line",
        source: SRC_FORECAST_LATEST,
        paint: {
          "line-color": "#1d4ed8",
          "line-width": 3.0,
          "line-opacity": data ? 0.85 : 0,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Observed track (solid line, current intensity colour)
      const observed = (data?.observedTrack ?? []).map((p) => ({
        lat: p.lat,
        lon: p.lon,
        windKt: p.windKt,
      }));
      setSource(map, SRC_OBSERVED, buildLineFC(observed), false);
      ensureLayer(map, LAYER_OBSERVED, {
        id: LAYER_OBSERVED,
        type: "line",
        source: SRC_OBSERVED,
        paint: {
          "line-color": [
            "step", ["get", "windKt"],
            "#9ca3af", 34, "#0ea5e9", 64, "#fde047",
            83, "#fb923c", 96, "#ea580c", 113, "#dc2626", 137, "#7f1d1d",
          ] as unknown as never,
          "line-width": 3.5,
          "line-opacity": data ? 0.95 : 0,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Buoy markers
      setSource(map, SRC_BUOYS, buildBuoyFC(data?.buoys ?? []), false);
      ensureLayer(map, LAYER_BUOYS, {
        id: LAYER_BUOYS,
        type: "circle",
        source: SRC_BUOYS,
        paint: {
          "circle-radius": 4,
          "circle-color": [
            "step", ["get", "windKt"],
            "#22d3ee", 17, "#fde047", 34, "#fb923c", 50, "#dc2626", 64, "#7f1d1d",
          ] as unknown as never,
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 0.8,
          "circle-opacity": showBuoys && data ? 0.95 : 0,
          "circle-stroke-opacity": showBuoys && data ? 0.95 : 0,
        },
      });

      // Land stations
      setSource(map, SRC_LAND, buildLandFC(data?.landStations ?? []), false);
      ensureLayer(map, LAYER_LAND, {
        id: LAYER_LAND,
        type: "circle",
        source: SRC_LAND,
        paint: {
          "circle-radius": 3,
          "circle-color": "#10b981",
          "circle-stroke-color": "#064e3b",
          "circle-stroke-width": 0.6,
          "circle-opacity": showLand && data ? 0.95 : 0,
          "circle-stroke-opacity": showLand && data ? 0.95 : 0,
        },
      });

      // Toggle forecast history visibility on the dash layer
      if (map.getLayer(LAYER_FORECAST_HISTORY)) {
        map.setPaintProperty(
          LAYER_FORECAST_HISTORY,
          "line-opacity",
          showForecastHistory && data
            ? ([
                "case",
                [">", ["get", "age"], 0],
                ["max", 0.05, ["-", 0.40, ["*", 0.05, ["get", "age"]]]],
                0.6,
              ] as unknown as never)
            : 0,
        );
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, data, showForecastHistory, showAlerts, showBuoys, showLand, showSst]);

  // Tooltip on hover for the buoys.
  useEffect(() => {
    if (!map) return;
    let popup: mapboxgl.Popup | null = null;
    const onEnter = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as { stationId: string; windKt: number; gustKt: number; pressureMb: number };
      const mb = await import("mapbox-gl");
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4">
            <div><strong>${p.stationId}</strong> (NDBC buoy)</div>
            <div>Wind: ${Number(p.windKt).toFixed(0)} kt · Gust: ${Number(p.gustKt || 0).toFixed(0)} kt</div>
            <div>Pressure: ${p.pressureMb ? Number(p.pressureMb).toFixed(0) + " mb" : "—"}</div>
          </div>`,
        )
        .addTo(map);
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      popup?.remove();
      popup = null;
      map.getCanvas().style.cursor = "";
    };
    const reg = () => {
      if (!map.getLayer(LAYER_BUOYS)) return;
      map.on("mouseenter", LAYER_BUOYS, onEnter as never);
      map.on("mouseleave", LAYER_BUOYS, onLeave);
    };
    if (map.isStyleLoaded()) reg();
    else map.once("idle", reg);
    return () => {
      try {
        map.off("mouseenter", LAYER_BUOYS, onEnter as never);
        map.off("mouseleave", LAYER_BUOYS, onLeave);
      } catch {
        /* layer was already torn down */
      }
      popup?.remove();
    };
  }, [map]);

  return null;
}

// ───────────────────────── helpers ─────────────────────────

function setSource(
  map: MbMap,
  id: string,
  data: GeoJSON.FeatureCollection,
  promote: boolean,
): void {
  const existing = map.getSource(id) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data as never);
    return;
  }
  map.addSource(id, {
    type: "geojson",
    data: data as never,
    ...(promote ? { promoteId: "id" } : {}),
  });
}

function ensureLayer(
  map: MbMap,
  id: string,
  layer: mapboxgl.AnyLayer,
  beforeId?: string,
): void {
  if (map.getLayer(id)) return;
  if (beforeId && map.getLayer(beforeId)) {
    map.addLayer(layer as never, beforeId);
  } else {
    map.addLayer(layer as never);
  }
}
