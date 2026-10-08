/**
 * Geostationary satellite, NEXRAD composite, and GOES-East lightning.
 * All three stay off until the panel chips are turned on.
 *
 * GOES and Himawari tiles are NASA GIBS. Meteosat and GLM stay on SSEC
 * RealEarth, and a tile that is the "Size limit exceeded" notice is
 * returned empty so the text is never drawn. The bird follows the storm,
 * or the map center when no storm is selected.
 *
 * The hour loop cannot be a video. Those birds photograph about every
 * 10 minutes (Meteosat about hourly). The next scan is drawn while the
 * current one stays fully opaque, then it fades in. Playback runs
 * forward and cuts back to the oldest scan.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl, { type Map as MbMap, type RasterTileSource } from "mapbox-gl";
import type { LiveStormBundle } from "../../api/live";
import { useLiveStormStore } from "../../state/liveStorm";
import {
  GLM_PRODUCT,
  LATEST_URL,
  buildImageryLoop,
  collapseRepeatFrames,
  dissolveOpacity,
  formatGibsTime,
  formatStamp,
  gibsProbeUrl,
  gibsTilesAt,
  glmCovers,
  imageryFrameKey,
  loopFrameMs,
  loopHasMotion,
  loopRestarts,
  productTimes,
  realEarthProviderModule,
  satelliteFor,
  tileTemplate,
  type ImageryLoopFrame,
  type SatChoice,
} from "./satelliteChoice";
import { radarAgeBetween, radarCovers, radarLoopAges, radarTileUrl } from "./radarChoice";

const SAT_SRC = "live-satellite";
const SAT_LAYER = "live-satellite";
const GLM_SRC = "live-lightning";
const GLM_LAYER = "live-lightning";
const RADAR_SRC = "live-radar";
const RADAR_LAYER = "live-radar";
/** Two buffers so the visible scan stays up while the next one loads. */
const SAT_LOOP = [
  { src: "live-satellite-a", layer: "live-satellite-a" },
  { src: "live-satellite-b", layer: "live-satellite-b" },
] as const;
const RADAR_LOOP = [
  { src: "live-radar-a", layer: "live-radar-a" },
  { src: "live-radar-b", layer: "live-radar-b" },
] as const;
const GLM_LOOP = [
  { src: "live-lightning-a", layer: "live-lightning-a" },
  { src: "live-lightning-b", layer: "live-lightning-b" },
] as const;
/** First live-storm layer. Imagery is inserted under it when it exists. */
const UNDER = "live-wind-map-fill";
const REAL_EARTH_PROVIDER = "realearth";
const PRODUCTS_URL = "https://realearth.ssec.wisc.edu/api/products";
/** One scan fading into the next. Fewer pictures get a longer fade. */
const LOOP_FADE_MS = 1300;
const LOOP_FEW_FADE_MS = 1800;
/** Do not freeze the reel if a tile is slow. The fade still starts. */
const LOOP_PRELOAD_MS = 1600;

const placed = new Map<string, string>();
/** Layers whose opacity is owned by the loop, not by Mapbox's 300ms default. */
const opacityPinned = new Set<string>();
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

