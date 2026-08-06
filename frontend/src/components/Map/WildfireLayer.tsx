/**
 * Live wildfire overlay layer — real NIFC/WFIGS burn-area perimeters plus
 * NASA FIRMS satellite active-fire points. Sits on TOP of the TIV choropleth
 * (perimeters are sparse polygons, not a wash), so exposure stays visible
 * underneath — the whole point is "which of my exposure is inside a fire".
 *
 * Outline colour encodes containment (red 0% → amber → green 100%); the
 * translucent fill marks the burn footprint; FIRMS points show fresh heat.
 * Hover a perimeter for an incident popup; click to select (highlights it
 * and drives the WildfirePanel).
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
const SRC_HEAT = "wildfire-heat";
const L_HEAT = "wildfire-heat-point";

interface Props {
  map: MbMap | null;
}

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

// Outline colour by % contained (null = uncontained → red).
const LINE_COLOR = [
  "interpolate",
  ["linear"],
  ["coalesce", ["get", "percentContained"], 0],
  0, "#dc2626",
  50, "#f59e0b",
  100, "#16a34a",
];

// Heat point colour by fire radiative power (MW).
const HEAT_COLOR = [
  "interpolate",
  ["linear"],
  ["coalesce", ["get", "frp"], 0],
  0, "#fde047",
  40, "#f97316",
  150, "#dc2626",
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
  if (n == null) return "—";
  return `${Math.round(n).toLocaleString()} ac`;
}

export function WildfireLayer({ map }: Props) {
  const active = useLiveWildfireStore((s) => s.active);
  const showHeat = useLiveWildfireStore((s) => s.showHeat);
  const selectedId = useLiveWildfireStore((s) => s.selectedIncidentId);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const wiredRef = useRef(false);

  const query = useQuery({
    queryKey: ["wildfire-live"],
    queryFn: () => fetchLiveWildfire({ includeHeat: true }),
    enabled: active,
    staleTime: 5 * 60_000,
    refetchInterval: active ? 5 * 60_000 : false,
  });

  // One-time: create sources + layers + hover/click handlers.
  useEffect(() => {
    if (!map) return;
    const setup = () => {
      if (map.getSource(SRC_PERIM)) return;
      map.addSource(SRC_PERIM, { type: "geojson", data: EMPTY_FC as never, promoteId: "incidentId" });
      map.addSource(SRC_HEAT, { type: "geojson", data: EMPTY_FC as never });

      map.addLayer({
        id: L_FILL,
        type: "fill",
        source: SRC_PERIM,
        paint: { "fill-color": "#f97316", "fill-opacity": 0.28 },
        layout: { visibility: "none" },
      });
      map.addLayer({
        id: L_LINE,
        type: "line",
        source: SRC_PERIM,
        paint: { "line-color": LINE_COLOR as never, "line-width": 1.6 },
        layout: { visibility: "none" },
      });
      map.addLayer({
        id: L_SEL,
        type: "line",
        source: SRC_PERIM,
        filter: ["==", ["get", "incidentId"], "___none___"],
        paint: { "line-color": "#ffffff", "line-width": 3.2, "line-blur": 0.5 },
        layout: { visibility: "none" },
      });
      map.addLayer({
        id: L_HEAT,
        type: "circle",
        source: SRC_HEAT,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2, 6, 4, 9, 7],
          "circle-color": HEAT_COLOR as never,
          "circle-opacity": 0.85,
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "#7f1d1d",
        },
        layout: { visibility: "none" },
      });

      popupRef.current = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 8,
        className: "wildfire-popup",
      });

      map.on("mousemove", L_FILL, (e) => {
        const f = e.features?.[0];
        if (!f || !popupRef.current) return;
        map.getCanvas().style.cursor = "pointer";
        const p = f.properties as Record<string, unknown>;
        const contained = p.percentContained == null ? "unknown" : `${p.percentContained}%`;
        popupRef.current
          .setLngLat(e.lngLat)
          .setHTML(
            `<strong>${p.name ?? "Fire"}</strong><br/>` +
            `${acres((p.gisAcres as number | null) ?? null)} · ${contained} contained` +
            `${p.state ? ` · ${p.state}` : ""}`,
          )
          .addTo(map);
      });
      map.on("mouseleave", L_FILL, () => {
        map.getCanvas().style.cursor = "";
        popupRef.current?.remove();
      });
      map.on("click", L_FILL, (e) => {
        const f = e.features?.[0];
        const id = (f?.properties as Record<string, unknown> | undefined)?.incidentId;
        if (typeof id === "string") useLiveWildfireStore.getState().selectIncident(id);
      });
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
      const heatSrc = map.getSource(SRC_HEAT) as GeoJSONSource | undefined;
      if (!perimSrc || !heatSrc) return;

      perimSrc.setData((active && query.data ? query.data.perimeters : EMPTY_FC) as never);
      heatSrc.setData((active && query.data ? heatFC(query.data) : EMPTY_FC) as never);

      const vis = active && query.data ? "visible" : "none";
      for (const id of [L_FILL, L_LINE]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
      }
      if (map.getLayer(L_HEAT)) {
        map.setLayoutProperty(L_HEAT, "visibility", active && showHeat && query.data ? "visible" : "none");
      }
      if (map.getLayer(L_SEL)) {
        map.setLayoutProperty(L_SEL, "visibility", active && selectedId ? "visible" : "none");
        map.setFilter(L_SEL, ["==", ["get", "incidentId"], selectedId ?? "___none___"]);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, active, showHeat, selectedId, query.data]);

  return null;
}
