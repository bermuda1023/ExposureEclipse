/**
 * Model ensemble spaghetti tracks (GEFS / ECMWF-ENS / AI models) + optional
 * consensus envelopes rendered on the active live storm.
 *
 * One LineString feature per ModelTrack, with the family + tech id on the
 * properties so a single fill/line paint can key colour per family. Family
 * toggles hide entire buckets without dropping their features from the
 * source (setLayoutProperty by family value).
 *
 * Envelopes render as two translucent polygons: the full ensemble consensus
 * (all NWP-ensemble + AI members combined) and the AI-only consensus. Both
 * are optional toggles — enabled explicitly so they don't clutter the
 * default view.
 */

import type { GeoJSONSource, Map as MbMap } from "mapbox-gl";
import { useEffect } from "react";
import type {
  EnsembleEnvelope,
  ModelFamily,
  ModelTrack,
} from "../../api/live";
import { useLiveStormStore } from "../../state/liveStorm";

// Family colour palette. Chosen so ensembles and their means read as related
// (GEFS members grey → GEFS mean red; ECMWF members light blue → ECMWF mean
// dark blue). AI models get a distinctive purple/magenta family so the
// visual message "these are the AI models" is unmissable in a spaghetti plot.
export const FAMILY_COLOR: Record<ModelFamily, string> = {
  official: "#0f172a",       // black — NHC official
  consensus: "#7f1d1d",      // dark red — TVCN / HCCA
  ai: "#a855f7",             // purple — GraphCast / GenCast / AIFS / FourCastNet / Pangu
  gfs_det: "#dc2626",        // red — GFS deterministic
  gfs_mean: "#f97316",       // orange — GEFS mean
  gefs_ens: "#94a3b8",       // slate — GEFS members
  ecmwf_det: "#1e3a8a",      // navy — ECMWF-HRES
  ecmwf_mean: "#2563eb",     // royal blue — ECMWF-ENS mean
  ecmwf_ens: "#bfdbfe",      // light blue — ECMWF-ENS members
  regional: "#059669",       // emerald — HWRF / HMON / HAFS / COAMPS-TC
  cmc: "#7c3aed",            // violet — Canadian
  ukmet: "#0891b2",          // cyan — UKMO
  navgem: "#eab308",         // yellow — NAVGEM
  baseline: "#a1a1aa",       // grey — CLIPER / SHIPS
  analysis: "#6b7280",       // dark grey — CARQ
  other: "#a1a1aa",
};

const FAMILY_WIDTH: Record<ModelFamily, number> = {
  official: 4,      // fattest — this is the underwriter's baseline
  consensus: 3,
  ai: 2.5,
  gfs_det: 2.5,
  gfs_mean: 2.5,
  gefs_ens: 1.2,    // thin — 30 lines
  ecmwf_det: 2.5,
  ecmwf_mean: 2.5,
  ecmwf_ens: 1.2,   // thin — 50 lines
  regional: 2,
  cmc: 2,
  ukmet: 2,
  navgem: 2,
  baseline: 1.5,
  analysis: 1.5,
  other: 1.5,
};

const SRC_TRACKS = "model-tracks";
const SRC_ENVELOPE = "model-tracks-envelope";
const SRC_AI_ENVELOPE = "model-tracks-ai-envelope";
const LAYER_TRACKS = "model-tracks-line";
const LAYER_TRACK_END_LABELS = "model-tracks-end-labels";
const LAYER_ENVELOPE = "model-tracks-envelope-fill";
const LAYER_ENVELOPE_LINE = "model-tracks-envelope-line";
const LAYER_AI_ENVELOPE = "model-tracks-ai-envelope-fill";
const LAYER_AI_ENVELOPE_LINE = "model-tracks-ai-envelope-line";

interface Props {
  map: MbMap | null;
}