async function fetchProductTimes(product: string): Promise<string[]> {
  try {
    const res = await fetch(
      `${PRODUCTS_URL}?products=${encodeURIComponent(product)}&timespan=-2h`,
    );
    if (!res.ok) return [];
    return productTimes(await res.json());
  } catch {
    return [];
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
  opacityPinned.delete(layer);
  if (map.getLayer(layer)) map.removeLayer(layer);
  if (map.getSource(src)) map.removeSource(src);
}

function rasterPaint(opacity: number): mapboxgl.RasterPaint {
  return {
    "raster-opacity": opacity,
    "raster-opacity-transition": { duration: 0, delay: 0 },
    "raster-fade-duration": 0,
  };
}

/** Instant opacity. A style transition here restarts every frame and flashes the map. */
function setRasterOpacity(map: MbMap, layer: string, opacity: number): void {
  if (!map.getLayer(layer)) return;
  if (!opacityPinned.has(layer)) {
    map.setPaintProperty(layer, "raster-opacity-transition", { duration: 0, delay: 0 });
    map.setPaintProperty(layer, "raster-fade-duration", 0);
    opacityPinned.add(layer);
  }
  map.setPaintProperty(layer, "raster-opacity", opacity);
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

function addRaster(map: MbMap, src: string, layer: string, spec: RasterSpec, opacity: number): void {
  if (spec.filterNotices) ensureRealEarthProvider();
  map.addSource(src, {
    type: "raster",
    tiles: [spec.tiles],
    tileSize: 256,
    maxzoom: spec.maxzoom,
    attribution: spec.attribution,
    ...(spec.filterNotices ? { provider: REAL_EARTH_PROVIDER } : {}),
  });
  map.addLayer({
    id: layer,
    type: "raster",
    source: src,
    paint: rasterPaint(opacity),
  });
  opacityPinned.add(layer);
}

function upsert(map: MbMap, src: string, layer: string, spec: RasterSpec): void {
  const key = specKey(spec);
  const existing = map.getSource(src);
  if (!existing || existing.type !== "raster" || placed.get(src) !== key) {
    drop(map, src, layer);
    addRaster(map, src, layer, spec, 1);
    placed.set(src, key);
    return;
  }
  if (!map.getLayer(layer)) {
    map.addLayer({
      id: layer,
      type: "raster",
      source: src,
      paint: rasterPaint(1),
    });
    opacityPinned.add(layer);
  }
}

/**
 * Swap the tile URL without removing the layer.
 * Returns true when the layer was created and still needs stacking.
 */
function retile(map: MbMap, src: string, layer: string, spec: RasterSpec, opacity: number): boolean {
  const key = specKey(spec);
  const existing = map.getSource(src);
  const prev = placed.get(src);
  const sameKind = !!prev && prev.slice(prev.indexOf("|") + 1) === key.slice(key.indexOf("|") + 1);
  if (existing && existing.type === "raster" && sameKind) {
    if (map.getLayer(layer)) setRasterOpacity(map, layer, opacity);
    if (prev !== key) {
      (existing as RasterTileSource).setTiles([spec.tiles]);
      placed.set(src, key);
    }
    if (!map.getLayer(layer)) {
      map.addLayer({
        id: layer,
        type: "raster",
        source: src,
        paint: rasterPaint(opacity),
      });
      opacityPinned.add(layer);
      return true;
    }
    return false;
  }
  drop(map, src, layer);
  addRaster(map, src, layer, spec, opacity);
  placed.set(src, key);
  return true;
}

function dropLoop(map: MbMap): void {
  for (const slot of SAT_LOOP) drop(map, slot.src, slot.layer);
  for (const slot of RADAR_LOOP) drop(map, slot.src, slot.layer);
  for (const slot of GLM_LOOP) drop(map, slot.src, slot.layer);
}

/** Bottom to top. Missing layers are skipped. The stack sits under the wind fill. */
function orderBottomToTop(map: MbMap, ids: readonly string[]): void {
  const present = ids.filter((id) => map.getLayer(id));
  if (!present.length) return;
  const under = map.getLayer(UNDER) ? UNDER : undefined;
  const top = present[present.length - 1];
  if (under && top) map.moveLayer(top, under);
  for (let i = present.length - 2; i >= 0; i -= 1) {
    const lower = present[i];
    const higher = present[i + 1];
    if (lower && higher) map.moveLayer(lower, higher);
  }
}

/** Satellite under radar under lightning, all under the first live-storm layer. */
function orderImagery(map: MbMap): void {
  orderBottomToTop(map, [SAT_LAYER, RADAR_LAYER, GLM_LAYER]);
}

/** Fixed stack. The top slot fades; the bottom slot stays put, so nothing is reordered mid-loop. */
function loopLayerOrder(): string[] {
  return [
    SAT_LOOP[0]?.layer ?? "",
    SAT_LOOP[1]?.layer ?? "",
    RADAR_LOOP[0]?.layer ?? "",
    RADAR_LOOP[1]?.layer ?? "",
    GLM_LOOP[0]?.layer ?? "",
    GLM_LOOP[1]?.layer ?? "",
  ];
}

interface PlayStep {
  frame: ImageryLoopFrame | null;
  satTiles: string | null;
  glmTiles: string | null;
  radarTiles: string | null;
  radarAgeMin: number | null;
}

function waitForSources(
  map: MbMap,
  sourceIds: readonly string[],
  timeoutMs: number,
  cancelled: () => boolean,
  begin: () => void,
): Promise<void> {
  if (!sourceIds.length || cancelled()) {
    begin();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const sawReload = new Set<string>();
    const ready = new Set<string>();
    let sawEvent = false;
    let poll = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(poll);
      map.off("sourcedata", onData);
      // One frame so the texture is on the map before it becomes visible.
      requestAnimationFrame(() => resolve());
    };
    const note = (id: string) => {
      if (!map.getSource(id)) {
        ready.add(id);
        return;
      }
      if (!map.isSourceLoaded(id)) sawReload.add(id);
      else if (sawReload.has(id)) ready.add(id);
    };
    const allReady = () => sourceIds.every((id) => ready.has(id));
    const onData = (event: mapboxgl.MapSourceDataEvent) => {
      if (!event.sourceId || !sourceIds.includes(event.sourceId)) return;
      sawEvent = true;
      note(event.sourceId);
      if (allReady()) finish();
    };
    map.on("sourcedata", onData);
    begin();
    for (const id of sourceIds) note(id);
    if (allReady()) {
      finish();
      return;
    }
    const started = performance.now();
    const tick = () => {
      if (settled) return;
      if (cancelled()) {
        finish();
        return;
      }
      for (const id of sourceIds) note(id);
      if (allReady()) {
        finish();
        return;
      }
      const elapsed = performance.now() - started;
      const cacheHit = elapsed > 48
        && sawEvent
        && sawReload.size === 0
        && sourceIds.every((id) => !map.getSource(id) || map.isSourceLoaded(id));
      if (cacheHit || elapsed >= timeoutMs) {
        finish();
        return;
      }
      poll = window.setTimeout(tick, 32);
    };
    poll = window.setTimeout(tick, 32);
  });
}

