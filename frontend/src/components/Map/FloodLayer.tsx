/**
 * Live flood overlay layer — active NWS flood alert polygons over the TIV
 * choropleth (or on their own when exposures are hidden). Fill colour ramps on
 * `severityRank`, the numeric twin of the CAP severity string.
 *
 * Click a polygon to multi-select and combine alerts (see FloodPanel).
 * Selected alerts get a white highlight outline.
 */

import mapboxgl, { type GeoJSONSource, type Map as MbMap } from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchLiveFlood, type FloodAlertProps } from "../../api/flood";
import { useLiveFloodStore } from "../../state/liveFlood";

const SRC_ALERTS = "flood-alerts";
const L_FILL = "flood-alert-fill";
const L_LINE = "flood-alert-line";
const SRC_SELECTED = "flood-selected";
const L_SELECTED = "flood-selected-line";

interface Props { map: MbMap | null; }

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

/** Ramps on the numeric twin so Mapbox can interpolate — see api/flood.ts. */
const SEVERITY_COLOR = [
  "interpolate", ["linear"], ["coalesce", ["get", "severityRank"], 0],
  0, "#94a3b8", 1, "#38bdf8", 2, "#0284c7", 3, "#1d4ed8", 4, "#4c1d95",
];

function selectedFC(ids: { id: string; geometry: GeoJSON.Geometry }[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: ids.map((a) => ({ type: "Feature", geometry: a.geometry, properties: { id: a.id } })),
  };
}

export function FloodLayer({ map }: Props) {
  const active = useLiveFloodStore((s) => s.active);
  const showAlerts = useLiveFloodStore((s) => s.showAlerts);
  const minSeverity = useLiveFloodStore((s) => s.minSeverity);
  const selectedAlerts = useLiveFloodStore((s) => s.selectedAlerts);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  // Source geometry by alertId. `e.features[].geometry` is rebuilt from the
  // vector tile under the cursor, so it is clipped to that tile and simplified
  // — selecting a wide alert from the map would post a fragment and understate
  // exposed TIV, and disagree with selecting the same alert from the list.
  const geomRef = useRef<Map<string, GeoJSON.Polygon | GeoJSON.MultiPolygon>>(new Map());
  // Must be state, not a ref: setup() can run from a deferred `style.load`, and
  // a ref mutation schedules no re-render, so the paint effect below would
  // never re-run and the overlay would stay empty.
  const [wired, setWired] = useState(false);

  const alertQuery = useQuery({
    queryKey: ["flood-alerts", minSeverity],
    queryFn: () => fetchLiveFlood({ minSeverity }),
    enabled: active,
    staleTime: 60_000,
    refetchInterval: active ? 5 * 60_000 : false,
    retry: 2,
  });

  useEffect(() => {
    if (!map) return;
    const setup = () => {
      // Before the early return: a re-run against an already-wired map must
      // still flip `wired`, or the paint effect never runs again.
      setWired(true);
      if (map.getSource(SRC_ALERTS)) return;
      map.addSource(SRC_ALERTS, { type: "geojson", data: EMPTY_FC as never });
      map.addSource(SRC_SELECTED, { type: "geojson", data: EMPTY_FC as never });

      map.addLayer({ id: L_FILL, type: "fill", source: SRC_ALERTS,
        paint: { "fill-color": SEVERITY_COLOR as never, "fill-opacity": 0.3 }, layout: { visibility: "none" } });
      map.addLayer({ id: L_LINE, type: "line", source: SRC_ALERTS,
        paint: { "line-color": SEVERITY_COLOR as never, "line-width": 1.4 }, layout: { visibility: "none" } });
      map.addLayer({ id: L_SELECTED, type: "line", source: SRC_SELECTED,
        paint: { "line-color": "#ffffff", "line-width": 3.4, "line-blur": 0.4 }, layout: { visibility: "none" } });

      popupRef.current = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });

      map.on("mousemove", L_FILL, (e) => {
        const f = e.features?.[0]; if (!f || !popupRef.current) return;
        map.getCanvas().style.cursor = "pointer";
        const p = f.properties as unknown as FloodAlertProps;
        // setText, not setHTML: event/severity/areaDesc are third-party free
        // text straight off the NWS feed.
        popupRef.current.setLngLat(e.lngLat)
          .setText(`${p.event} — ${p.severity}${p.areaDesc ? ` · ${p.areaDesc}` : ""} (click to select)`)
          .addTo(map);
      });
      map.on("mouseleave", L_FILL, () => { map.getCanvas().style.cursor = ""; popupRef.current?.remove(); });
      map.on("click", L_FILL, (e) => {
        const f = e.features?.[0]; if (!f) return;
        const p = f.properties as unknown as FloodAlertProps | undefined;
        if (!p || typeof p.alertId !== "string") return;
        const geom = geomRef.current.get(p.alertId);
        if (!geom) return;
        useLiveFloodStore.getState().toggleAlert({
          id: p.alertId, name: p.event, severity: p.severity, geometry: geom,
        });
      });
    };
    if (map.isStyleLoaded()) setup();
    else map.once("style.load", setup);
    return () => {
      map.off("style.load", setup);
      popupRef.current?.remove();
      popupRef.current = null;
      setWired(false);
    };
  }, [map]);

  // Z-order once, not on every data/selection change: map.getStyle() serialises
  // the entire style spec on each call and moveLayer forces a repaint.
  useEffect(() => {
    if (!map || !wired) return;
    const firstSymbol = (map.getStyle()?.layers ?? []).find((l) => l.type === "symbol")?.id;
    for (const id of [L_FILL, L_LINE, L_SELECTED]) {
      if (map.getLayer(id)) map.moveLayer(id, firstSymbol);
    }
  }, [map, wired]);

  // Alert data. Kept apart from the selection effect below so clicking a
  // polygon doesn't re-tile the whole FeatureCollection.
  useEffect(() => {
    if (!map || !wired) return;
    const data = active ? alertQuery.data : undefined;

    geomRef.current = new Map(
      (data?.alerts.features ?? [])
        .filter((f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
        .map((f) => [f.properties.alertId, f.geometry]),
    );
    // Only once real data has arrived — pruning against an empty in-flight
    // response would clear the selection on every refetch.
    if (data) useLiveFloodStore.getState().retainAlerts(new Set(geomRef.current.keys()));

    const apply = () => {
      const src = map.getSource(SRC_ALERTS) as GeoJSONSource | undefined;
      if (!src) return;
      src.setData((data ? data.alerts : EMPTY_FC) as never);
      const vis: "visible" | "none" = active && showAlerts && !!data ? "visible" : "none";
      for (const id of [L_FILL, L_LINE]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
    return () => { map.off("style.load", apply); };
    // `hideExposures` is deliberately absent: MapView owns the exposure-fill
    // visibility so the hazard, wildfire and flood overlays can't fight over it.
  }, [map, wired, active, showAlerts, alertQuery.data]);

  useEffect(() => {
    if (!map || !wired) return;
    const apply = () => {
      const selSrc = map.getSource(SRC_SELECTED) as GeoJSONSource | undefined;
      if (!selSrc) return;
      selSrc.setData(selectedFC(active ? selectedAlerts : []) as never);
      if (map.getLayer(L_SELECTED)) {
        map.setLayoutProperty(L_SELECTED, "visibility",
          active && selectedAlerts.length > 0 ? "visible" : "none");
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
    return () => { map.off("style.load", apply); };
  }, [map, wired, active, selectedAlerts]);

  return null;
}
