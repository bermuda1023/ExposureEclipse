/**
 * NHC Tropical Weather Outlook (GTWO) formation-area polygons.
 *
 * Basin-wide overlay — independent of any active storm. Renders one polygon
 * per active disturbance coloured by NHC's standard legend:
 *   gray   = none / < 10%
 *   yellow = low     (< 40%)
 *   orange = medium  (40-60%)
 *   red    = high    (> 60%)
 *
 * NHC's KML encodes chance only as a bucket via styleUrl, not as an exact
 * percent, so we display the bucket midpoint (0/20/50/80) as the number.
 * Each area gets an "N%" label at NHC's designated point marker (falling
 * back to the polygon centroid).
 */

import type { GeoJSONSource, Map as MbMap } from "mapbox-gl";
import { useEffect } from "react";
import type { GTWOArea } from "../../api/live";
import { useLiveStormStore } from "../../state/liveStorm";

// NHC's operational Tropical Weather Outlook palette.
export const GTWO_BUCKET_COLOR: Record<string, string> = {
  none: "#94a3b8",       // slate — 0% (still monitoring)
  low: "#facc15",        // yellow — < 40%
  medium: "#f97316",     // orange — 40-60%
  high: "#dc2626",       // red — > 60%
};

const SRC = "gtwo-areas";
const LAYER_FILL = "gtwo-areas-fill";
const LAYER_LINE = "gtwo-areas-line";
const LAYER_LABEL = "gtwo-areas-label";

interface Props {
  map: MbMap | null;
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
        chancePct: a.chancePct,
        chanceBucket: a.chanceBucket,
        label: a.label,
        color: GTWO_BUCKET_COLOR[a.chanceBucket] ?? "#94a3b8",
      },
    })),
  };
}

// Centroid of a polygon ring — used to anchor a label when NHC's own
// point marker is missing.
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
      // Prefer NHC's designated point marker (the "L" / "M" / "H" glyph
      // location on their own graphics); fall back to polygon centroid.
      const [lon, lat] = a.marker ?? ringCentroid(a.ring);
      return {
        type: "Feature",
        id: `label-${i}`,
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          chancePct: a.chancePct,
          chanceBucket: a.chanceBucket,
          color: GTWO_BUCKET_COLOR[a.chanceBucket] ?? "#94a3b8",
        },
      };
    }),
  };
}

export function TWOLayer({ map }: Props) {
  const show = useLiveStormStore((s) => s.showGTWO);
  const data = useLiveStormStore((s) => s.gtwoData);

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const areas = data?.areas ?? [];
      setSource(map, SRC, buildFC(areas));
      setSource(map, `${SRC}-labels`, buildLabelFC(areas));

      ensureLayer(map, LAYER_FILL, {
        id: LAYER_FILL, type: "fill", source: SRC,
        paint: {
          "fill-color": ["get", "color"] as unknown as never,
          "fill-opacity": 0.28,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_LINE, {
        id: LAYER_LINE, type: "line", source: SRC,
        paint: {
          "line-color": ["get", "color"] as unknown as never,
          "line-width": 2,
          "line-opacity": 0.9,
        },
      });
      // Formation-chance percentage at NHC's marker location. Filled circle
      // background so the label stays legible against ocean base tiles.
      ensureLayer(map, LAYER_LABEL, {
        id: LAYER_LABEL, type: "symbol", source: `${SRC}-labels`,
        layout: {
          "text-field": [
            "concat",
            ["to-string", ["get", "chancePct"]], "%",
          ] as unknown as never,
          "text-size": 13,
          "text-anchor": "center",
          "text-allow-overlap": true,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
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
  }, [map, data, show]);

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
        color: string;
      };
      // Full description isn't in the current KML; if we ever get it back
      // pull it out of the store by matching label.
      const data = useLiveStormStore.getState().gtwoData;
      const full = data?.areas.find((a) => a.label === p.label) ?? null;
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
              ${p.chancePct}% chance · ${p.chanceBucket} · 7-day formation envelope
            </div>
            ${full?.description ? `<div style="color:#475569;font-size:10px;max-height:120px;overflow:auto">${full.description}</div>` : ""}
            ${data?.issuedNote ? `<div style="color:#64748b;font-size:10px;margin-top:3px">Issued ${data.issuedNote}</div>` : ""}
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
