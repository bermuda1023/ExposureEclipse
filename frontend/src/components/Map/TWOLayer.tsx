/**
 * NHC Tropical Weather Outlook (GTWO) formation-chance polygons.
 *
 * Basin-wide overlay — independent of any active storm. Renders 2-day and
 * 5-day disturbance areas coloured yellow / orange / red (NHC's standard
 * legend for low / medium / high chance of tropical cyclone formation).
 *
 * The 5-day window includes everything in the 2-day window at ≥ 2-day
 * chance, plus wider longer-range areas — so by default we show 5-day
 * only (higher signal density). Optional "2-day only" or "both" via the
 * gtwoWindow store selector.
 */

import type { GeoJSONSource, Map as MbMap } from "mapbox-gl";
import { useEffect } from "react";
import type { GTWOArea } from "../../api/live";
import { useLiveStormStore } from "../../state/liveStorm";

// NHC's operational Tropical Weather Outlook palette. Yellow=Low (< 40%),
// Orange=Medium (40-60%), Red=High (> 60%).
export const GTWO_BUCKET_COLOR: Record<string, string> = {
  low: "#facc15",       // yellow-400
  medium: "#f97316",    // orange-500
  high: "#dc2626",      // red-600
};

const SRC = "gtwo-areas";
const LAYER_FILL = "gtwo-areas-fill";
const LAYER_LINE = "gtwo-areas-line";
const LAYER_LABEL = "gtwo-areas-label";

interface Props {
  map: MbMap | null;
}

function pickAreas(
  data: import("../../api/live").GTWOResponse | null,
  window: "2" | "5" | "both",
): GTWOArea[] {
  if (!data) return [];
  if (window === "2") return data.twoDay;
  if (window === "5") return data.fiveDay;
  // both: 5-day first (drawn first, painted under), 2-day on top so the
  // sharper near-term chance dominates the visual read.
  return [...data.fiveDay, ...data.twoDay];
}

function buildFC(areas: GTWOArea[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: areas.map((a, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "Polygon", coordinates: [a.ring] },
      properties: {
        basin: a.basin,
        windowDays: a.windowDays,
        chancePct: a.chancePct,
        chanceBucket: a.chanceBucket,
        label: a.label,
        color: GTWO_BUCKET_COLOR[a.chanceBucket] ?? "#a3a3a3",
      },
    })),
  };
}

// Centroid of a polygon ring — used to anchor a "N%" label on the biggest
// point of each area without needing a full geometry math library.
function ringCentroid(ring: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  const n = Math.max(1, ring.length - 1);  // ring is closed; skip repeat
  for (let i = 0; i < n; i++) {
    x += ring[i]![0];
    y += ring[i]![1];
  }
  return [x / n, y / n];
}

function buildLabelFC(areas: GTWOArea[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: areas.map((a, i) => {
      const [lon, lat] = ringCentroid(a.ring);
      return {
        type: "Feature",
        id: `label-${i}`,
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          chancePct: a.chancePct,
          windowDays: a.windowDays,
        },
      };
    }),
  };
}

export function TWOLayer({ map }: Props) {
  const show = useLiveStormStore((s) => s.showGTWO);
  const data = useLiveStormStore((s) => s.gtwoData);
  const window = useLiveStormStore((s) => s.gtwoWindow);

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const areas = pickAreas(data, window);
      setSource(map, SRC, buildFC(areas));
      setSource(map, `${SRC}-labels`, buildLabelFC(areas));

      ensureLayer(map, LAYER_FILL, {
        id: LAYER_FILL, type: "fill", source: SRC,
        paint: {
          "fill-color": ["get", "color"] as unknown as never,
          "fill-opacity": 0.25,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_LINE, {
        id: LAYER_LINE, type: "line", source: SRC,
        paint: {
          "line-color": ["get", "color"] as unknown as never,
          "line-width": 2,
          "line-opacity": 0.85,
        },
      });
      // Formation-chance percentage right in the middle of each area — the
      // primary payload of the overlay, so it's always visible (no minzoom).
      ensureLayer(map, LAYER_LABEL, {
        id: LAYER_LABEL, type: "symbol", source: `${SRC}-labels`,
        layout: {
          "text-field": [
            "concat",
            ["to-string", ["get", "chancePct"]], "%",
            "\n",
            ["concat", ["to-string", ["get", "windowDays"]], "d"],
          ] as unknown as never,
          "text-size": 11,
          "text-anchor": "center",
          "text-allow-overlap": false,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.6,
        },
      });

      moveToTop(map, LAYER_FILL);
      moveToTop(map, LAYER_LINE);
      moveToTop(map, LAYER_LABEL);

      setVis(map, LAYER_FILL, show);
      setVis(map, LAYER_LINE, show);
      setVis(map, LAYER_LABEL, show);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, data, window, show]);

  // Hover popup — click area, see the full disturbance description.
  useEffect(() => {
    if (!map) return;
    let popup: mapboxgl.Popup | null = null;
    const onEnter = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        chancePct: number;
        chanceBucket: string;
        label: string;
        windowDays: number;
        color: string;
      };
      // The full description isn't packed into the feature (it's 500+ chars);
      // pull it out of the store data by matching label.
      const data = useLiveStormStore.getState().gtwoData;
      const full = data
        ? [...data.twoDay, ...data.fiveDay].find(
            (a) => a.label === p.label && a.windowDays === p.windowDays,
          )
        : null;
      const mb = await import("mapbox-gl");
      popup?.remove();
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4;max-width:320px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
              <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${p.color}"></span>
              <strong>${p.label}</strong>
            </div>
            <div style="color:#0f172a;font-weight:700;margin-bottom:2px">
              ${p.chancePct}% formation chance · ${p.windowDays}-day window
            </div>
            ${full?.description ? `<div style="color:#475569;font-size:10px;max-height:120px;overflow:auto">${full.description}</div>` : ""}
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
      if (map.getLayer(LAYER_FILL)) {
        map.on("mouseenter", LAYER_FILL, onEnter as never);
        map.on("mouseleave", LAYER_FILL, onLeave);
      }
    };
    if (map.isStyleLoaded()) reg();
    else map.once("idle", reg);
    return () => {
      try {
        map.off("mouseenter", LAYER_FILL, onEnter as never);
        map.off("mouseleave", LAYER_FILL, onLeave);
      } catch { /* torn down */ }
      popup?.remove();
    };
  }, [map]);

  return null;
}

function setSource(map: MbMap, id: string, data: GeoJSON.FeatureCollection): void {
  const existing = map.getSource(id) as GeoJSONSource | undefined;
  if (existing) { existing.setData(data as never); return; }
  map.addSource(id, { type: "geojson", data: data as never });
}
function ensureLayer(map: MbMap, id: string, layer: mapboxgl.AnyLayer, beforeId?: string): void {
  if (map.getLayer(id)) return;
  if (beforeId && map.getLayer(beforeId)) map.addLayer(layer as never, beforeId);
  else map.addLayer(layer as never);
}
function setVis(map: MbMap, id: string, visible: boolean): void {
  if (!map.getLayer(id)) return;
  map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}
function moveToTop(map: MbMap, id: string): void {
  if (!map.getLayer(id)) return;
  map.moveLayer(id);
}
