/**
 * Geostationary satellite and GOES-East lightning for the live-storm map.
 * Both stay off until the panel chips are turned on. Tiles are SSEC
 * RealEarth XYZ (max zoom 7). The bird follows the storm, or the map
 * center when no storm is selected.
 */

import { useEffect, useState } from "react";
import type { Map as MbMap, RasterTileSource } from "mapbox-gl";
import type { LiveStormBundle } from "../../api/live";
import { useLiveStormStore } from "../../state/liveStorm";
import {
  GLM_PRODUCT,
  LATEST_URL,
  formatStamp,
  glmCovers,
  satelliteFor,
  tileTemplate,
} from "./satelliteChoice";

const SAT_SRC = "live-satellite";
const SAT_LAYER = "live-satellite";
const GLM_SRC = "live-lightning";
const GLM_LAYER = "live-lightning";
/** First live-storm layer. Imagery is inserted under it when it exists. */
const UNDER = "live-wind-map-fill";

function anchorOf(data: LiveStormBundle | null): { lat: number; lon: number } | null {
  if (!data) return null;
  const fix = data.jma?.fixes?.find((f) => f.hoursOut === 0) ?? data.jma?.fixes?.[0];
  if (fix) return { lat: fix.lat, lon: fix.lon };
  const obs = data.observedTrack;
  if (obs && obs.length > 0) {
    const last = obs[obs.length - 1];
    return { lat: last.lat, lon: last.lon };
  }
  if (data.storm.lat != null && data.storm.lon != null) {
    return { lat: data.storm.lat, lon: data.storm.lon };
  }
  return null;
}

async function fetchStamp(product: string): Promise<string | null> {
  try {
    const res = await fetch(`${LATEST_URL}?products=${encodeURIComponent(product)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const stamp = body[product];
    return typeof stamp === "string" ? stamp : null;
  } catch {
    return null;
  }
}

function drop(map: MbMap, src: string, layer: string): void {
  if (map.getLayer(layer)) map.removeLayer(layer);
  if (map.getSource(src)) map.removeSource(src);
}

function upsert(
  map: MbMap,
  src: string,
  layer: string,
  tiles: string,
  beforeId: string,
): void {
  const existing = map.getSource(src);
  if (existing && existing.type === "raster") {
    (existing as RasterTileSource).setTiles([tiles]);
  } else {
    if (existing) {
      if (map.getLayer(layer)) map.removeLayer(layer);
      map.removeSource(src);
    }
    map.addSource(src, {
      type: "raster",
      tiles: [tiles],
      tileSize: 256,
      maxzoom: 7,
      attribution: "SSEC RealEarth",
    });
  }
  const before = map.getLayer(beforeId) ? beforeId : undefined;
  if (!map.getLayer(layer)) {
    map.addLayer(
      {
        id: layer,
        type: "raster",
        source: src,
        paint: { "raster-opacity": 1, "raster-fade-duration": 0 },
      },
      before,
    );
  } else if (before) {
    map.moveLayer(layer, before);
  }
}

export function LiveImageryLayer({ map }: { map: MbMap | null }) {
  const showSat = useLiveStormStore((s) => s.showSatellite);
  const showLight = useLiveStormStore((s) => s.showLightning);
  const data = useLiveStormStore((s) => s.data);
  const [stampSat, setStampSat] = useState<string | null>(null);
  const [stampGlm, setStampGlm] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    if (!showSat && !showLight) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 10 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [showSat, showLight]);

  useEffect(() => {
    if (!map) return;
    const read = () => {
      const c = map.getCenter();
      setView({ lat: c.lat, lon: c.lng });
    };
    read();
    if (data || (!showSat && !showLight)) return;
    map.on("moveend", read);
    return () => {
      map.off("moveend", read);
    };
  }, [map, data, showSat, showLight]);

  const storm = anchorOf(data);
  const lat = storm?.lat ?? view?.lat ?? 25;
  const lon = storm?.lon ?? view?.lon ?? -75;
  const sat = satelliteFor(lon);
  const covered = glmCovers(lat, lon);

  useEffect(() => {
    if (!showSat) {
      setStampSat(null);
      return;
    }
    let cancel = false;
    void fetchStamp(sat.product).then((s) => {
      if (!cancel) setStampSat(s);
    });
    return () => {
      cancel = true;
    };
  }, [showSat, sat.product, tick]);

  useEffect(() => {
    if (!showLight || !covered) {
      setStampGlm(null);
      return;
    }
    let cancel = false;
    void fetchStamp(GLM_PRODUCT).then((s) => {
      if (!cancel) setStampGlm(s);
    });
    return () => {
      cancel = true;
    };
  }, [showLight, covered, tick]);

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      if (showSat) {
        upsert(map, SAT_SRC, SAT_LAYER, tileTemplate(sat.product, stampSat), UNDER);
      } else {
        drop(map, SAT_SRC, SAT_LAYER);
      }
      if (showLight && covered) {
        upsert(map, GLM_SRC, GLM_LAYER, tileTemplate(GLM_PRODUCT, stampGlm), UNDER);
      } else {
        drop(map, GLM_SRC, GLM_LAYER);
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
    return () => {
      map.off("style.load", apply);
    };
  }, [map, showSat, showLight, covered, sat.product, stampSat, stampGlm]);

  useEffect(() => {
    if (!showSat && !showLight) {
      if (useLiveStormStore.getState().imageryStatus) {
        useLiveStormStore.getState().setImageryStatus(null);
      }
      return;
    }
    const satellite = showSat
      ? `${sat.label} · ${formatStamp(stampSat) ?? "latest"}. ${sat.note}`
      : null;
    const lightning = !showLight
      ? null
      : covered
        ? `GOES-East GLM · ${formatStamp(stampGlm) ?? "latest"}. Optical flashes, not confirmed ground strikes.`
        : "GOES-East GLM does not cover this location. No lightning is drawn.";
    const cur = useLiveStormStore.getState().imageryStatus;
    if (cur?.satellite === satellite && cur?.lightning === lightning) return;
    useLiveStormStore.getState().setImageryStatus({ satellite, lightning });
  }, [showSat, showLight, sat.label, sat.note, stampSat, stampGlm, covered]);

  useEffect(() => {
    return () => {
      useLiveStormStore.getState().setImageryStatus(null);
      if (!map) return;
      drop(map, SAT_SRC, SAT_LAYER);
      drop(map, GLM_SRC, GLM_LAYER);
    };
  }, [map]);

  return null;
}
