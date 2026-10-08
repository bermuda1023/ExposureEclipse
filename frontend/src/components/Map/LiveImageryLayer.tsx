/**
 * Geostationary satellite and GOES-East lightning for the live-storm map.
 * Both stay off until the panel chips are turned on.
 *
 * GOES and Himawari tiles are NASA GIBS. Meteosat and GLM stay on SSEC
 * RealEarth, and a tile that is the "Size limit exceeded" notice is
 * returned empty so the text is never drawn. The bird follows the storm,
 * or the map center when no storm is selected.
 */

import { useEffect, useState } from "react";
import mapboxgl, { type Map as MbMap } from "mapbox-gl";
import type { LiveStormBundle } from "../../api/live";
import { useLiveStormStore } from "../../state/liveStorm";
import {
  GLM_PRODUCT,
  LATEST_URL,
  formatGibsTime,
  formatStamp,
  gibsProbeUrl,
  glmCovers,
  realEarthProviderModule,
  satelliteFor,
  tileTemplate,
  type SatChoice,
} from "./satelliteChoice";

const SAT_SRC = "live-satellite";
const SAT_LAYER = "live-satellite";
const GLM_SRC = "live-lightning";
const GLM_LAYER = "live-lightning";
/** First live-storm layer. Imagery is inserted under it when it exists. */
const UNDER = "live-wind-map-fill";
const REAL_EARTH_PROVIDER = "realearth";

const placed = new Map<string, string>();
let providerReady = false;

function ensureRealEarthProvider(): void {
  if (providerReady) return;
  const url = URL.createObjectURL(
    new Blob([realEarthProviderModule()], { type: "text/javascript" }),
  );
  mapboxgl.addTileProvider(REAL_EARTH_PROVIDER, url);
  providerReady = true;
}

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

async function fetchGibsTime(tiles: string): Promise<string | null> {
  try {
    const res = await fetch(gibsProbeUrl(tiles), { method: "HEAD" });
    if (!res.ok) return null;
    return res.headers.get("layer-time-actual");
  } catch {
    return null;
  }
}

function drop(map: MbMap, src: string, layer: string): void {
  placed.delete(src);
  if (map.getLayer(layer)) map.removeLayer(layer);
  if (map.getSource(src)) map.removeSource(src);
}

interface RasterSpec {
  tiles: string;
  maxzoom: number;
  attribution: string;
  /** RealEarth only. GIBS GeoColor has dark limbs that are not the notice. */
  filterNotices: boolean;
}

function specKey(spec: RasterSpec): string {
  return `${spec.tiles}|${spec.maxzoom}|${spec.attribution}|${spec.filterNotices ? 1 : 0}`;
}

function upsert(map: MbMap, src: string, layer: string, spec: RasterSpec): void {
  const key = specKey(spec);
  const existing = map.getSource(src);
  if (!existing || existing.type !== "raster" || placed.get(src) !== key) {
    drop(map, src, layer);
    if (spec.filterNotices) ensureRealEarthProvider();
    map.addSource(src, {
      type: "raster",
      tiles: [spec.tiles],
      tileSize: 256,
      maxzoom: spec.maxzoom,
      attribution: spec.attribution,
      ...(spec.filterNotices ? { provider: REAL_EARTH_PROVIDER } : {}),
    });
    placed.set(src, key);
  }
  if (!map.getLayer(layer)) {
    map.addLayer({
      id: layer,
      type: "raster",
      source: src,
      paint: { "raster-opacity": 1, "raster-fade-duration": 0 },
    });
  }
}

/** Satellite under lightning, both under the first live-storm layer. */
function orderImagery(map: MbMap): void {
  const under = map.getLayer(UNDER) ? UNDER : undefined;
  if (map.getLayer(GLM_LAYER) && under) map.moveLayer(GLM_LAYER, under);
  if (map.getLayer(SAT_LAYER)) {
    const before = map.getLayer(GLM_LAYER) ? GLM_LAYER : under;
    if (before) map.moveLayer(SAT_LAYER, before);
  }
}

function satelliteTiles(sat: SatChoice, stamp: string | null, tick: number): string {
  if (sat.host === "gibs" && sat.tiles) {
    const join = sat.tiles.includes("?") ? "&" : "?";
    return `${sat.tiles}${join}r=${tick}`;
  }
  return tileTemplate(sat.product ?? "", stamp);
}

export function LiveImageryLayer({ map }: { map: MbMap | null }) {
  const showSat = useLiveStormStore((s) => s.showSatellite);
  const showLight = useLiveStormStore((s) => s.showLightning);
  const data = useLiveStormStore((s) => s.data);
  const [stampSat, setStampSat] = useState<string | null>(null);
  const [stampGlm, setStampGlm] = useState<string | null>(null);
  const [gibsTime, setGibsTime] = useState<string | null>(null);
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
    if (!showSat || sat.host !== "realearth" || !sat.product) {
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
  }, [showSat, sat.host, sat.product, tick]);

  useEffect(() => {
    if (!showSat || sat.host !== "gibs" || !sat.tiles) {
      setGibsTime(null);
      return;
    }
    let cancel = false;
    void fetchGibsTime(sat.tiles).then((s) => {
      if (!cancel) setGibsTime(s);
    });
    return () => {
      cancel = true;
    };
  }, [showSat, sat.host, sat.tiles, tick]);

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
        upsert(map, SAT_SRC, SAT_LAYER, {
          tiles: satelliteTiles(sat, stampSat, tick),
          maxzoom: sat.maxzoom,
          attribution: sat.attribution,
          filterNotices: sat.host === "realearth",
        });
      } else {
        drop(map, SAT_SRC, SAT_LAYER);
      }
      if (showLight && covered) {
        upsert(map, GLM_SRC, GLM_LAYER, {
          tiles: tileTemplate(GLM_PRODUCT, stampGlm),
          maxzoom: 7,
          attribution: "SSEC RealEarth",
          filterNotices: true,
        });
      } else {
        drop(map, GLM_SRC, GLM_LAYER);
      }
      orderImagery(map);
    };
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
    return () => {
      map.off("style.load", apply);
    };
  }, [
    map,
    showSat,
    showLight,
    covered,
    sat.host,
    sat.tiles,
    sat.product,
    sat.maxzoom,
    sat.attribution,
    stampSat,
    stampGlm,
    tick,
  ]);

  useEffect(() => {
    if (!showSat && !showLight) {
      if (useLiveStormStore.getState().imageryStatus) {
        useLiveStormStore.getState().setImageryStatus(null);
      }
      return;
    }
    const when = sat.host === "gibs"
      ? (formatGibsTime(gibsTime) ?? "latest")
      : (formatStamp(stampSat) ?? "latest");
    const satellite = showSat ? `${sat.label} · ${when}. ${sat.note}` : null;
    const lightning = !showLight
      ? null
      : covered
        ? `GOES-East GLM · ${formatStamp(stampGlm) ?? "latest"}. Optical flashes, not confirmed ground strikes.`
        : "GOES-East GLM does not cover this location. No lightning is drawn.";
    const cur = useLiveStormStore.getState().imageryStatus;
    if (cur?.satellite === satellite && cur?.lightning === lightning) return;
    useLiveStormStore.getState().setImageryStatus({ satellite, lightning });
  }, [showSat, showLight, sat.host, sat.label, sat.note, stampSat, stampGlm, gibsTime, covered]);

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
