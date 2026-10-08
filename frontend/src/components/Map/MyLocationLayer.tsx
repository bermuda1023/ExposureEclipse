/**
 * Dot for the tucked-away location card. Hidden until that section is open.
 * Does not move the map unless the user asks.
 */

import { useEffect, useRef } from "react";
import type { GeoJSONSource, Map as MbMap } from "mapbox-gl";
import { useLiveStormStore } from "../../state/liveStorm";

const SRC = "my-location";
const DOT = "my-location-dot";
const LABEL = "my-location-label";

export function MyLocationLayer({ map }: { map: MbMap | null }) {
  const show = useLiveStormStore((s) => s.showMyLocation);
  const place = useLiveStormStore((s) => s.myPlace);
  const focus = useLiveStormStore((s) => s.myLocationFocus);
  const stormId = useLiveStormStore((s) => s.data?.storm.stormId ?? null);
  const showSat = useLiveStormStore((s) => s.showSatellite);
  const showLight = useLiveStormStore((s) => s.showLightning);
  const showRadar = useLiveStormStore((s) => s.showRadar);
  const flown = useRef(0);

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      const fc = {
        type: "FeatureCollection" as const,
        features: show && place
          ? [{
              type: "Feature" as const,
              properties: { label: place.label },
              geometry: {
                type: "Point" as const,
                coordinates: [place.lon, place.lat],
              },
            }]
          : [],
      };
      const existing = map.getSource(SRC);
      if (!existing) {
        map.addSource(SRC, { type: "geojson", data: fc });
      } else {
        (existing as GeoJSONSource).setData(fc);
      }
      if (!map.getLayer(DOT)) {
        map.addLayer({
          id: DOT,
          type: "circle",
          source: SRC,
          paint: {
            "circle-radius": 6,
            "circle-color": "#7c3aed",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
      }
      if (!map.getLayer(LABEL)) {
        map.addLayer({
          id: LABEL,
          type: "symbol",
          source: SRC,
          layout: {
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-offset": [0, 1.05],
            "text-anchor": "top",
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          },
          paint: {
            "text-color": "#4c1d95",
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.4,
          },
        });
      }
      if (show && place) {
        if (map.getLayer(DOT)) map.moveLayer(DOT);
        if (map.getLayer(LABEL)) map.moveLayer(LABEL);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
    return () => {
      map.off("style.load", apply);
    };
  }, [map, show, place, stormId, showSat, showLight, showRadar]);

  useEffect(() => {
    if (!map || !show || !place || focus === 0 || focus === flown.current) return;
    flown.current = focus;
    map.flyTo({
      center: [place.lon, place.lat],
      zoom: Math.max(map.getZoom(), 5.5),
    });
  }, [map, focus, show, place]);

  return null;
}
