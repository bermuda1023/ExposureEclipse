/**
 * Live wildfire overlay layer — three independent, toggleable layers over the
 * TIV choropleth (or on their own when exposures are hidden):
 *
 *   1. Perimeters   — official NIFC/WFIGS burn polygons; outline = containment.
 *   2. Heat shapes  — our own occupied-cell footprints from FIRMS (truer than
 *                     a convex hull — respects gaps/concavities).
 *   3. Heat points  — raw FIRMS detections, FRP-coloured, on top.
 *
 * Click perimeters/shapes to multi-select and combine them (see WildfirePanel).
 * Selected fires get a white highlight outline.
 */

import mapboxgl, { type GeoJSONSource, type Map as MbMap } from "mapbox-gl";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchLiveWildfire, type WildfireResponse } from "../../api/wildfire";
import { useLiveWildfireStore, MIN_SIZE_PARAMS, type SelectedFire } from "../../state/liveWildfire";

const SRC_PERIM = "wildfire-perimeters";
const L_FILL = "wildfire-perimeter-fill";
const L_LINE = "wildfire-perimeter-line";
const SRC_SHAPES = "wildfire-heat-shapes";
const L_SHAPE_FILL = "wildfire-heat-shape-fill";
const L_SHAPE_LINE = "wildfire-heat-shape-line";
const SRC_HEAT = "wildfire-heat";
const L_HEAT = "wildfire-heat-point";
const SRC_SELECTED = "wildfire-selected";
const L_SELECTED = "wildfire-selected-line";
const EXPOSURE_FILLS = ["state-fill", "county-fill"];

interface Props { map: MbMap | null; }

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

const LINE_COLOR = [
  "interpolate", ["linear"], ["coalesce", ["get", "percentContained"], 0],
  0, "#dc2626", 50, "#f59e0b", 100, "#16a34a",
];
const HEAT_COLOR = [
  "interpolate", ["linear"], ["coalesce", ["get", "frp"], 0],
  0, "#fde047", 40, "#f97316", 150, "#dc2626",
];

function heatFC(data: WildfireResponse | undefined): GeoJSON.FeatureCollection {
  if (!data) return EMPTY_FC;
  return {
    type: "FeatureCollection",
    features: data.activeFires.map((a) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [a.lon, a.lat] },
      properties: { frp: a.frpMw, brightness: a.brightnessK },
    })),
  };
}

function selectedFC(fires: SelectedFire[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: fires.map((f) => ({ type: "Feature", geometry: f.geometry, properties: { id: f.id } })),
  };
}

function acres(n: number | null): string {
  return n == null ? "—" : `${Math.round(n).toLocaleString()} ac`;
}

