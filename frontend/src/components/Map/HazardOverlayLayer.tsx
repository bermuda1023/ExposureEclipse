/**
 * Hazard heatmap — tornado / hail / wildfire raw risk rendered as a smooth
 * lat/lon grid, ignoring county / state lines so the surface reads as a
 * continuous geographic phenomenon. Same render pattern as the SST layer:
 * one abutting square fill polygon per backend grid cell, coloured via the
 * legend's palette + raw-value stops.
 */

import type { GeoJSONSource, Map as MbMap } from "mapbox-gl";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHazard, type HazardResponse } from "../../api/hazards";
import { useHazardOverlayStore } from "../../state/hazardOverlay";

const SRC_HAZARD = "hazard-grid";
const LAYER_HAZARD = "hazard-grid-fill";

interface Props {
  map: MbMap | null;
}

function buildFC(data: HazardResponse | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (!data) return { type: "FeatureCollection" as const, features };
  const half = data.stepDeg / 2;
  for (const p of data.grid) {
    if (p.raw <= 0) continue;
    features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [p.lon - half, p.lat - half],
          [p.lon + half, p.lat - half],
          [p.lon + half, p.lat + half],
          [p.lon - half, p.lat + half],
          [p.lon - half, p.lat - half],
        ]],
      },
      properties: { raw: p.raw },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

/** Build a Mapbox interpolate expression from the legend's palette + stops
 * so the colour ramp on screen matches the legend exactly. */
function colorExpr(legend: HazardResponse["legend"] | undefined): unknown {
  if (!legend) return "rgba(0,0,0,0)";
  const expr: (string | number | unknown[])[] = ["interpolate", ["linear"], ["get", "raw"]];
  for (let i = 0; i < legend.stops.length; i++) {
    expr.push(legend.stops[i]!, legend.palette[i]!);
  }
  return expr;
}

export function HazardOverlayLayer({ map }: Props) {
  const active = useHazardOverlayStore((s) => s.active);

  const query = useQuery({
    queryKey: ["hazard", active],
    queryFn: () => fetchHazard(active!),
    enabled: active !== null,
    staleTime: 30 * 60_000,
  });

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const fc = buildFC(active ? query.data : undefined);
      const existing = map.getSource(SRC_HAZARD) as GeoJSONSource | undefined;
      if (existing) {
        existing.setData(fc as never);
      } else {
        map.addSource(SRC_HAZARD, { type: "geojson", data: fc as never });
        map.addLayer(
          {
            id: LAYER_HAZARD,
            type: "fill",
            source: SRC_HAZARD,
            paint: {
              "fill-color": colorExpr(query.data?.legend) as never,
              "fill-opacity": 0.72,
              "fill-outline-color": "rgba(0,0,0,0)",
            },
            layout: { visibility: "none" },
          },
          // Sit under the county outline so impact / focused outlines stay
          // visible on top of the hazard wash.
          map.getLayer("county-line") ? "county-line" : undefined,
        );
      }
      // Re-apply colour expression whenever the active peril changes —
      // each peril has its own palette + stops so the existing layer's
      // paint property needs to follow.
      if (map.getLayer(LAYER_HAZARD)) {
        if (query.data) {
          map.setPaintProperty(LAYER_HAZARD, "fill-color", colorExpr(query.data.legend) as never);
        }
        map.setLayoutProperty(
          LAYER_HAZARD,
          "visibility",
          active && query.data ? "visible" : "none",
        );
      }

      // Hazard heatmap and the TIV choropleth are different stories
      // visually — overlapping them is hard to read in either direction
      // (the colour scales fight and meaning gets muddled). Hide the
      // state + county TIV fill while a hazard chip is active; restore
      // them when the user clears the chip. The user's exposure scope
      // and feature-state aren't touched, so toggling off the hazard
      // immediately brings the original view back.
      const hideExposure = active !== null;
      for (const fillLayer of ["state-fill", "county-fill"]) {
        if (map.getLayer(fillLayer)) {
          map.setLayoutProperty(
            fillLayer,
            "visibility",
            hideExposure ? "none" : "visible",
          );
        }
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, active, query.data]);

  return null;
}
