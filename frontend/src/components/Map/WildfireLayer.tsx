/**
 * Live wildfire overlay layer — three independent, toggleable layers on top
 * of the TIV choropleth (the point being "which exposure is inside a fire"):
 *
 *   1. Perimeters   — official NIFC/WFIGS burn polygons; outline encodes
 *                     containment (red 0% → green 100%).
 *   2. Heat shapes  — our own footprints, clustered from FIRMS detections
 *                     over `heatDays`; crimson dashed hulls under the official
 *                     perimeters.
 *   3. Heat points  — raw FIRMS satellite detections (FRP-coloured), on top.
 *
 * Hover a perimeter or heat shape for a popup; click a perimeter to select.
 */

import mapboxgl, { type GeoJSONSource, type Map as MbMap } from "mapbox-gl";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchLiveWildfire, type WildfireResponse } from "../../api/wildfire";
import { useLiveWildfireStore } from "../../state/liveWildfire";

const SRC_PERIM = "wildfire-perimeters";
const L_FILL = "wildfire-perimeter-fill";
const L_LINE = "wildfire-perimeter-line";
const L_SEL = "wildfire-perimeter-selected";
const SRC_SHAPES = "wildfire-heat-shapes";
const L_SHAPE_FILL = "wildfire-heat-shape-fill";
const L_SHAPE_LINE = "wildfire-heat-shape-line";
const SRC_HEAT = "wildfire-heat";
const L_HEAT = "wildfire-heat-point";

interface Props {
  map: MbMap | null;
}

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
      properties: { frp: a.frpMw, brightness: a.brightnessK, source: a.source },
    })),
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
  const heatDays = useLiveWildfireStore((s) => s.heatDays);
  const selectedId = useLiveWildfireStore((s) => s.selectedIncidentId);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const wiredRef = useRef(false);

  const query = useQuery({
    queryKey: ["wildfire-live", heatDays],
    queryFn: () => fetchLiveWildfire({ includeHeat: true, dayRange: heatDays }),
    enabled: active,
    staleTime: 5 * 60_000,
    refetchInterval: active ? 5 * 60_000 : false,
  });

  // One-time: sources + layers + hover/click handlers.
  useEffect(() => {
    if (!map) return;
    const setup = () => {
      if (map.getSource(SRC_PERIM)) return;
      map.addSource(SRC_PERIM, { type: "geojson", data: EMPTY_FC as never, promoteId: "incidentId" });
      map.addSource(SRC_SHAPES, { type: "geojson", data: EMPTY_FC as never });
      map.addSource(SRC_HEAT, { type: "geojson", data: EMPTY_FC as never });

      // Heat shapes first → they render UNDER the official perimeters.
      map.addLayer({
        id: L_SHAPE_FILL, type: "fill", source: SRC_SHAPES,
        paint: { "fill-color": "#b91c1c", "fill-opacity": 0.16 },
        layout: { visibility: "none" },
      });
      map.addLayer({
        id: L_SHAPE_LINE, type: "line", source: SRC_SHAPES,
        paint: { "line-color": "#b91c1c", "line-width": 1.1, "line-dasharray": [2, 1], "line-opacity": 0.8 },
        layout: { visibility: "none" },
      });
      map.addLayer({
        id: L_FILL, type: "fill", source: SRC_PERIM,
        paint: { "fill-color": "#f97316", "fill-opacity": 0.28 },
        layout: { visibility: "none" },
      });
      map.addLayer({
        id: L_LINE, type: "line", source: SRC_PERIM,
        paint: { "line-color": LINE_COLOR as never, "line-width": 1.6 },
        layout: { visibility: "none" },
      });
      map.addLayer({
        id: L_SEL, type: "line", source: SRC_PERIM,
        filter: ["==", ["get", "incidentId"], "___none___"],
        paint: { "line-color": "#ffffff", "line-width": 3.2, "line-blur": 0.5 },
        layout: { visibility: "none" },
      });
      map.addLayer({
        id: L_HEAT, type: "circle", source: SRC_HEAT,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2, 6, 4, 9, 7],
          "circle-color": HEAT_COLOR as never,
          "circle-opacity": 0.85,
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "#7f1d1d",
        },
        layout: { visibility: "none" },
      });

      popupRef.current = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });

      map.on("mousemove", L_FILL, (e) => {
        const f = e.features?.[0];
        if (!f || !popupRef.current) return;
        map.getCanvas().style.cursor = "pointer";
        const p = f.properties as Record<string, unknown>;
        const contained = p.percentContained == null ? "unknown" : `${p.percentContained}%`;
        popupRef.current.setLngLat(e.lngLat).setHTML(
          `<strong>${p.name ?? "Fire"}</strong><br/>${acres((p.gisAcres as number | null) ?? null)} · ${contained} contained${p.state ? ` · ${p.state}` : ""}`,
        ).addTo(map);
      });
      map.on("mouseleave", L_FILL, () => { map.getCanvas().style.cursor = ""; popupRef.current?.remove(); });
      map.on("click", L_FILL, (e) => {
        const id = (e.features?.[0]?.properties as Record<string, unknown> | undefined)?.incidentId;
        if (typeof id === "string") useLiveWildfireStore.getState().selectIncident(id);
      });

      map.on("mousemove", L_SHAPE_FILL, (e) => {
        const f = e.features?.[0];
        if (!f || !popupRef.current) return;
        map.getCanvas().style.cursor = "crosshair";
        const p = f.properties as Record<string, unknown>;
        const frp = p.maxFrpMw == null ? "—" : `${Math.round(p.maxFrpMw as number)} MW`;
        popupRef.current.setLngLat(e.lngLat).setHTML(
          `<strong>Heat cluster</strong><br/>${p.detectionCount ?? 0} detections · peak FRP ${frp}`,
        ).addTo(map);
      });
      map.on("mouseleave", L_SHAPE_FILL, () => { map.getCanvas().style.cursor = ""; popupRef.current?.remove(); });

      wiredRef.current = true;
    };
    if (map.isStyleLoaded()) setup();
    else map.once("style.load", setup);
  }, [map]);

  // React to data / toggles.
  useEffect(() => {
    if (!map || !wiredRef.current) return;
    const apply = () => {
      const perimSrc = map.getSource(SRC_PERIM) as GeoJSONSource | undefined;
      const shapeSrc = map.getSource(SRC_SHAPES) as GeoJSONSource | undefined;
      const heatSrc = map.getSource(SRC_HEAT) as GeoJSONSource | undefined;
      if (!perimSrc || !shapeSrc || !heatSrc) return;
      const d = active ? query.data : undefined;

      perimSrc.setData((d ? d.perimeters : EMPTY_FC) as never);
      shapeSrc.setData((d ? d.heatShapes : EMPTY_FC) as never);
      heatSrc.setData((d ? heatFC(d) : EMPTY_FC) as never);

      const vis = (on: boolean): "visible" | "none" => (active && on && d ? "visible" : "none");
      const set = (id: string, v: "visible" | "none") => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v); };
      set(L_FILL, vis(showPerimeters));
      set(L_LINE, vis(showPerimeters));
      set(L_SHAPE_FILL, vis(showHeatShapes));
      set(L_SHAPE_LINE, vis(showHeatShapes));
      set(L_HEAT, vis(showHeat));
      set(L_SEL, active && showPerimeters && selectedId ? "visible" : "none");
      if (map.getLayer(L_SEL)) {
        map.setFilter(L_SEL, ["==", ["get", "incidentId"], selectedId ?? "___none___"]);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, active, showPerimeters, showHeat, showHeatShapes, selectedId, query.data]);

  return null;
}
