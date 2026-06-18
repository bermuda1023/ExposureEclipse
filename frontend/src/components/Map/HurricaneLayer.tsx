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
import {
  fetchHurricaneImpact,
  listHurricanes,
  type HurricaneStorm,
} from "../../api/hurricanes";
import { useHurricaneStore } from "../../state/hurricanes";
import { useHurricaneImpactStore } from "../../state/hurricaneImpact";
import { useViewStore } from "../../state/view";
import { useFiltersStore } from "../../state/filters";
import { useEffectiveScope } from "../../state/useEffectiveScope";
import { SAFFIR_SIMPSON_COLORS, SAFFIR_SIMPSON_LABEL } from "./hurricaneColors";

const LINE_LAYER = "hurricane-lines";
const POINT_LAYER = "hurricane-landfall-points";
const FOOTPRINT_FILL = "hurricane-footprint-fill";
const FOOTPRINT_LINE = "hurricane-footprint-line";
const SOURCE = "hurricane-source";
const FOOTPRINT_SOURCE = "hurricane-footprint";

/** Build a 48-vertex polygon ring approximating a circle of radius (nm) around (lat, lon). */
const NM_PER_DEG_LAT = 60;
function ringAround(lat: number, lon: number, radiusNm: number, steps = 48): number[][] {
  const ring: number[][] = [];
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    const dLat = (radiusNm / NM_PER_DEG_LAT) * Math.cos(theta);
    const dLon = (radiusNm / (NM_PER_DEG_LAT * Math.max(cosLat, 0.01))) * Math.sin(theta);
    ring.push([lon + dLon, lat + dLat]);
  }
  return ring;
}

/** Build a FeatureCollection from the backend-supplied footprint points so
 * the visible buffer uses IBTrACS-measured Rmax wherever recon data exists
 * (and Willoughby for everything else). */
