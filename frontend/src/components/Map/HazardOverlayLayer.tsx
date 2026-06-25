/**
 * Hazard choropleth overlay — tornado / hail / wildfire scores painted
 * onto the county tileset via Mapbox feature-state.
 *
 * The layer ID `county-hazard-fill` is added once in MapView (so layer
 * order with cones / SST / etc. is predictable). This component just
 * keeps the feature-state in sync with whatever hazard is active.
 *
 * Visibility flips via setLayoutProperty so the layer is fully removed
 * from rendering when no hazard is selected — no transparent overdraw
 * over the exposure choropleth.
 */

import type { Map as MbMap } from "mapbox-gl";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHazard } from "../../api/hazards";
import { useHazardOverlayStore } from "../../state/hazardOverlay";

const COUNTY_TILESET_SRC = "boundaries-counties";
const COUNTY_TILESET_LAYER = "b2e6c22804c918d996b3";
const LAYER_HAZARD = "county-hazard-fill";

interface Props {
  map: MbMap | null;
}

/** Pick a colour for one raw score by stepping through the palette+stops
 * that the backend ships in the legend. Last colour applies above the
 * top stop. */
function colourFor(raw: number, palette: string[], stops: number[]): string {
  let idx = 0;
  for (let i = 0; i < stops.length; i++) {
    if (raw >= stops[i]!) idx = i;
  }
  // palette length should be == stops length; defensive .min
  return palette[Math.min(idx, palette.length - 1)]!;
}

export function HazardOverlayLayer({ map }: Props) {
  const active = useHazardOverlayStore((s) => s.active);
  const setIdsRef = useRef<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ["hazard", active],
    queryFn: () => fetchHazard(active!),
    enabled: active !== null,
    staleTime: 30 * 60_000,
  });

  // Sync feature-state whenever the hazard data arrives OR the layer becomes
  // available (style.load might fire after this hook).
  useEffect(() => {
    if (!map) return;
    const apply = () => {
      // Clear previous hazard paint.
      for (const id of setIdsRef.current) {
        map.removeFeatureState(
          { source: COUNTY_TILESET_SRC, sourceLayer: COUNTY_TILESET_LAYER, id },
          "hazardColor",
        );
      }
      setIdsRef.current.clear();

      if (!active || !query.data) {
        if (map.getLayer(LAYER_HAZARD)) {
          map.setLayoutProperty(LAYER_HAZARD, "visibility", "none");
        }
        return;
      }
      const { palette, stops } = query.data.legend;
      for (const s of query.data.scores) {
        if (s.raw <= 0) continue;
        const colour = colourFor(s.raw, palette, stops);
        map.setFeatureState(
          { source: COUNTY_TILESET_SRC, sourceLayer: COUNTY_TILESET_LAYER, id: s.geoid },
          { hazardColor: colour },
        );
        setIdsRef.current.add(s.geoid);
      }
      if (map.getLayer(LAYER_HAZARD)) {
        map.setLayoutProperty(LAYER_HAZARD, "visibility", "visible");
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [map, active, query.data]);

  return null;
}
