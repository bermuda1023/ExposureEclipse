/**
 * Ensemble strike-probability by county — coloured circles at each county
 * centroid, radius + colour keyed on P(strike within threshold nm). Reads
 * like a heat map at basin-scale zoom, but stays sharp because it's one
 * point per county rather than an interpolated field.
 *
 * The counties are a subset of the US coastal states — no point walking
 * 3,000 US counties when the storm is off Florida — so the visual density
 * is naturally bounded.
 */

import type { GeoJSONSource, Map as MbMap } from "mapbox-gl";
import { useEffect } from "react";
import type { CountyStrikeProb } from "../../api/live";
import { useLiveStormStore } from "../../state/liveStorm";

const SRC = "ensemble-strike";
const LAYER_FILL = "ensemble-strike-circle";
const LAYER_LABEL = "ensemble-strike-label";

// Diverging palette: cool at low probability → red at high. Interpolated so
// low-P areas fade to near-invisible instead of hard-cutting off.
const STRIKE_PROB_COLOR: unknown[] = [
  "interpolate", ["linear"], ["get", "strikeProbability"],
  0.05, "#bfdbfe",   // light blue — barely-passing
  0.20, "#fef3c7",   // pale yellow
  0.40, "#fb923c",   // orange
  0.60, "#dc2626",   // red
  0.80, "#7f1d1d",   // dark red
  1.00, "#3b0764",   // dark purple — near-certain strike
];

interface Props {
  map: MbMap | null;
}

function buildFC(counties: CountyStrikeProb[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: counties.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.centroidLon, c.centroidLat] },
      properties: {
        geoid: c.geoid,
        name: c.name,
        stateUsps: c.stateUsps,
        strikeProbability: c.strikeProbability,
        memberCount: c.memberCount,
        ensembleTotal: c.ensembleTotal,
        maxIntensityKt: c.maxIntensityKt,
      },
    })),
  };
}

export function StrikeProbabilityLayer({ map }: Props) {
  const show = useLiveStormStore((s) => s.showStrikeProbability);
  const risk = useLiveStormStore((s) => s.ensembleRisk);

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const counties = risk?.strikeByCounty ?? [];
      setSource(map, SRC, buildFC(counties));

      ensureLayer(map, LAYER_FILL, {
        id: LAYER_FILL, type: "circle", source: SRC,
        paint: {
          // Radius scales with P(strike): 6 px at 5% up to 20 px at 100%.
          // Keeps low-P specks legible without drowning the map at high-P.
          "circle-radius": [
            "interpolate", ["linear"], ["get", "strikeProbability"],
            0.05, 4,
            0.30, 9,
            0.60, 14,
            1.00, 20,
          ] as unknown as never,
          "circle-color": STRIKE_PROB_COLOR as unknown as never,
          "circle-opacity": 0.75,
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 0.8,
          "circle-stroke-opacity": 0.65,
        },
      });
      ensureLayer(map, LAYER_LABEL, {
        id: LAYER_LABEL, type: "symbol", source: SRC,
        minzoom: 5,
        layout: {
          "text-field": [
            "concat",
            ["to-string", ["round", ["*", ["get", "strikeProbability"], 100]]],
            "%",
          ] as unknown as never,
          "text-size": 10,
          "text-anchor": "center",
          "text-allow-overlap": false,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      });

      moveToTop(map, LAYER_FILL);
      moveToTop(map, LAYER_LABEL);
      setVis(map, LAYER_FILL, show);
      setVis(map, LAYER_LABEL, show);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, risk, show]);

  // Hover popup: full context (member count, threshold, max intensity).
  useEffect(() => {
    if (!map) return;
    let popup: mapboxgl.Popup | null = null;
    const onEnter = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        name: string;
        stateUsps: string;
        strikeProbability: number;
        memberCount: number;
        ensembleTotal: number;
        maxIntensityKt: number;
      };
      const mb = await import("mapbox-gl");
      popup?.remove();
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4;min-width:200px">
            <div style="font-weight:700">${p.name}, ${p.stateUsps}</div>
            <div style="margin-top:3px">
              P(strike): <strong>${(p.strikeProbability * 100).toFixed(0)}%</strong>
              <span style="color:#64748b"> · ${p.memberCount}/${p.ensembleTotal} members</span>
            </div>
            <div style="color:#64748b">Peak intensity of passing members: ${p.maxIntensityKt} kt</div>
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
function ensureLayer(map: MbMap, id: string, layer: mapboxgl.AnyLayer): void {
  if (map.getLayer(id)) return;
  map.addLayer(layer as never);
}
function setVis(map: MbMap, id: string, visible: boolean): void {
  if (!map.getLayer(id)) return;
  map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}
function moveToTop(map: MbMap, id: string): void {
  if (!map.getLayer(id)) return;
  map.moveLayer(id);
}
