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
import { SAFFIR_SIMPSON_COLORS } from "./hurricaneColors";

// SSHWS-palette `step` expression for wind speed (kt) → category color.
// Single source of truth for any line/marker keyed on observed wind speed.
const SSHWS_STEP_COLOR: (string | number)[] = [
  SAFFIR_SIMPSON_COLORS[-1],  // <34 kt → TD slate
  34, SAFFIR_SIMPSON_COLORS[0],   // TS cyan
  64, SAFFIR_SIMPSON_COLORS[1],   // Cat 1 yellow
  83, SAFFIR_SIMPSON_COLORS[2],   // Cat 2 orange
  96, SAFFIR_SIMPSON_COLORS[3],   // Cat 3 red
  113, SAFFIR_SIMPSON_COLORS[4],  // Cat 4 dark red
  137, SAFFIR_SIMPSON_COLORS[5],  // Cat 5 magenta
];

const SRC_OBSERVED = "live-observed";
const SRC_FORECAST_LATEST = "live-forecast-latest";
const SRC_FORECAST_HISTORY = "live-forecast-history";
const SRC_ALERTS = "live-alerts";
const SRC_BUOYS = "live-buoys";
const SRC_LAND = "live-land";
const SRC_SST = "live-sst";
const SRC_OBS_INNER = "live-obs-inner-cone";
const SRC_OBS_OUTER = "live-obs-outer-cone";
const SRC_OBS_RINGS = "live-obs-outer-rings";
const SRC_FCST_INNER = "live-fcst-inner-cone";
const SRC_FCST_OUTER = "live-fcst-outer-cone";
const SRC_FCST_RINGS = "live-fcst-outer-rings";

const LAYER_OBSERVED = "live-observed-line";
const LAYER_FORECAST_LATEST = "live-forecast-latest-line";
const LAYER_FORECAST_HISTORY = "live-forecast-history-line";
const LAYER_ALERTS_FILL = "live-alerts-fill";
const LAYER_ALERTS_LINE = "live-alerts-line";
const LAYER_BUOYS = "live-buoys-circle";
const LAYER_LAND = "live-land-circle";
const LAYER_SST = "live-sst-fill";
const LAYER_OBS_INNER = "live-obs-inner-fill";
const LAYER_OBS_OUTER = "live-obs-outer-fill";
const LAYER_OBS_RINGS = "live-obs-rings-fill";
const LAYER_FCST_INNER = "live-fcst-inner-fill";
const LAYER_FCST_OUTER = "live-fcst-outer-fill";
const LAYER_FCST_RINGS = "live-fcst-rings-fill";
const LAYER_BUOYS_TEXT = "live-buoys-text";
const LAYER_LAND_TEXT = "live-land-text";

// Zoom at which buoy + station wind speed labels appear right next to the
// marker (no hover needed). Below this they'd visually clutter the map.
const OBS_LABEL_MIN_ZOOM = 6.5;

// Cat-colored step palette for the wind-field cones (matches historical
// impact view so the visual language is consistent across the app).
const CONE_STEP_COLOR: (string | number)[] = [
  "#fde047",        // < 83 (Cat 1)
  83, "#fb923c",   // Cat 2
  96, "#ea580c",   // Cat 3
  113, "#b91c1c",  // Cat 4
  137, "#581c87",  // Cat 5
];

// NWS severity → colour for the alert polygons.
const SEVERITY_COLOR: Record<string, string> = {
  Extreme: "#7f1d1d",
  Severe: "#b91c1c",
  Moderate: "#ea580c",
  Minor: "#f59e0b",
  Unknown: "#a3a3a3",
};

// SST colour ramp is inlined as an ["interpolate"] expression on the SST
// circle layer below; no constant kept here.

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

function buildSstFC(
  sst: import("../../api/live").SSTPoint[],
  stepDeg: number,
) {
  // One square fill polygon per cell, sized to the backend's native step so
  // cells tile the bbox without gaps. Looks like a real SST heatmap.
  const half = stepDeg / 2;
  return {
    type: "FeatureCollection" as const,
    features: sst.map((p) => ({
      type: "Feature" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [[
          [p.lon - half, p.lat - half],
          [p.lon + half, p.lat - half],
          [p.lon + half, p.lat + half],
          [p.lon - half, p.lat + half],
          [p.lon - half, p.lat - half],
        ]],
      },
      properties: { tempC: p.tempC },
    })),
  };
}