function satelliteTiles(sat: SatChoice, stamp: string | null, tick: number): string {
  if (sat.host === "gibs" && sat.tiles) {
    const join = sat.tiles.includes("?") ? "&" : "?";
    return `${sat.tiles}${join}r=${tick}`;
  }
  return tileTemplate(sat.product ?? "", stamp);
}

function loopSatelliteTiles(sat: SatChoice, frame: ImageryLoopFrame): string | null {
  if (sat.host === "gibs" && sat.tiles && frame.gibsIso) return gibsTilesAt(sat.tiles, frame.gibsIso);
  if (sat.host === "realearth" && sat.product && frame.satStamp) return tileTemplate(sat.product, frame.satStamp);
  return null;
}

export function LiveImageryLayer({ map }: { map: MbMap | null }) {
  const showSat = useLiveStormStore((s) => s.showSatellite);
  const showLight = useLiveStormStore((s) => s.showLightning);
  const showRadar = useLiveStormStore((s) => s.showRadar);
  const imageryLoop = useLiveStormStore((s) => s.imageryLoop);
  const data = useLiveStormStore((s) => s.data);
  const [stampSat, setStampSat] = useState<string | null>(null);
  const [stampGlm, setStampGlm] = useState<string | null>(null);
  const [gibsTime, setGibsTime] = useState<string | null>(null);
  const [satTimes, setSatTimes] = useState<string[]>([]);
  const [glmTimes, setGlmTimes] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const [frameIdx, setFrameIdx] = useState(0);
  const [radarAge, setRadarAge] = useState<number | null>(null);
  const [view, setView] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    if (!showSat && !showLight && !showRadar) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 10 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [showSat, showLight, showRadar]);

  useEffect(() => {
    if (!map) return;
    const read = () => {
      const c = map.getCenter();
      setView({ lat: c.lat, lon: c.lng });
    };
    read();
    if (data || (!showSat && !showLight && !showRadar)) return;
    map.on("moveend", read);
    return () => {
      map.off("moveend", read);
    };
  }, [map, data, showSat, showLight, showRadar]);

  const storm = anchorOf(data);
  const lat = storm?.lat ?? view?.lat ?? 25;
  const lon = storm?.lon ?? view?.lon ?? -75;
  const sat = satelliteFor(lon);
  const covered = glmCovers(lat, lon);
  const radarHere = radarCovers(lat, lon);

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
    if (!imageryLoop) {
      setSatTimes((prev) => (prev.length ? [] : prev));
      setGlmTimes((prev) => (prev.length ? [] : prev));
      return;
    }
    let cancel = false;
    if (showSat && sat.host === "realearth" && sat.product) {
      void fetchProductTimes(sat.product).then((times) => {
        if (!cancel) setSatTimes(times);
      });
    } else {
      setSatTimes([]);
    }
    if (showLight && covered) {
      void fetchProductTimes(GLM_PRODUCT).then((times) => {
        if (!cancel) setGlmTimes(times);
      });
    } else {
      setGlmTimes([]);
    }
    return () => {
      cancel = true;
    };
  }, [imageryLoop, showSat, showLight, covered, sat.host, sat.product, tick]);

  const frames = useMemo(() => {
    if (!imageryLoop || (!showSat && !showLight)) return [];
    const mode = showSat && sat.host === "gibs"
      ? "gibs"
      : showSat && sat.host === "realearth"
        ? "realearth"
        : "lightning-only";
    return buildImageryLoop({
      mode,
      gibsLatestIso: gibsTime,
      satStamps: satTimes,
      glmStamps: showLight && covered ? glmTimes : [],
    });
  }, [imageryLoop, showSat, showLight, covered, sat.host, gibsTime, satTimes, glmTimes]);
  const radarOn = showRadar && radarHere;
  const playing = imageryLoop && (loopHasMotion(frames) || (radarOn && !showSat && !showLight));
  const frame = playing ? (frames[frameIdx] ?? frames[0] ?? null) : null;
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const satHost = sat.host;
  const satTemplate = sat.tiles;
  const satProduct = sat.product;
  const satMaxzoom = sat.maxzoom;
  const satAttribution = sat.attribution;
  const filterSatNotices = sat.host === "realearth";
  const stillSatTiles = satelliteTiles(sat, stampSat, tick);
  const stillGlmTiles = tileTemplate(GLM_PRODUCT, stampGlm);
  const stillRadarTiles = radarTileUrl(0, tick);
  const playSteps = useMemo(() => {
    if (!playing) return [];
    const choice: SatChoice = {
      id: satHost === "realearth" ? "meteosat" : "goes-east",
      host: satHost,
      product: satProduct,
      tiles: satTemplate,
      maxzoom: satMaxzoom,
      attribution: satAttribution,
      label: "",
      note: "",
    };
    if (loopHasMotion(frames)) {
      const collapsed = collapseRepeatFrames(frames);
      const times = collapsed.map((step) => loopFrameMs(step));
      const newest = times.reduce<number>(
        (max, ms) => (ms != null && ms > max ? ms : max),
        Number.NEGATIVE_INFINITY,
      );
      return collapsed.map((step, i) => {
        const when = times[i];
        const age = radarOn && when != null && Number.isFinite(newest)
          ? radarAgeBetween(newest, when)
          : 0;
        return {
          frame: step,
          satTiles: showSat ? loopSatelliteTiles(choice, step) : null,
          glmTiles: showLight && covered && step.glmStamp
            ? tileTemplate(GLM_PRODUCT, step.glmStamp)
            : null,
          radarTiles: radarOn ? radarTileUrl(age, tick) : null,
          radarAgeMin: radarOn ? age : null,
        };
      });
    }
    return radarLoopAges().map((age) => ({
      frame: null,
      satTiles: null,
      glmTiles: null,
      radarTiles: radarTileUrl(age, tick),
      radarAgeMin: age,
    }));
  }, [
    playing, frames, showSat, showLight, covered, radarOn, tick,
    satHost, satTemplate, satProduct, satMaxzoom, satAttribution,
  ]);

  useEffect(() => {
    if (!map || playing) return;
    const apply = () => {
      dropLoop(map);
      if (showSat) {
        upsert(map, SAT_SRC, SAT_LAYER, {
          tiles: stillSatTiles,
          maxzoom: satMaxzoom,
          attribution: satAttribution,
          filterNotices: filterSatNotices,
        });
      } else {
        drop(map, SAT_SRC, SAT_LAYER);
      }
      if (showRadar && radarHere) {
        upsert(map, RADAR_SRC, RADAR_LAYER, {
          tiles: stillRadarTiles,
          maxzoom: 7,
          attribution: "Iowa Environmental Mesonet",
          filterNotices: false,
        });
      } else {
        drop(map, RADAR_SRC, RADAR_LAYER);
      }
      if (showLight && covered) {
        upsert(map, GLM_SRC, GLM_LAYER, {
          tiles: stillGlmTiles,
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
    playing,
    showSat,
    showLight,
    covered,
    stillSatTiles,
    stillGlmTiles,
    stillRadarTiles,
    showRadar,
    radarHere,
    satMaxzoom,
    satAttribution,
    filterSatNotices,
  ]);

  useEffect(() => {
    if (!map || !playing || playSteps.length < 2) return;
    const motion = { cancelled: false, raf: 0 };
    const cancelled = () => motion.cancelled;

    const BOTTOM = 0;
    const TOP = 1;

    const paint = (slot: number, step: PlayStep, opacity: number): boolean => {
      let created = false;
      const satSlot = SAT_LOOP[slot];
      const glmSlot = GLM_LOOP[slot];
      if (satSlot && step.satTiles) {
        created = retile(map, satSlot.src, satSlot.layer, {
          tiles: step.satTiles,
          maxzoom: satMaxzoom,
          attribution: satAttribution,
          filterNotices: filterSatNotices,
        }, opacity) || created;
      } else if (satSlot) {
        drop(map, satSlot.src, satSlot.layer);
      }
      const radarSlot = RADAR_LOOP[slot];
      if (radarSlot && step.radarTiles) {
        created = retile(map, radarSlot.src, radarSlot.layer, {
          tiles: step.radarTiles,
          maxzoom: 7,
          attribution: "Iowa Environmental Mesonet",
          filterNotices: false,
        }, opacity) || created;
      } else if (radarSlot) {
        drop(map, radarSlot.src, radarSlot.layer);
      }
      if (glmSlot && step.glmTiles) {
        created = retile(map, glmSlot.src, glmSlot.layer, {
          tiles: step.glmTiles,
          maxzoom: 7,
          attribution: "SSEC RealEarth",
          filterNotices: true,
        }, opacity) || created;
      } else if (glmSlot) {
        drop(map, glmSlot.src, glmSlot.layer);
      }
      return created;
    };

    const topLayers = (): string[] => {
      const out: string[] = [];
      for (const layer of [SAT_LOOP[TOP]?.layer, RADAR_LOOP[TOP]?.layer, GLM_LOOP[TOP]?.layer]) {
        if (layer && map.getLayer(layer)) out.push(layer);
      }
      return out;
    };

    /** Fade only the top slot. The other scan stays fully opaque underneath. */
    const fadeTop = (from: number, to: number, durationMs: number) => new Promise<void>((resolve) => {
      const layers = topLayers();
      for (const layer of layers) setRasterOpacity(map, layer, from);
      const started = performance.now();
      const tickFrame = (now: number) => {
        if (motion.cancelled) {
          resolve();
          return;
        }
        const t = dissolveOpacity(now - started, durationMs);
        const opacity = from + (to - from) * t;
        for (const layer of layers) setRasterOpacity(map, layer, opacity);
        if (t < 1) motion.raf = requestAnimationFrame(tickFrame);
        else resolve();
      };
      motion.raf = requestAnimationFrame(tickFrame);
    });

    const publish = (step: PlayStep) => {
      setRadarAge((cur) => (cur === step.radarAgeMin ? cur : step.radarAgeMin));
      if (!step.frame) return;
      const key = imageryFrameKey(step.frame);
      const idx = framesRef.current.findIndex((item) => imageryFrameKey(item) === key);
      if (idx >= 0) setFrameIdx((cur) => (cur === idx ? cur : idx));
    };

    const run = () => {
      if (motion.cancelled) return;
      drop(map, SAT_SRC, SAT_LAYER);
      drop(map, GLM_SRC, GLM_LAYER);
      const fadeMs = playSteps.length <= 3 ? LOOP_FEW_FADE_MS : LOOP_FADE_MS;
      let index = 0;
      let onTop = false;
      const firstStep = playSteps[0];
      if (!firstStep) return;
      if (paint(BOTTOM, firstStep, 1)) orderBottomToTop(map, loopLayerOrder());
      publish(firstStep);
      void (async () => {
        while (!motion.cancelled) {
          const restart = loopRestarts(index, playSteps.length);
          const next = restart ? 0 : index + 1;
          const slot: 0 | 1 = onTop ? BOTTOM : TOP;
          const step = playSteps[next];
          if (!step) return;
          const incoming: string[] = [];
          if (step.satTiles && SAT_LOOP[slot]) incoming.push(SAT_LOOP[slot].src);
          if (step.radarTiles && RADAR_LOOP[slot]) incoming.push(RADAR_LOOP[slot].src);
          if (step.glmTiles && GLM_LOOP[slot]) incoming.push(GLM_LOOP[slot].src);
          await waitForSources(map, incoming, LOOP_PRELOAD_MS, cancelled, () => {
            // The top slot is invisible. The bottom slot is covered while the top is opaque.
            const created = paint(slot, step, slot === TOP ? 0 : 1);
            if (created) orderBottomToTop(map, loopLayerOrder());
          });
          if (motion.cancelled) return;
          if (restart) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, fadeMs);
            });
            if (motion.cancelled) return;
            for (const layer of topLayers()) setRasterOpacity(map, layer, slot === TOP ? 1 : 0);
          } else if (slot === TOP) {
            await fadeTop(0, 1, fadeMs);
            if (motion.cancelled) return;
          } else {
            await fadeTop(1, 0, fadeMs);
            if (motion.cancelled) return;
          }
          publish(step);
          onTop = slot === TOP;
          index = next;
        }
      })();
    };

    if (map.isStyleLoaded()) run();
    else map.once("style.load", run);
    return () => {
      motion.cancelled = true;
      if (motion.raf) cancelAnimationFrame(motion.raf);
      map.off("style.load", run);
      dropLoop(map);
    };
  }, [map, playing, playSteps, satMaxzoom, satAttribution, filterSatNotices]);

  useEffect(() => {
    if (!showSat && !showLight && !showRadar) {
      if (useLiveStormStore.getState().imageryStatus) {
        useLiveStormStore.getState().setImageryStatus(null);
      }
      return;
    }
    const sharedLoop = playing && loopHasMotion(frames);
    const loopNote = !imageryLoop
      ? ""
      : sharedLoop
        ? " Looping forward through the last hour."
        : frames.length > 0
          ? " One scan in the last hour."
          : "";
    const satWhen = frame
      ? (sat.host === "gibs"
        ? (formatGibsTime(frame.gibsIso) ?? "latest")
        : (formatStamp(frame.satStamp) ?? "latest"))
      : (sat.host === "gibs"
        ? (formatGibsTime(gibsTime) ?? "latest")
        : (formatStamp(stampSat) ?? "latest"));
    const glmWhen = formatStamp(frame?.glmStamp ?? stampGlm) ?? "latest";
    const satellite = showSat ? `${sat.label} · ${satWhen}.${loopNote} ${sat.note}` : null;
    const lightning = !showLight
      ? null
      : covered
        ? `GOES-East GLM · ${glmWhen}.${loopNote} Optical flashes, not confirmed ground strikes.`
        : "GOES-East GLM does not cover this location. No lightning is drawn.";
    const radarPlaying = playing && radarOn && radarAge != null;
    const radarNote = radarPlaying
      ? (sharedLoop
        ? " Looping forward through the last hour."
        : " Looping forward, then jumping back about 50 minutes.")
      : "";
    const radarWhen = radarPlaying
      ? (radarAge === 0 ? "latest" : `${radarAge} min ago`)
      : "latest";
    const radar = !showRadar
      ? null
      : !radarHere
        ? "NEXRAD does not cover this location. No radar is drawn."
        : `NEXRAD · ${radarWhen}.${radarNote} Composite base reflectivity from the Iowa Environmental Mesonet.`;
    const cur = useLiveStormStore.getState().imageryStatus;
    if (cur?.satellite === satellite && cur?.lightning === lightning && cur?.radar === radar) return;
    useLiveStormStore.getState().setImageryStatus({ satellite, lightning, radar });
  }, [
    showSat, showLight, showRadar, imageryLoop, playing, frames, frame,
    sat.host, sat.label, sat.note, stampSat, stampGlm, gibsTime, covered,
    radarHere, radarOn, radarAge,
  ]);

  useEffect(() => {
    return () => {
      useLiveStormStore.getState().setImageryStatus(null);
      if (!map) return;
      drop(map, SAT_SRC, SAT_LAYER);
      drop(map, RADAR_SRC, RADAR_LAYER);
      drop(map, GLM_SRC, GLM_LAYER);
      dropLoop(map);
    };
  }, [map]);

  return null;
}
