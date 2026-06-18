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
const CONE_FILL = "hurricane-cone-fill";
const CONE_LINE = "hurricane-cone-line";
const SOURCE = "hurricane-source";
const FOOTPRINT_SOURCE = "hurricane-footprint";
const CONE_SOURCE = "hurricane-cone";

// Saffir-Simpson palette used inline in the cone + footprint fill expressions
// via a Mapbox ["step", ["get", "windKt"], default, stop, color, ...] form
// (matches the same pattern as LINE_LAYER and renders reliably).

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
    // Cap circles drawn at Rmax (eyewall) — same half-width as the cone
    // quads, so caps and quads together form a continuous wind-max swath.
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ringAround(pt.lat, pt.lon, pt.rmaxNm)] },
      properties: {
        windKt: pt.windKt,
        rmaxNm: pt.rmaxNm,
        rmaxSource: pt.rmaxSource,
      },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

/** Build the cone FeatureCollection — one Polygon per tapered quad between
 * adjacent footprint points. Coloring driven by ``properties.windKt`` via a
 * Mapbox interpolate expression on the fill layer. */
function buildConeFC(cone: import("../../api/hurricanes").ConeQuad[] | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (!cone) return { type: "FeatureCollection" as const, features };
  for (const q of cone) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [q.corners] },
      properties: {
        windKt: q.windKt,
        startWindKt: q.startWindKt,
        endWindKt: q.endWindKt,
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

  // ── Wind-field cone + endpoint circles for the actively-clicked storm ──
  // The cone is a stack of polygons supplied by the backend:
  //   1. Circles per ≥64 kt footprint point (rendered client-side from rmax)
  //   2. Tapered quads between adjacent points (`data.cone[]`)
  // Both layers are colored by wind speed via a Mapbox interpolate expression
  // so the swath gradients smoothly from Cat-1 yellow → Cat-5 dark red.
  const impactFootprint = useHurricaneImpactStore((s) => s.data?.footprint);
  const impactCone = useHurricaneImpactStore((s) => s.data?.cone);
  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const footprintFC = buildFootprintFC(activeImpactStormId ? impactFootprint : undefined);
      const coneFC = buildConeFC(activeImpactStormId ? impactCone : undefined);

      // Cone fill goes down FIRST (under the circles) so the per-point caps
      // sit on top, smoothing the bearing turns. Both layers share the same
      // wind-driven interpolate so the fills read as one continuous swath
      // and no outline strokes break it up into discrete shapes.
      const coneExisting = map.getSource(CONE_SOURCE) as GeoJSONSource | undefined;
      if (coneExisting) {
        coneExisting.setData(coneFC as never);
      } else {
        map.addSource(CONE_SOURCE, { type: "geojson", data: coneFC as never });
        map.addLayer(
          {
            id: CONE_FILL,
            type: "fill",
            source: CONE_SOURCE,
            paint: {
              // ["step", input, default_output, stop1, output1, ...] — matches
              // the same pattern as LINE_LAYER which works. Avoids the silent-
              // fail risk an interpolate expression had earlier.
              "fill-color": [
                "step", ["get", "windKt"],
                "#fde047",        // default (≥ 64 kt, < 83)
                83, "#fb923c",
                96, "#ea580c",
                113, "#b91c1c",
                137, "#581c87",
              ] as unknown as never,
              "fill-opacity": 0.55,
              "fill-outline-color": "rgba(0,0,0,0)",
            },
          },
          // Insert under the county outline so storm-hit / storm-focused
          // outlines stay visible on top of the cone fill.
          map.getLayer("county-line") ? "county-line" : undefined,
        );
      }

      const footExisting = map.getSource(FOOTPRINT_SOURCE) as GeoJSONSource | undefined;
      if (footExisting) {
        footExisting.setData(footprintFC as never);
      } else {
        map.addSource(FOOTPRINT_SOURCE, { type: "geojson", data: footprintFC as never });
        map.addLayer(
          {
            id: FOOTPRINT_FILL,
            type: "fill",
            source: FOOTPRINT_SOURCE,
            paint: {
              // ["step", input, default_output, stop1, output1, ...] — matches
              // the same pattern as LINE_LAYER which works. Avoids the silent-
              // fail risk an interpolate expression had earlier.
              "fill-color": [
                "step", ["get", "windKt"],
                "#fde047",        // default (≥ 64 kt, < 83)
                83, "#fb923c",
                96, "#ea580c",
                113, "#b91c1c",
                137, "#581c87",
              ] as unknown as never,
              "fill-opacity": 0.55,
              "fill-outline-color": "rgba(0,0,0,0)",
            },
          },
          // Insert under the county outline so storm-hit / storm-focused
          // outlines stay visible on top of the cone fill.
          map.getLayer("county-line") ? "county-line" : undefined,
        );
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, activeImpactStormId, impactFootprint, impactCone]);

  // ── Spotlight the clicked storm: fade every other path almost to nothing ──
  useEffect(() => {
    if (!map) return;
    if (!map.getLayer(LINE_LAYER)) return;
    if (activeImpactStormId) {
      // Selected storm: line stays as a thin spine on top of the cone fill.
      // Non-selected storms fade to a hint so the chosen event stands out.
      const hl = [
        "case",
        ["==", ["get", "stormId"], activeImpactStormId],
        0.55,
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
  for (const id of [CONE_LINE, CONE_FILL, FOOTPRINT_LINE, FOOTPRINT_FILL, LINE_LAYER, POINT_LAYER]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [SOURCE, `${SOURCE}-pts`, FOOTPRINT_SOURCE, CONE_SOURCE]) {
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