export function WildfireLayer({ map }: Props) {
  const active = useLiveWildfireStore((s) => s.active);
  const showPerimeters = useLiveWildfireStore((s) => s.showPerimeters);
  const showHeat = useLiveWildfireStore((s) => s.showHeat);
  const showHeatShapes = useLiveWildfireStore((s) => s.showHeatShapes);
  const hideExposures = useLiveWildfireStore((s) => s.hideExposures);
  const heatDays = useLiveWildfireStore((s) => s.heatDays);
  const minSize = useLiveWildfireStore((s) => s.minSize);
  const selectedFires = useLiveWildfireStore((s) => s.selectedFires);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const wiredRef = useRef(false);
  const hidRef = useRef(false);

  // Perimeters (fast) and heat (slow) are fetched separately so the burn
  // polygons paint in ~2s instead of waiting on the FIRMS pull.
  const perimQuery = useQuery({
    queryKey: ["wildfire-perimeters"],
    queryFn: () => fetchLiveWildfire({ includeHeat: false, includePerimeters: true }),
    enabled: active,
    staleTime: 10 * 60_000,
    retry: 2,
  });
  const heatQuery = useQuery({
    queryKey: ["wildfire-heat", heatDays, minSize],
    queryFn: () =>
      fetchLiveWildfire({ includeHeat: true, includePerimeters: false, dayRange: heatDays, ...MIN_SIZE_PARAMS[minSize] }),
    enabled: active && (showHeat || showHeatShapes),
    staleTime: 5 * 60_000,
    refetchInterval: active && (showHeat || showHeatShapes) ? 5 * 60_000 : false,
  });

  useEffect(() => {
    if (!map) return;
    const setup = () => {
      if (map.getSource(SRC_PERIM)) return;
      map.addSource(SRC_PERIM, { type: "geojson", data: EMPTY_FC as never });
      map.addSource(SRC_SHAPES, { type: "geojson", data: EMPTY_FC as never });
      map.addSource(SRC_HEAT, { type: "geojson", data: EMPTY_FC as never });
      map.addSource(SRC_SELECTED, { type: "geojson", data: EMPTY_FC as never });

      map.addLayer({ id: L_SHAPE_FILL, type: "fill", source: SRC_SHAPES,
        paint: { "fill-color": "#b91c1c", "fill-opacity": 0.18 }, layout: { visibility: "none" } });
      map.addLayer({ id: L_SHAPE_LINE, type: "line", source: SRC_SHAPES,
        paint: { "line-color": "#b91c1c", "line-width": 1.1, "line-dasharray": [2, 1], "line-opacity": 0.85 }, layout: { visibility: "none" } });
      map.addLayer({ id: L_FILL, type: "fill", source: SRC_PERIM,
        paint: { "fill-color": "#f97316", "fill-opacity": 0.28 }, layout: { visibility: "none" } });
      map.addLayer({ id: L_LINE, type: "line", source: SRC_PERIM,
        paint: { "line-color": LINE_COLOR as never, "line-width": 1.6 }, layout: { visibility: "none" } });
      map.addLayer({ id: L_SELECTED, type: "line", source: SRC_SELECTED,
        paint: { "line-color": "#ffffff", "line-width": 3.4, "line-blur": 0.4 }, layout: { visibility: "none" } });
      map.addLayer({ id: L_HEAT, type: "circle", source: SRC_HEAT,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2, 6, 4, 9, 7],
          "circle-color": HEAT_COLOR as never, "circle-opacity": 0.85,
          "circle-stroke-width": 0.5, "circle-stroke-color": "#7f1d1d",
        }, layout: { visibility: "none" } });

      popupRef.current = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });

      const toggleFrom = (geom: GeoJSON.Geometry, id: string, name: string, source: "perimeter" | "heat") => {
        if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") return;
        useLiveWildfireStore.getState().toggleFire({ id, name, source, geometry: geom });
      };

      map.on("mousemove", L_FILL, (e) => {
        const f = e.features?.[0]; if (!f || !popupRef.current) return;
        map.getCanvas().style.cursor = "pointer";
        const p = f.properties as Record<string, unknown>;
        const c = p.percentContained == null ? "unknown" : `${p.percentContained}%`;
        popupRef.current.setLngLat(e.lngLat).setHTML(
          `<strong>${p.name ?? "Fire"}</strong><br/>${acres((p.gisAcres as number | null) ?? null)} · ${c} contained${p.state ? ` · ${p.state}` : ""}<br/><em>click to select</em>`,
        ).addTo(map);
      });
      map.on("mouseleave", L_FILL, () => { map.getCanvas().style.cursor = ""; popupRef.current?.remove(); });
      map.on("click", L_FILL, (e) => {
        const f = e.features?.[0]; const p = f?.properties as Record<string, unknown> | undefined;
        if (f && typeof p?.incidentId === "string") toggleFrom(f.geometry, p.incidentId, (p.name as string) ?? "Fire", "perimeter");
      });

      map.on("mousemove", L_SHAPE_FILL, (e) => {
        const f = e.features?.[0]; if (!f || !popupRef.current) return;
        map.getCanvas().style.cursor = "crosshair";
        const p = f.properties as Record<string, unknown>;
        const frp = p.maxFrpMw == null ? "—" : `${Math.round(p.maxFrpMw as number)} MW`;
        popupRef.current.setLngLat(e.lngLat).setHTML(
          `<strong>Heat cluster</strong><br/>${p.detectionCount ?? 0} detections · peak FRP ${frp}<br/><em>click to select</em>`,
        ).addTo(map);
      });
      map.on("mouseleave", L_SHAPE_FILL, () => { map.getCanvas().style.cursor = ""; popupRef.current?.remove(); });
      map.on("click", L_SHAPE_FILL, (e) => {
        const f = e.features?.[0]; if (!f) return;
        const id = `heat-${e.lngLat.lng.toFixed(3)},${e.lngLat.lat.toFixed(3)}`;
        toggleFrom(f.geometry, id, "Heat-derived cluster", "heat");
      });

      wiredRef.current = true;
    };
    if (map.isStyleLoaded()) setup();
    else map.once("style.load", setup);
  }, [map]);

  useEffect(() => {
    if (!map || !wiredRef.current) return;
    const apply = () => {
      const perimSrc = map.getSource(SRC_PERIM) as GeoJSONSource | undefined;
      const shapeSrc = map.getSource(SRC_SHAPES) as GeoJSONSource | undefined;
      const heatSrc = map.getSource(SRC_HEAT) as GeoJSONSource | undefined;
      const selSrc = map.getSource(SRC_SELECTED) as GeoJSONSource | undefined;
      if (!perimSrc || !shapeSrc || !heatSrc || !selSrc) return;
      const perim = active ? perimQuery.data : undefined;
      const heat = active ? heatQuery.data : undefined;

      perimSrc.setData((perim ? perim.perimeters : EMPTY_FC) as never);
      shapeSrc.setData((heat ? heat.heatShapes : EMPTY_FC) as never);
      heatSrc.setData((heat ? heatFC(heat) : EMPTY_FC) as never);
      selSrc.setData(selectedFC(active ? selectedFires : []) as never);

      const vis = (on: boolean, ready: boolean): "visible" | "none" => (active && on && ready ? "visible" : "none");
      const set = (id: string, v: "visible" | "none") => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v); };
      set(L_FILL, vis(showPerimeters, !!perim));
      set(L_LINE, vis(showPerimeters, !!perim));
      set(L_SHAPE_FILL, vis(showHeatShapes, !!heat));
      set(L_SHAPE_LINE, vis(showHeatShapes, !!heat));
      set(L_HEAT, vis(showHeat, !!heat));
      set(L_SELECTED, active && selectedFires.length > 0 ? "visible" : "none");

      // Optionally hide the TIV choropleth so sparse fire shapes read clearly.
      const shouldHide = active && hideExposures;
      for (const fill of EXPOSURE_FILLS) {
        if (!map.getLayer(fill)) continue;
        if (shouldHide) { map.setLayoutProperty(fill, "visibility", "none"); hidRef.current = true; }
        else if (hidRef.current) { map.setLayoutProperty(fill, "visibility", "visible"); }
      }
      if (!shouldHide) hidRef.current = false;

      // Keep wildfire layers above the choropleth fills, below map labels.
      const layers = map.getStyle()?.layers ?? [];
      const firstSymbol = layers.find((l) => l.type === "symbol")?.id;
      for (const id of [L_SHAPE_FILL, L_SHAPE_LINE, L_FILL, L_LINE, L_SELECTED, L_HEAT]) {
        if (map.getLayer(id)) map.moveLayer(id, firstSymbol);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, active, showPerimeters, showHeat, showHeatShapes, hideExposures, selectedFires, perimQuery.data, heatQuery.data]);

  return null;
}