function buildTracksFC(
  tracks: ModelTrack[],
  visibleFamilies: Set<ModelFamily>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const t of tracks) {
    if (!visibleFamilies.has(t.family)) continue;
    if (t.fixes.length < 2) continue;
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: t.fixes.map((f) => [f.lon, f.lat]),
      },
      properties: {
        techId: t.techId,
        label: t.label,
        family: t.family,
        // End point of track — used by the label symbol layer.
        endLon: t.fixes[t.fixes.length - 1]!.lon,
        endLat: t.fixes[t.fixes.length - 1]!.lat,
        maxHours: t.fixes[t.fixes.length - 1]!.hoursOut,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function buildEndPointsFC(
  tracks: ModelTrack[],
  visibleFamilies: Set<ModelFamily>,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const t of tracks) {
    if (!visibleFamilies.has(t.family)) continue;
    if (t.fixes.length < 2) continue;
    // Only label deterministic + AI + consensus + official + means — labelling
    // 30 ensemble members would just be noise.
    if (
      t.family === "gefs_ens"
      || t.family === "ecmwf_ens"
      || t.family === "analysis"
      || t.family === "baseline"
      || t.family === "other"
    ) continue;
    const end = t.fixes[t.fixes.length - 1]!;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [end.lon, end.lat] },
      properties: { techId: t.techId, label: t.label, family: t.family },
    });
  }
  return { type: "FeatureCollection", features };
}

function buildEnvelopeFC(
  env: EnsembleEnvelope | null,
): GeoJSON.FeatureCollection {
  if (!env || env.ring.length < 3) {
    return { type: "FeatureCollection", features: [] };
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [env.ring] },
        properties: { membersUsed: env.membersUsed },
      },
    ],
  };
}

const FAMILY_MATCH_COLOR: unknown[] = [
  "match", ["get", "family"],
  ...Object.entries(FAMILY_COLOR).flatMap(([f, c]) => [f, c]),
  "#a1a1aa",
];

const FAMILY_MATCH_WIDTH: unknown[] = [
  "match", ["get", "family"],
  ...Object.entries(FAMILY_WIDTH).flatMap(([f, w]) => [f, w]),
  1.5,
];

