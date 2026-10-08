/**
 * Geostationary satellite and GOES-East lightning for the live-storm map.
 * Both stay off until the panel chips are turned on.
 *
 * GOES and Himawari tiles are NASA GIBS. Meteosat and GLM stay on SSEC
 * RealEarth, and a tile that is the "Size limit exceeded" notice is
 * returned empty so the text is never drawn. The bird follows the storm,
 * or the map center when no storm is selected.
 *
 * The hour loop cannot be a video. Those birds photograph about every
 * 10 minutes (Meteosat about hourly). Playback fades one real scan into
 * the next, forward and then back, so the hour does not cut or jump.
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
  loopHasMotion,
  pingPongOrder,
  productTimes,
  realEarthProviderModule,
  satelliteFor,
  tileTemplate,
  type ImageryLoopFrame,
  type SatChoice,
} from "./satelliteChoice";

const SAT_SRC = "live-satellite";
const SAT_LAYER = "live-satellite";
const GLM_SRC = "live-lightning";
const GLM_LAYER = "live-lightning";
/** Two buffers so the visible scan stays up while the next one loads. */
const SAT_LOOP = [
  { src: "live-satellite-a", layer: "live-satellite-a" },
  { src: "live-satellite-b", layer: "live-satellite-b" },
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
const LOOP_PRELOAD_MS = 900;

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
    paint: { "raster-opacity": opacity, "raster-fade-duration": 0 },
  });
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
      paint: { "raster-opacity": 1, "raster-fade-duration": 0 },
    });
  }
}

/** Swap the tile URL without removing the layer, so a hidden buffer can preload. */
function retile(map: MbMap, src: string, layer: string, spec: RasterSpec, opacity: number): void {
  const key = specKey(spec);
  const existing = map.getSource(src);
  const prev = placed.get(src);
  const sameKind = !!prev && prev.slice(prev.indexOf("|") + 1) === key.slice(key.indexOf("|") + 1);
  if (existing && existing.type === "raster" && sameKind) {
    if (map.getLayer(layer)) map.setPaintProperty(layer, "raster-opacity", opacity);
    if (prev !== key) {
      (existing as RasterTileSource).setTiles([spec.tiles]);
      placed.set(src, key);
    }
    if (!map.getLayer(layer)) {
      map.addLayer({
        id: layer,
        type: "raster",
        source: src,
        paint: { "raster-opacity": opacity, "raster-fade-duration": 0 },
      });
    }
    return;
  }
  drop(map, src, layer);
  addRaster(map, src, layer, spec, opacity);
  placed.set(src, key);
}

