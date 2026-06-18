/**
 * Hurricane track overlay. Pulls NOAA HURDAT2 (1950+) via the backend,
 * builds a Mapbox source where each track is split into per-segment
 * LineStrings carrying the segment's wind speed + Saffir-Simpson category,
 * and renders them coloured by category. Hovering a segment surfaces the
 * storm's name, year, and strength.
 *
 * The component installs Mapbox layers via `useEffect` and tears them down
 * on unmount or when the filter set changes (debounced refetch via the
 * TanStack Query key on the filter params).
 */

import type { GeoJSONSource, Map as MbMap, MapMouseEvent } from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listHurricanes, type HurricaneStorm } from "../../api/hurricanes";
import { useHurricaneStore } from "../../state/hurricanes";
import { SAFFIR_SIMPSON_COLORS, SAFFIR_SIMPSON_LABEL } from "./hurricaneColors";

const LINE_LAYER = "hurricane-lines";
const POINT_LAYER = "hurricane-landfall-points";
const SOURCE = "hurricane-source";

interface Props {
  map: MbMap | null;
}

interface HoveredSegment {
  stormId: string;
  name: string;
  year: number;
  landfallCategory: number;
  landfallState: string | null;
  peakWindKt: number;
  segmentWindKt: number;
  segmentCategory: number;
}

export function HurricaneLayer({ map }: Props) {
  const { enabled, yearMin, yearMax, minCategory, landfallOnly } = useHurricaneStore();
  const [hovered, setHovered] = useState<HoveredSegment | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const query = useQuery({
    queryKey: ["hurricanes", { yearMin, yearMax, minCategory, landfallOnly }],
    queryFn: () => listHurricanes({ yearMin, yearMax, minCategory, landfallOnly }),
    enabled,
    staleTime: 10 * 60_000,
  });

  // ── Apply / update the Mapbox source + layers ──
  useEffect(() => {
    if (!map) return;

    // Tear down when disabled or query has nothing.
    if (!enabled || !query.data) {
      cleanupRef.current?.();
      cleanupRef.current = null;
      removeLayers(map);
      return;
    }

    const apply = () => {
      const lineFC = buildSegmentFeatureCollection(query.data!.storms);
      const pointFC = buildLandfallPointCollection(query.data!.storms);

      const existing = map.getSource(SOURCE) as GeoJSONSource | undefined;
      if (existing) {
        existing.setData(lineFC as never);
        const ptSrc = map.getSource(`${SOURCE}-pts`) as GeoJSONSource | undefined;
        ptSrc?.setData(pointFC as never);
      } else {
        map.addSource(SOURCE, { type: "geojson", data: lineFC as never });
        map.addSource(`${SOURCE}-pts`, { type: "geojson", data: pointFC as never });

        const colorStops: (string | number)[] = [
          SAFFIR_SIMPSON_COLORS[-1],
          0, SAFFIR_SIMPSON_COLORS[0],
          1, SAFFIR_SIMPSON_COLORS[1],
          2, SAFFIR_SIMPSON_COLORS[2],
          3, SAFFIR_SIMPSON_COLORS[3],
          4, SAFFIR_SIMPSON_COLORS[4],
          5, SAFFIR_SIMPSON_COLORS[5],
        ];

        map.addLayer({
          id: LINE_LAYER,
          type: "line",
          source: SOURCE,
          paint: {
            "line-color": ["step", ["get", "cat"], ...colorStops],
            "line-width": [
              "interpolate",
              ["linear"],
              ["get", "cat"],
              -1, 1.2,
              0, 1.5,
              1, 2,
              2, 2.5,
              3, 3,
              4, 3.5,
              5, 4,
            ],
            "line-opacity": 0.92,
          },
        });

        map.addLayer({
          id: POINT_LAYER,
          type: "circle",
          source: `${SOURCE}-pts`,
          paint: {
            "circle-radius": 5,
            "circle-color": "#ffffff",
            "circle-stroke-color": ["step", ["get", "cat"], ...colorStops],
            "circle-stroke-width": 2,
          },
        });

        const onMove = (e: MapMouseEvent) => {
          const feats = map.queryRenderedFeatures(e.point, { layers: [LINE_LAYER] });
          const props = feats[0]?.properties as Record<string, unknown> | undefined;
          if (!props) {
            setHovered(null);
            setCursor(null);
            map.getCanvas().style.cursor = "";
            return;
          }
          setHovered({
            stormId: props.stormId as string,
            name: props.name as string,
            year: Number(props.year),
            landfallCategory: Number(props.landfallCategory),
            landfallState: (props.landfallState as string | null) ?? null,
            peakWindKt: Number(props.peakWindKt),
            segmentWindKt: Number(props.windKt),
            segmentCategory: Number(props.cat),
          });
          setCursor({ x: e.point.x, y: e.point.y });
          map.getCanvas().style.cursor = "pointer";
        };
        const onLeave = () => {
          setHovered(null);
          setCursor(null);
          map.getCanvas().style.cursor = "";
        };

        map.on("mousemove", LINE_LAYER, onMove);
        map.on("mouseleave", LINE_LAYER, onLeave);

        cleanupRef.current = () => {
          map.off("mousemove", LINE_LAYER, onMove);
          map.off("mouseleave", LINE_LAYER, onLeave);
        };
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);

    return () => {
      // Don't tear down on every dep change — only when the layer is disabled.
    };
  }, [map, enabled, query.data]);

  // Tooltip overlay sits on top of the map container.
  if (!hovered || !cursor || !enabled) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: Math.min(cursor.x + 14, 1200),
        top: Math.min(cursor.y + 14, 800),
        pointerEvents: "none",
        zIndex: 6,
        background: "rgba(255,255,255,0.97)",
        border: "1px solid var(--ink-300)",
        borderRadius: "var(--radius)",
        padding: "8px 10px",
        fontSize: "0.78rem",
        boxShadow: "var(--shadow-md)",
        color: "var(--ink-900)",
        minWidth: 200,
      }}
    >
      <div style={{ fontWeight: 700 }}>
        {hovered.name} ({hovered.year})
      </div>
      <div style={{ color: "var(--ink-500)", fontSize: "0.7rem", marginTop: 2 }}>
        Landfall: {SAFFIR_SIMPSON_LABEL[hovered.landfallCategory] ?? "—"}
        {hovered.landfallState ? ` · ${hovered.landfallState}` : ""}
      </div>
      <hr style={{ border: "none", borderTop: "1px solid var(--ink-200)", margin: "6px 0 4px" }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
        <span style={{ color: "var(--ink-600)" }}>Peak wind</span>
        <strong>{hovered.peakWindKt} kt</strong>
        <span style={{ color: "var(--ink-600)" }}>Segment wind</span>
        <strong>
          {hovered.segmentWindKt} kt — {SAFFIR_SIMPSON_LABEL[hovered.segmentCategory] ?? "—"}
        </strong>
      </div>
    </div>
  );
}