export function ModelTrackLayer({ map }: Props) {
  const showTracks = useLiveStormStore((s) => s.showModelTracks);
  const showEnv = useLiveStormStore((s) => s.showEnsembleEnvelope);
  const showAiEnv = useLiveStormStore((s) => s.showAiEnvelope);
  const modelTracks = useLiveStormStore((s) => s.modelTracks);
  const visibleFamilies = useLiveStormStore((s) => s.visibleFamilies);

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const tracks = modelTracks?.tracks ?? [];
      setSource(map, SRC_TRACKS, buildTracksFC(tracks, visibleFamilies));
      setSource(
        map,
        SRC_ENVELOPE,
        buildEnvelopeFC(modelTracks?.ensembleEnvelope ?? null),
      );
      setSource(
        map,
        SRC_AI_ENVELOPE,
        buildEnvelopeFC(modelTracks?.aiEnvelope ?? null),
      );
      setSource(
        map,
        `${SRC_TRACKS}-endpoints`,
        buildEndPointsFC(tracks, visibleFamilies),
      );

      ensureLayer(map, LAYER_ENVELOPE, {
        id: LAYER_ENVELOPE, type: "fill", source: SRC_ENVELOPE,
        paint: {
          "fill-color": "#7f1d1d",
          "fill-opacity": 0.08,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_ENVELOPE_LINE, {
        id: LAYER_ENVELOPE_LINE, type: "line", source: SRC_ENVELOPE,
        paint: {
          "line-color": "#7f1d1d",
          "line-width": 1.5,
          "line-opacity": 0.5,
          "line-dasharray": [6, 3] as unknown as never,
        },
      });
      ensureLayer(map, LAYER_AI_ENVELOPE, {
        id: LAYER_AI_ENVELOPE, type: "fill", source: SRC_AI_ENVELOPE,
        paint: {
          "fill-color": "#a855f7",
          "fill-opacity": 0.10,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_AI_ENVELOPE_LINE, {
        id: LAYER_AI_ENVELOPE_LINE, type: "line", source: SRC_AI_ENVELOPE,
        paint: {
          "line-color": "#a855f7",
          "line-width": 1.5,
          "line-opacity": 0.65,
          "line-dasharray": [2, 2] as unknown as never,
        },
      });
      ensureLayer(map, LAYER_TRACKS, {
        id: LAYER_TRACKS, type: "line", source: SRC_TRACKS,
        paint: {
          "line-color": FAMILY_MATCH_COLOR as unknown as never,
          "line-width": FAMILY_MATCH_WIDTH as unknown as never,
          "line-opacity": [
            "case",
            ["==", ["get", "family"], "gefs_ens"], 0.55,
            ["==", ["get", "family"], "ecmwf_ens"], 0.6,
            0.9,
          ] as unknown as never,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      // Small circular "end of forecast" marker + tech id label. Officials
      // and deterministic models get a legible label so the underwriter can
      // read "this line is ECMWF" without hovering.
      ensureLayer(map, LAYER_TRACK_END_LABELS, {
        id: LAYER_TRACK_END_LABELS, type: "symbol",
        source: `${SRC_TRACKS}-endpoints`,
        minzoom: 3.5,
        layout: {
          "text-field": ["get", "techId"] as unknown as never,
          "text-size": 10,
          "text-offset": [0, 0.9] as unknown as never,
          "text-anchor": "top",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        },
        paint: {
          "text-color": FAMILY_MATCH_COLOR as unknown as never,
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      // Track lines paint above county tiles but below cone / observed
      // trace lines. The reorder is idempotent.
      moveToTop(map, LAYER_ENVELOPE);
      moveToTop(map, LAYER_ENVELOPE_LINE);
      moveToTop(map, LAYER_AI_ENVELOPE);
      moveToTop(map, LAYER_AI_ENVELOPE_LINE);
      moveToTop(map, LAYER_TRACKS);
      moveToTop(map, LAYER_TRACK_END_LABELS);

      setVis(map, LAYER_TRACKS, showTracks);
      setVis(map, LAYER_TRACK_END_LABELS, showTracks);
      setVis(map, LAYER_ENVELOPE, showTracks && showEnv);
      setVis(map, LAYER_ENVELOPE_LINE, showTracks && showEnv);
      setVis(map, LAYER_AI_ENVELOPE, showTracks && showAiEnv);
      setVis(map, LAYER_AI_ENVELOPE_LINE, showTracks && showAiEnv);
    };

    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, modelTracks, visibleFamilies, showTracks, showEnv, showAiEnv]);

  // Hover popup — read "this line is X" without clicking.
  useEffect(() => {
    if (!map) return;
    let popup: mapboxgl.Popup | null = null;

    const onEnter = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        techId: string;
        label: string;
        family: string;
        maxHours: number;
      };
      const mb = await import("mapbox-gl");
      popup?.remove();
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
              <span style="display:inline-block;width:12px;height:3px;background:${FAMILY_COLOR[p.family as ModelFamily] ?? "#94a3b8"}"></span>
              <strong>${p.label}</strong>
            </div>
            <div style="color:#64748b">Tech id: <code>${p.techId}</code></div>
            <div style="color:#64748b">Runs to T+${p.maxHours}h</div>
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
      if (map.getLayer(LAYER_TRACKS)) {
        map.on("mouseenter", LAYER_TRACKS, onEnter as never);
        map.on("mouseleave", LAYER_TRACKS, onLeave);
      }
    };
    if (map.isStyleLoaded()) reg();
    else map.once("idle", reg);

    return () => {
      try {
        map.off("mouseenter", LAYER_TRACKS, onEnter as never);
        map.off("mouseleave", LAYER_TRACKS, onLeave);
      } catch { /* torn down */ }
      popup?.remove();
    };
  }, [map]);

  return null;
}

// Helpers duplicated from LiveStormLayer — small enough that a shared module
// isn't worth the churn; if a third layer copies these, extract.
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