function dropLoop(map: MbMap): void {
  for (const slot of SAT_LOOP) drop(map, slot.src, slot.layer);
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

/** Satellite under lightning, both under the first live-storm layer. */
function orderImagery(map: MbMap): void {
  orderBottomToTop(map, [SAT_LAYER, GLM_LAYER]);
}

function loopStack(front: number): string[] {
  const back = 1 - front;
  return [
    SAT_LOOP[front]?.layer ?? "",
    SAT_LOOP[back]?.layer ?? "",
    GLM_LOOP[front]?.layer ?? "",
    GLM_LOOP[back]?.layer ?? "",
  ];
}

interface PlayStep {
  frame: ImageryLoopFrame;
  satTiles: string | null;
  glmTiles: string | null;
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
    const dirty = new Set<string>();
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      map.off("sourcedata", onData);
      resolve();
    };
    const ready = () => sourceIds.every((id) => dirty.has(id) && map.isSourceLoaded(id));
    const onData = (event: mapboxgl.MapSourceDataEvent) => {
      const id = event.sourceId;
      if (!id || !sourceIds.includes(id)) return;
      if (event.sourceDataType === "content") dirty.add(id);
      if (ready()) finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    map.on("sourcedata", onData);
    begin();
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
  const imageryLoop = useLiveStormStore((s) => s.imageryLoop);
  const data = useLiveStormStore((s) => s.data);
  const [stampSat, setStampSat] = useState<string | null>(null);
  const [stampGlm, setStampGlm] = useState<string | null>(null);
  const [gibsTime, setGibsTime] = useState<string | null>(null);
  const [satTimes, setSatTimes] = useState<string[]>([]);
  const [glmTimes, setGlmTimes] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const [frameIdx, setFrameIdx] = useState(0);
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
  const playing = imageryLoop && loopHasMotion(frames);
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
    return collapseRepeatFrames(frames).map((step) => ({
      frame: step,
      satTiles: showSat ? loopSatelliteTiles(choice, step) : null,
      glmTiles: showLight && covered && step.glmStamp
        ? tileTemplate(GLM_PRODUCT, step.glmStamp)
        : null,
    }));
  }, [
    playing, frames, showSat, showLight, covered,
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
    satMaxzoom,
    satAttribution,
    filterSatNotices,
  ]);

  useEffect(() => {
    if (!map || !playing || playSteps.length < 2) return;
    const motion = { cancelled: false, raf: 0 };
    const cancelled = () => motion.cancelled;

    const paint = (slot: number, step: PlayStep, opacity: number): void => {
      const satSlot = SAT_LOOP[slot];
      const glmSlot = GLM_LOOP[slot];
      if (satSlot && step.satTiles) {
        retile(map, satSlot.src, satSlot.layer, {
          tiles: step.satTiles,
          maxzoom: satMaxzoom,
          attribution: satAttribution,
          filterNotices: filterSatNotices,
        }, opacity);
      } else if (satSlot) {
        drop(map, satSlot.src, satSlot.layer);
      }
      if (glmSlot && step.glmTiles) {
        retile(map, glmSlot.src, glmSlot.layer, {
          tiles: step.glmTiles,
          maxzoom: 7,
          attribution: "SSEC RealEarth",
          filterNotices: true,
        }, opacity);
      } else if (glmSlot) {
        drop(map, glmSlot.src, glmSlot.layer);
      }
    };

    const fadeIn = (layers: string[], durationMs: number) => new Promise<void>((resolve) => {
      const started = performance.now();
      const tickFrame = (now: number) => {
        if (motion.cancelled) {
          resolve();
          return;
        }
        const opacity = dissolveOpacity(now - started, durationMs);
        for (const layer of layers) {
          if (map.getLayer(layer)) map.setPaintProperty(layer, "raster-opacity", opacity);
        }
        if (opacity < 1) motion.raf = requestAnimationFrame(tickFrame);
        else resolve();
      };
      motion.raf = requestAnimationFrame(tickFrame);
    });

    const publish = (step: PlayStep) => {
      const key = imageryFrameKey(step.frame);
      const idx = framesRef.current.findIndex((item) => imageryFrameKey(item) === key);
      if (idx >= 0) setFrameIdx((cur) => (cur === idx ? cur : idx));
    };

    const run = () => {
      if (motion.cancelled) return;
      drop(map, SAT_SRC, SAT_LAYER);
      drop(map, GLM_SRC, GLM_LAYER);
      const sequence = pingPongOrder(playSteps.length);
      const first = sequence[0] ?? 0;
      const fadeMs = playSteps.length <= 3 ? LOOP_FEW_FADE_MS : LOOP_FADE_MS;
      let cursor = 0;
      let front = 0;
      const firstStep = playSteps[first];
      if (!firstStep) return;
      paint(front, firstStep, 1);
      publish(firstStep);
      orderBottomToTop(map, loopStack(front));
      void (async () => {
        while (!motion.cancelled) {
          const nextCursor = (cursor + 1) % sequence.length;
          const back = 1 - front;
          const step = playSteps[sequence[nextCursor] ?? 0];
          if (!step) return;
          const incoming: string[] = [];
          if (step.satTiles && SAT_LOOP[back]) incoming.push(SAT_LOOP[back].src);
          if (step.glmTiles && GLM_LOOP[back]) incoming.push(GLM_LOOP[back].src);
          await waitForSources(map, incoming, LOOP_PRELOAD_MS, cancelled, () => {
            paint(back, step, 0);
            orderBottomToTop(map, loopStack(front));
          });
          if (motion.cancelled) return;
          publish(step);
          const layers: string[] = [];
          const satLayer = SAT_LOOP[back]?.layer;
          const glmLayer = GLM_LOOP[back]?.layer;
          if (satLayer && map.getLayer(satLayer)) layers.push(satLayer);
          if (glmLayer && map.getLayer(glmLayer)) layers.push(glmLayer);
          await fadeIn(layers, fadeMs);
          if (motion.cancelled) return;
          for (const slot of [SAT_LOOP[front], GLM_LOOP[front]]) {
            if (slot && map.getLayer(slot.layer)) {
              map.setPaintProperty(slot.layer, "raster-opacity", 0);
            }
          }
          front = back;
          cursor = nextCursor;
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
    if (!showSat && !showLight) {
      if (useLiveStormStore.getState().imageryStatus) {
        useLiveStormStore.getState().setImageryStatus(null);
      }
      return;
    }
    const loopNote = !imageryLoop
      ? ""
      : playing
        ? " Looping the last hour, forward then back."
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
    const cur = useLiveStormStore.getState().imageryStatus;
    if (cur?.satellite === satellite && cur?.lightning === lightning) return;
    useLiveStormStore.getState().setImageryStatus({ satellite, lightning });
  }, [
    showSat, showLight, imageryLoop, playing, frames.length, frame,
    sat.host, sat.label, sat.note, stampSat, stampGlm, gibsTime, covered,
  ]);

  useEffect(() => {
    return () => {
      useLiveStormStore.getState().setImageryStatus(null);
      if (!map) return;
      drop(map, SAT_SRC, SAT_LAYER);
      drop(map, GLM_SRC, GLM_LAYER);
      dropLoop(map);
    };
  }, [map]);

  return null;
}