function buildFootprintFC(footprint: import("../../api/hurricanes").FootprintPoint[] | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (!footprint) return { type: "FeatureCollection" as const, features };
  for (const pt of footprint) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ringAround(pt.lat, pt.lon, pt.radiusNm)] },
      properties: {
        windKt: pt.windKt,
        rmaxNm: pt.rmaxNm,
        rmaxSource: pt.rmaxSource,
      },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

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
  const startImpact = useHurricaneImpactStore((s) => s.start);
  const setImpactData = useHurricaneImpactStore((s) => s.setData);
  const setImpactError = useHurricaneImpactStore((s) => s.setError);
  const activeImpactStormId = useHurricaneImpactStore((s) => s.activeStormId);
  // Effective scope is computed by the same hook the map + pivot + export
  // use, so a hurricane click always aggregates the SAME programmes the user
  // is looking at. Kept in a ref so changing scope doesn't tear down + rebuild
  // the Mapbox source/layers.
  const effectiveScope = useEffectiveScope();
  const scopeRef = useRef(effectiveScope);
  scopeRef.current = effectiveScope;
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

        const onClick = (e: MapMouseEvent) => {
          const feats = map.queryRenderedFeatures(e.point, { layers: [LINE_LAYER] });
          const props = feats[0]?.properties as Record<string, unknown> | undefined;
          const stormId = props?.stormId as string | undefined;
          if (!stormId) return;

          const view = useViewStore.getState();
          const filters = useFiltersStore.getState();
          const sc = scopeRef.current;
          const selectionPayload = {
            cedentId: sc.cedentId,
            chainId: sc.chainId,
            chainIds: sc.chainIds,
            programmeId: sc.programmeId,
            aggregationLevel: "COUNTY",
            metric: "TIV",
            perils: view.perils,
            filters: {
              peril: filters.peril,
              occupancy: filters.occupancy,
              distanceToCoast: filters.distanceToCoast,
              geocoding: filters.geocoding,
              construction: filters.construction,
              numberOfStories: filters.numberOfStories,
              yearBuilt: filters.yearBuilt,
            },
          };

          startImpact(stormId, selectionPayload);
          fetchHurricaneImpact(stormId, selectionPayload)
            .then((data) => setImpactData(data))
            .catch((err) => setImpactError(String((err as Error)?.message ?? err)));
        };

        map.on("mousemove", LINE_LAYER, onMove);
        map.on("mouseleave", LINE_LAYER, onLeave);
        map.on("click", LINE_LAYER, onClick);

        cleanupRef.current = () => {
          map.off("mousemove", LINE_LAYER, onMove);
          map.off("mouseleave", LINE_LAYER, onLeave);
          map.off("click", LINE_LAYER, onClick);
        };
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);

    return () => {
      // Don't tear down on every dep change — only when the layer is disabled.
    };
  }, [map, enabled, query.data]);

  // ── Wind-footprint overlay for the actively-clicked storm ──
  // Uses the backend-supplied footprint (IBTrACS-measured Rmax where recon
  // data exists, Willoughby fallback otherwise) so the visible buffer matches
  // the same physics the county-impact set was tested against.
  const impactFootprint = useHurricaneImpactStore((s) => s.data?.footprint);
  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const fc = buildFootprintFC(activeImpactStormId ? impactFootprint : undefined);
      const existing = map.getSource(FOOTPRINT_SOURCE) as GeoJSONSource | undefined;
      if (existing) {
        existing.setData(fc as never);
      } else {
        map.addSource(FOOTPRINT_SOURCE, { type: "geojson", data: fc as never });
        map.addLayer(
          {
            id: FOOTPRINT_FILL,
            type: "fill",
            source: FOOTPRINT_SOURCE,
            paint: {
              "fill-color": "#dc2626",
              "fill-opacity": 0.12,
            },
          },
          LINE_LAYER, // sit BELOW the storm lines so the highlighted line stays on top
        );
        map.addLayer(
          {
            id: FOOTPRINT_LINE,
            type: "line",
            source: FOOTPRINT_SOURCE,
            paint: {
              "line-color": "#dc2626",
              "line-width": 1.2,
              "line-opacity": 0.45,
            },
          },
          LINE_LAYER,
        );
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, activeImpactStormId, impactFootprint]);

  // ── Spotlight the clicked storm: fade every other path almost to nothing ──
  useEffect(() => {
    if (!map) return;
    if (!map.getLayer(LINE_LAYER)) return;
    if (activeImpactStormId) {
      const hl = [
        "case",
        ["==", ["get", "stormId"], activeImpactStormId],
        1.0,
        0.04,
      ] as unknown as never;
      const widthHl = [
        "case",
        ["==", ["get", "stormId"], activeImpactStormId],
        [
          "interpolate",
          ["linear"],
          ["get", "cat"],
          -1, 1.8,
          0, 2.2,
          1, 2.8,
          2, 3.4,
          3, 4.0,
          4, 4.6,
          5, 5.2,
        ],
        [
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
      ] as unknown as never;
      map.setPaintProperty(LINE_LAYER, "line-opacity", hl);
      map.setPaintProperty(LINE_LAYER, "line-width", widthHl);
      if (map.getLayer(POINT_LAYER)) {
        map.setPaintProperty(POINT_LAYER, "circle-opacity", hl);
        map.setPaintProperty(POINT_LAYER, "circle-stroke-opacity", hl);
      }
    } else {
      // Restore defaults.
      map.setPaintProperty(LINE_LAYER, "line-opacity", 0.92);
      map.setPaintProperty(LINE_LAYER, "line-width", [
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
      ] as unknown as never);
      if (map.getLayer(POINT_LAYER)) {
        map.setPaintProperty(POINT_LAYER, "circle-opacity", 1);
        map.setPaintProperty(POINT_LAYER, "circle-stroke-opacity", 1);
      }
    }
  }, [map, activeImpactStormId, query.data]);

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
  for (const id of [FOOTPRINT_LINE, FOOTPRINT_FILL, LINE_LAYER, POINT_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [SOURCE, `${SOURCE}-pts`, FOOTPRINT_SOURCE]) {
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