// ───────────────────────── helpers ─────────────────────────

function removeLayers(map: MbMap) {
  for (const id of [LINE_LAYER, POINT_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [SOURCE, `${SOURCE}-pts`]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

/**
 * Turn each storm into N-1 line-segment features, carrying the higher of the
 * two endpoints' wind speed (so the segment colour reflects the more intense
 * end of the leg — visually conservative).
 */
function buildSegmentFeatureCollection(storms: HurricaneStorm[]) {
  const features: GeoJSON.Feature[] = [];
  for (const s of storms) {
    for (let i = 0; i < s.track.length - 1; i++) {
      const a = s.track[i]!;
      const b = s.track[i + 1]!;
      const wind = Math.max(a.windKt, b.windKt);
      const cat = Math.max(a.category, b.category);
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
        properties: {
          stormId: s.stormId,
          name: s.name,
          year: s.year,
          landfallCategory: s.landfallCategory,
          landfallState: s.landfallState,
          peakWindKt: s.peakWindKt,
          windKt: wind,
          cat,
        },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

/** Small dots at every landfall point for visual emphasis. */
function buildLandfallPointCollection(storms: HurricaneStorm[]) {
  const features: GeoJSON.Feature[] = [];
  for (const s of storms) {
    for (const p of s.track) {
      if (!p.isLandfall) continue;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: {
          stormId: s.stormId,
          name: s.name,
          year: s.year,
          cat: p.category,
        },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}