function buildConeQuadFC(quads: import("../../api/live").ConeQuad[] | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (!quads) return { type: "FeatureCollection" as const, features };
  for (const q of quads) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [q.corners] },
      properties: { windKt: q.windKt },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildRingFC(rings: import("../../api/live").OuterRing[] | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (!rings) return { type: "FeatureCollection" as const, features };
  for (const r of rings) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [r.corners] },
      properties: { windKt: r.windKt },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

export function LiveStormLayer({ map }: Props) {
  const data = useLiveStormStore((s) => s.data);
  const showForecastHistory = useLiveStormStore((s) => s.showForecastHistory);
  const showAlerts = useLiveStormStore((s) => s.showAlerts);
  const showBuoys = useLiveStormStore((s) => s.showBuoys);
  const showLand = useLiveStormStore((s) => s.showLand);
  const showSst = useLiveStormStore((s) => s.showSst);
  const showWindField = useLiveStormStore((s) => s.showWindField);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      // ── Sources (data) — always set, even empty (no features = no draw). ──
      setSource(map, SRC_SST, buildSstFC(data?.sst ?? [], data?.sstMeta?.stepDeg ?? 0.1));
      setSource(map, SRC_ALERTS, buildAlertsFC(data?.alerts ?? []));
      setSource(map, SRC_FORECAST_HISTORY, buildForecastHistoryFC(data?.forecasts ?? []));
      const latestForecast = (() => {
        if (!data?.forecasts.length) return [];
        const latest = data.forecasts.reduce((a, b) =>
          a.advisoryNumber >= b.advisoryNumber ? a : b,
        );
        return latest.points.map((p) => ({ lat: p.lat, lon: p.lon, windKt: p.windKt }));
      })();
      setSource(map, SRC_FORECAST_LATEST, buildLineFC(latestForecast));
      const observed = (data?.observedTrack ?? []).map((p) => ({
        lat: p.lat,
        lon: p.lon,
        windKt: p.windKt,
      }));
      setSource(map, SRC_OBSERVED, buildLineFC(observed));
      setSource(map, SRC_BUOYS, buildBuoyFC(data?.buoys ?? []));
      setSource(map, SRC_LAND, buildLandFC(data?.landStations ?? []));
      setSource(map, SRC_OBS_OUTER, buildConeQuadFC(data?.observedWindField.outerCone));
      setSource(map, SRC_OBS_RINGS, buildRingFC(data?.observedWindField.outerRings));
      setSource(map, SRC_OBS_INNER, buildConeQuadFC(data?.observedWindField.innerCone));
      setSource(map, SRC_FCST_OUTER, buildConeQuadFC(data?.forecastWindField.outerCone));
      setSource(map, SRC_FCST_RINGS, buildRingFC(data?.forecastWindField.outerRings));
      setSource(map, SRC_FCST_INNER, buildConeQuadFC(data?.forecastWindField.innerCone));

      // ── Layers (stable paint, no data-dependent opacity). Visibility is
      //    flipped via setLayoutProperty below so toggling without remounting
      //    Just Works. Stacking: SST (bottom) → alerts → forecast history →
      //    latest forecast → observed track → markers (top). ──

      // SST as small abutting fill polygons sized to backend step. Smooth
      // interpolate palette (cool blue → warm yellow → red). Reads as a
      // continuous heatmap because cells tile the bbox without gaps.
      ensureLayer(map, LAYER_SST, {
        id: LAYER_SST, type: "fill", source: SRC_SST,
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["get", "tempC"],
            16, "#1e3a8a",
            20, "#2563eb",
            24, "#22d3ee",
            26, "#a3e635",
            26.5, "#facc15",
            28, "#fb923c",
            29, "#dc2626",
            30.5, "#7f1d1d",
          ] as unknown as never,
          "fill-opacity": 0.55,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");

      ensureLayer(map, LAYER_ALERTS_FILL, {
        id: LAYER_ALERTS_FILL, type: "fill", source: SRC_ALERTS,
        paint: {
          "fill-color": [
            "match", ["get", "severity"],
            "Extreme", SEVERITY_COLOR.Extreme,
            "Severe", SEVERITY_COLOR.Severe,
            "Moderate", SEVERITY_COLOR.Moderate,
            "Minor", SEVERITY_COLOR.Minor,
            SEVERITY_COLOR.Unknown,
          ] as unknown as never,
          "fill-opacity": 0.25,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_ALERTS_LINE, {
        id: LAYER_ALERTS_LINE, type: "line", source: SRC_ALERTS,
        paint: {
          "line-color": [
            "match", ["get", "severity"],
            "Extreme", SEVERITY_COLOR.Extreme,
            "Severe", SEVERITY_COLOR.Severe,
            "Moderate", SEVERITY_COLOR.Moderate,
            "Minor", SEVERITY_COLOR.Minor,
            SEVERITY_COLOR.Unknown,
          ] as unknown as never,
          "line-width": 1.0,
          "line-opacity": 0.65,
        },
      }, "county-line");

      // ── Wind-field cones: same Cat palette as historical impact. Outer
      //    R64 (asymmetric) first at low opacity, inner Rmax on top. Forecast
      //    cone uses the same style but with a dashed border on the rings so
      //    you can tell observed vs projected. ──
      ensureLayer(map, LAYER_OBS_OUTER, {
        id: LAYER_OBS_OUTER, type: "fill", source: SRC_OBS_OUTER,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.22,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_OBS_RINGS, {
        id: LAYER_OBS_RINGS, type: "fill", source: SRC_OBS_RINGS,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.22,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_OBS_INNER, {
        id: LAYER_OBS_INNER, type: "fill", source: SRC_OBS_INNER,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.55,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_FCST_OUTER, {
        id: LAYER_FCST_OUTER, type: "fill", source: SRC_FCST_OUTER,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.18,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_FCST_RINGS, {
        id: LAYER_FCST_RINGS, type: "fill", source: SRC_FCST_RINGS,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.18,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_FCST_INNER, {
        id: LAYER_FCST_INNER, type: "fill", source: SRC_FCST_INNER,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.45,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");

      ensureLayer(map, LAYER_FORECAST_HISTORY, {
        id: LAYER_FORECAST_HISTORY, type: "line", source: SRC_FORECAST_HISTORY,
        paint: {
          "line-color": "#475569",
          "line-width": 1.6,
          "line-dasharray": [3, 2],
          // Older advisories fade out; latest (age=0) stays brightest.
          "line-opacity": [
            "case",
            [">", ["get", "age"], 0],
            ["max", 0.05, ["-", 0.40, ["*", 0.05, ["get", "age"]]]],
            0.6,
          ] as unknown as never,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      ensureLayer(map, LAYER_FORECAST_LATEST, {
        id: LAYER_FORECAST_LATEST, type: "line", source: SRC_FORECAST_LATEST,
        paint: {
          "line-color": "#1d4ed8",
          "line-width": 3.0,
          "line-opacity": 0.85,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      ensureLayer(map, LAYER_OBSERVED, {
        id: LAYER_OBSERVED, type: "line", source: SRC_OBSERVED,
        paint: {
          // Same SSHWS swatch palette as the legend at top of the map, so
          // the observed track reads consistently with what users see in the
          // historical IBTrACS overlay.
          "line-color": ["step", ["get", "windKt"], ...SSHWS_STEP_COLOR] as unknown as never,
          "line-width": 3.5,
          "line-opacity": 0.95,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      ensureLayer(map, LAYER_BUOYS, {
        id: LAYER_BUOYS, type: "circle", source: SRC_BUOYS,
        paint: {
          "circle-radius": 5,
          "circle-color": ["step", ["get", "windKt"], ...SSHWS_STEP_COLOR] as unknown as never,
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 1.0,
          "circle-opacity": 0.95,
          "circle-stroke-opacity": 0.95,
        },
      });

      ensureLayer(map, LAYER_LAND, {
        id: LAYER_LAND, type: "circle", source: SRC_LAND,
        paint: {
          // Bumped — these were getting visually buried under the cone
          // fills, alerts, and SST. Bigger radius + white halo so they
          // pop out as the "human" indicator on top of the modelled wind
          // field. Distinct from buoys (cyan-coded) by both colour and
          // the white halo.
          "circle-radius": 6,
          "circle-color": "#10b981",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-opacity": 1.0,
          "circle-stroke-opacity": 1.0,
        },
      });

      // Wind-speed text labels right at each marker, kicking in when the
      // user zooms in past the marker-cluster zoom. text-allow-overlap=false
      // keeps the map readable; closely-spaced stations drop their label
      // rather than stacking. Halo gives contrast over the SST fill.
      ensureLayer(map, LAYER_BUOYS_TEXT, {
        id: LAYER_BUOYS_TEXT, type: "symbol", source: SRC_BUOYS,
        minzoom: OBS_LABEL_MIN_ZOOM,
        layout: {
          "text-field": [
            "concat",
            ["to-string", ["round", ["get", "windKt"]]],
            " kt",
          ] as unknown as never,
          "text-size": 10,
          "text-offset": [0, -1.1] as unknown as never,
          "text-anchor": "bottom",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });
      ensureLayer(map, LAYER_LAND_TEXT, {
        id: LAYER_LAND_TEXT, type: "symbol", source: SRC_LAND,
        minzoom: OBS_LABEL_MIN_ZOOM,
        layout: {
          "text-field": [
            "concat",
            ["to-string", ["round", ["get", "windKt"]]],
            " kt",
          ] as unknown as never,
          "text-size": 10,
          "text-offset": [0, -1.1] as unknown as never,
          "text-anchor": "bottom",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#064e3b",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      // ── Visibility — driven purely by the panel toggles. ──
      setVis(map, LAYER_SST, showSst);
      setVis(map, LAYER_ALERTS_FILL, showAlerts);
      setVis(map, LAYER_ALERTS_LINE, showAlerts);
      setVis(map, LAYER_FORECAST_HISTORY, showForecastHistory);
      // Latest forecast + observed track always visible when a storm is loaded.
      setVis(map, LAYER_FORECAST_LATEST, true);
      setVis(map, LAYER_OBSERVED, true);
      setVis(map, LAYER_BUOYS, showBuoys);
      setVis(map, LAYER_BUOYS_TEXT, showBuoys);
      setVis(map, LAYER_LAND, showLand);
      setVis(map, LAYER_LAND_TEXT, showLand);
      setVis(map, LAYER_OBS_OUTER, showWindField);
      setVis(map, LAYER_OBS_RINGS, showWindField);
      setVis(map, LAYER_OBS_INNER, showWindField);
      setVis(map, LAYER_FCST_OUTER, showWindField);
      setVis(map, LAYER_FCST_RINGS, showWindField);
      setVis(map, LAYER_FCST_INNER, showWindField);
    };

    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, data, showForecastHistory, showAlerts, showBuoys, showLand, showSst, showWindField]);

  // Hover popups for buoys and land stations.
  useEffect(() => {
    if (!map) return;
    let popup: mapboxgl.Popup | null = null;
    const fmt = (v: number | null | undefined, suffix: string, digits = 0) =>
      v == null || Number.isNaN(v) ? "—" : `${Number(v).toFixed(digits)}${suffix}`;

    const onEnterBuoy = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        stationId: string;
        windKt: number | null;
        gustKt: number | null;
        pressureMb: number | null;
      };
      const mb = await import("mapbox-gl");
      popup?.remove();
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4">
            <div><strong>${p.stationId}</strong> · NDBC buoy</div>
            <div>Wind ${fmt(p.windKt, " kt")} · Gust ${fmt(p.gustKt, " kt")}</div>
            <div>Pressure ${fmt(p.pressureMb, " mb")}</div>
          </div>`,
        )
        .addTo(map);
      map.getCanvas().style.cursor = "pointer";
    };

    const onEnterLand = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        stationId: string;
        name: string;
        windKt: number | null;
      };
      // Fetch the full record from the store so we can show gust + pressure +
      // temp without bloating the feature properties.
      const full = (
        useLiveStormStore.getState().data?.landStations ?? []
      ).find((ls) => ls.stationId === p.stationId);
      const mb = await import("mapbox-gl");
      popup?.remove();
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4;max-width:240px">
            <div><strong>${p.stationId}</strong> · NWS land station</div>
            <div style="color:#475569">${p.name ?? ""}</div>
            <div>Wind ${fmt(full?.windKt, " kt")} · Gust ${fmt(full?.gustKt, " kt")}</div>
            <div>Pressure ${fmt(full?.pressureMb, " mb")} · Temp ${fmt(full?.tempF, "°F")}</div>
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
      if (map.getLayer(LAYER_BUOYS)) {
        map.on("mouseenter", LAYER_BUOYS, onEnterBuoy as never);
        map.on("mouseleave", LAYER_BUOYS, onLeave);
      }
      if (map.getLayer(LAYER_LAND)) {
        map.on("mouseenter", LAYER_LAND, onEnterLand as never);
        map.on("mouseleave", LAYER_LAND, onLeave);
      }
    };
    if (map.isStyleLoaded()) reg();
    else map.once("idle", reg);
    return () => {
      try {
        map.off("mouseenter", LAYER_BUOYS, onEnterBuoy as never);
        map.off("mouseleave", LAYER_BUOYS, onLeave);
        map.off("mouseenter", LAYER_LAND, onEnterLand as never);
        map.off("mouseleave", LAYER_LAND, onLeave);
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
): void {
  const existing = map.getSource(id) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data as never);
    return;
  }
  map.addSource(id, { type: "geojson", data: data as never });
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

function setVis(map: MbMap, id: string, visible: boolean): void {
  if (!map.getLayer(id)) return;
  map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}
