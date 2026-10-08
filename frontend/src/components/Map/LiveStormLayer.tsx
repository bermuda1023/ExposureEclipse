/**
 * Map overlay for the active live / replay storm:
 *
 *   1. Observed track (solid coloured line)
 *   2. Latest forecast track (bold coloured line) + ghost lines for older
 *      advisories (lighter / dashed)
 *   3. NWS active alerts (coloured polygons per severity)
 *   4. NDBC buoys (markers with wind-barb glyph via emoji fallback)
 *   5. NWS land stations (markers, distinct from buoys)
 *   6. SST grid (translucent fill cells)
 *   7. Hurricane hunter HDOB (flight track + SFMR/FL surface wind) + VDM fix
 *
 * Everything fades out when the panel toggle is off; no state cleanup
 * needed beyond removing the layer's data.
 */

import type { GeoJSONSource, Map as MbMap } from "mapbox-gl";
import { useEffect, useRef } from "react";
import { shearViewActive, useLiveStormStore } from "../../state/liveStorm";
import { placeWindParticlesUnderTrack } from "./WindParticleLayer";
import type { JmaOverlay } from "../../api/live";
import { SAFFIR_SIMPSON_COLORS } from "./hurricaneColors";
import { segmentsAvoidingAntimeridian } from "./trackSplit";

// SSHWS-palette `step` expression for wind speed (kt) → category color.
// Single source of truth for any line/marker keyed on observed wind speed.
const SSHWS_STEP_COLOR: (string | number)[] = [
  SAFFIR_SIMPSON_COLORS[-1],  // <34 kt → TD slate
  34, SAFFIR_SIMPSON_COLORS[0],   // TS cyan
  64, SAFFIR_SIMPSON_COLORS[1],   // Cat 1 yellow
  83, SAFFIR_SIMPSON_COLORS[2],   // Cat 2 orange
  96, SAFFIR_SIMPSON_COLORS[3],   // Cat 3 red
  113, SAFFIR_SIMPSON_COLORS[4],  // Cat 4 dark red
  137, SAFFIR_SIMPSON_COLORS[5],  // Cat 5 magenta
];

const SRC_OBSERVED = "live-observed";
const SRC_FORECAST_LATEST = "live-forecast-latest";
const SRC_FORECAST_HISTORY = "live-forecast-history";
const SRC_ALERTS = "live-alerts";
const SRC_WW = "live-watches-warnings";
const SRC_BUOYS = "live-buoys";
const SRC_RECON = "live-recon";
const SRC_RECON_TRACK = "live-recon-track";
const SRC_VORTEX = "live-vortex";
const SRC_LAND = "live-land";
const SRC_SST = "live-sst";
const SRC_OBS_INNER = "live-obs-inner-cone";
const SRC_OBS_OUTER = "live-obs-outer-cone";
const SRC_OBS_RINGS = "live-obs-outer-rings";
const SRC_FCST_INNER = "live-fcst-inner-cone";
const SRC_FCST_OUTER = "live-fcst-outer-cone";
const SRC_FCST_RINGS = "live-fcst-outer-rings";
const SRC_NHC_CONE = "live-nhc-cone";
const SRC_SURGE = "live-surge";
const SRC_WIND_MAP = "live-wind-map";
const SRC_JMA_FILL = "live-jma-fill";
const SRC_JMA_LINE = "live-jma-line";
const SRC_JMA_LABEL = "live-jma-label";

const LAYER_OBSERVED = "live-observed-line";
const LAYER_FORECAST_LATEST = "live-forecast-latest-line";
const LAYER_FORECAST_HISTORY = "live-forecast-history-line";
const LAYER_ALERTS_FILL = "live-alerts-fill";
const LAYER_ALERTS_LINE = "live-alerts-line";
const LAYER_WW_FILL = "live-watches-warnings-fill";
const LAYER_WW_LINE = "live-watches-warnings-line";
const LAYER_BUOYS = "live-buoys-circle";
const LAYER_RECON = "live-recon-arrow";
const LAYER_RECON_NODIR = "live-recon-nodir";
const LAYER_RECON_LEGACY = "live-recon-circle";
const LAYER_RECON_TRACK = "live-recon-track";
const LAYER_RECON_TEXT = "live-recon-text";
const LAYER_VORTEX = "live-vortex-circle";
const LAYER_VORTEX_TEXT = "live-vortex-text";
const LAYER_LAND = "live-land-circle";
const LAYER_SST = "live-sst-fill";
const LAYER_OBS_INNER = "live-obs-inner-fill";
const LAYER_OBS_OUTER = "live-obs-outer-fill";
const LAYER_OBS_RINGS = "live-obs-rings-fill";
const LAYER_FCST_INNER = "live-fcst-inner-fill";
const LAYER_FCST_OUTER = "live-fcst-outer-fill";
const LAYER_FCST_RINGS = "live-fcst-rings-fill";
const LAYER_BUOYS_TEXT = "live-buoys-text";
const LAYER_LAND_TEXT = "live-land-text";
const LAYER_NHC_CONE_FILL = "live-nhc-cone-fill";
const LAYER_NHC_CONE_LINE = "live-nhc-cone-line";
const LAYER_SURGE_FILL = "live-surge-fill";
const LAYER_SURGE_LINE = "live-surge-line";
const LAYER_WIND_MAP_FILL = "live-wind-map-fill";
const LAYER_WIND_SHEAR_ARROW = "live-wind-shear-arrow";
const SRC_WIND_OBS = "live-wind-obs";
const LAYER_WIND_OBS = "live-wind-obs-circle";
const LAYER_JMA_GALE = "live-jma-gale";
const LAYER_JMA_STORM = "live-jma-storm";
const LAYER_JMA_CIRCLE = "live-jma-circle";
const LAYER_JMA_TANGENT = "live-jma-tangent";
const LAYER_JMA_WARN = "live-jma-warn";
const LAYER_JMA_LABEL = "live-jma-label";

// SSHWS-inspired palette for the interpolated wind heatmap. Not a step
// expression — we interpolate for a smooth field. Anchor points chosen to
// match the categorical breaks (34 kt TS, 64 kt Cat 1, 96 kt Cat 3).
const WIND_MAP_COLOR: unknown[] = [
  "interpolate", ["linear"], ["get", "windKt"],
  0,   "#e0f2fe",   // near-calm
  15,  "#a3e635",   // breezy
  25,  "#facc15",   // strong
  34,  "#fb923c",   // TS
  50,  "#dc2626",   // strong TS
  64,  "#7f1d1d",   // Cat 1
  96,  "#581c87",   // Cat 3+
];

// Deep-layer shear. Not the SSHWS ramp — 20 kt of shear is already hostile
// for a tropical cyclone, while 20 kt of surface wind is a breeze.
const SHEAR_COLOR: unknown[] = [
  "interpolate", ["linear"], ["get", "windKt"],
  0,  "#dcfce7",
  10, "#facc15",
  20, "#f97316",
  30, "#dc2626",
  45, "#581c87",
];

// Diverging palette for diff modes — obs minus model (or model minus model).
// Centered on 0 (agreement) with blue = A weaker than B, red = A stronger.
const WIND_DIFF_COLOR: unknown[] = [
  "interpolate", ["linear"], ["get", "diff"],
  -30, "#1e3a8a",
  -15, "#60a5fa",
  -5,  "#bfdbfe",
   0,  "#f8fafc",
   5,  "#fecaca",
   15, "#dc2626",
   30, "#7f1d1d",
];

// NHC's peak-storm-surge palette: hint colours in the KML mirror the standard
// NHC surge legend. Ordered coolest → hottest so the fill layer's match
// expression stacks correctly.
const SURGE_COLOR: Record<string, string> = {
  blue: "#2563eb",         // 1-2 ft
  yellow: "#facc15",       // 3-6 ft
  orange: "#f97316",       // 6-9 ft
  red: "#dc2626",          // 9+ ft
  purple: "#7c3aed",       // extreme
  gray: "#94a3b8",
};

// Zoom at which buoy + station wind speed labels appear right next to the
// marker (no hover needed). Below this they'd visually clutter the map.
const OBS_LABEL_MIN_ZOOM = 6.5;

// Cat-colored step palette for the wind-field cones (matches historical
// impact view so the visual language is consistent across the app).
const CONE_STEP_COLOR: (string | number)[] = [
  "#fde047",        // < 83 (Cat 1)
  83, "#fb923c",   // Cat 2
  96, "#ea580c",   // Cat 3
  113, "#b91c1c",  // Cat 4
  137, "#581c87",  // Cat 5
];

// NWS severity → colour for the alert polygons.
const SEVERITY_COLOR: Record<string, string> = {
  Extreme: "#7f1d1d",
  Severe: "#b91c1c",
  Moderate: "#ea580c",
  Minor: "#f59e0b",
  Unknown: "#a3a3a3",
};

// SST colour ramp is inlined as an ["interpolate"] expression on the SST
// circle layer below; no constant kept here.

interface Props {
  map: MbMap | null;
}

function buildLineFC(coords: { lat: number; lon: number; windKt?: number }[], windFallback = 64) {
  const features: GeoJSON.Feature[] = [];
  // A step across ±180° is a few miles on the globe. Drawing it raw paints
  // a line across the whole Pacific.
  for (const piece of segmentsAvoidingAntimeridian(coords)) {
    for (let i = 0; i < piece.length - 1; i++) {
      const a = piece[i]!;
      const b = piece[i + 1]!;
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [[a.lon, a.lat], [b.lon, b.lat]],
        },
        properties: { windKt: Math.max(a.windKt ?? windFallback, b.windKt ?? windFallback) },
      });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function buildJmaFC(jma: JmaOverlay | null | undefined): {
  fill: GeoJSON.FeatureCollection;
  line: GeoJSON.FeatureCollection;
  label: GeoJSON.FeatureCollection;
} {
  if (!jma) return { fill: emptyFC(), line: emptyFC(), label: emptyFC() };
  const fill: GeoJSON.Feature[] = [];
  const line: GeoJSON.Feature[] = [];
  const label: GeoJSON.Feature[] = [];
  for (const circle of jma.circles) {
    if (circle.ring.length < 2) continue;
    if (circle.kind === "gale" || circle.kind === "storm") {
      fill.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [circle.ring] },
        properties: { kind: circle.kind },
      });
    } else {
      line.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: circle.ring },
        properties: { kind: "probability" },
      });
    }
    if (circle.label) {
      label.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [circle.centerLon, circle.centerLat] },
        properties: { label: circle.label },
      });
    }
  }
  for (const path of jma.paths) {
    if (path.coordinates.length < 2) continue;
    line.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: path.coordinates },
      properties: { kind: path.kind },
    });
  }
  return {
    fill: { type: "FeatureCollection", features: fill },
    line: { type: "FeatureCollection", features: line },
    label: { type: "FeatureCollection", features: label },
  };
}

function buildForecastHistoryFC(advisories: import("../../api/live").ForecastAdvisory[]) {
  // Each prior advisory becomes one polyline feature so we can colour them
  // collectively via a single layer with a `case` expression keyed on
  // `properties.advisoryNumber` (newest = brightest, older = fainter).
  const features: GeoJSON.Feature[] = [];
  const sorted = [...advisories].sort((a, b) => a.advisoryNumber - b.advisoryNumber);
  const maxAdv = sorted[sorted.length - 1]?.advisoryNumber ?? 0;
  for (const adv of sorted) {
    if (adv.points.length < 2) continue;
    if (adv.advisoryNumber === maxAdv) continue; // latest is rendered separately
    const coords = adv.points.map((p) => [p.lon, p.lat]);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        advisoryNumber: adv.advisoryNumber,
        synthetic: adv.synthetic,
        age: maxAdv - adv.advisoryNumber,
      },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildAlertsFC(alerts: import("../../api/live").WeatherAlert[]) {
  const features: GeoJSON.Feature[] = [];
  for (const a of alerts) {
    if (!a.geometry) continue;
    features.push({
      type: "Feature",
      geometry: a.geometry as GeoJSON.Geometry,
      properties: {
        event: a.event,
        severity: a.severity,
        headline: a.headline,
      },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

// NHC watches/warnings — carry the NHC operational colour on the feature so
// the paint expression can be a straight ["get", "color"] instead of a bulky
// match on event. Sort ascending by rank so higher-rank polygons paint LAST
// (on top): Extreme Wind Warning > Hurricane Warning > Storm Surge Warning
// > Hurricane Watch > TS Warning > TS Watch.
function buildWatchWarnFC(ww: import("../../api/live").NHCWatchWarn[]) {
  const features: GeoJSON.Feature[] = [];
  const sorted = [...ww].sort((a, b) => a.rank - b.rank);
  for (const w of sorted) {
    if (!w.geometry) continue;
    features.push({
      type: "Feature",
      id: w.alertId,
      geometry: w.geometry as GeoJSON.Geometry,
      properties: {
        alertId: w.alertId,
        event: w.event,
        family: w.family,
        color: w.color,
        rank: w.rank,
        headline: w.headline,
        areasAffected: w.areasAffected,
        expiresAt: w.expiresAt,
      },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildBuoyFC(buoys: import("../../api/live").BuoyObs[]) {
  return {
    type: "FeatureCollection" as const,
    features: buoys.map((b) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [b.lon, b.lat] },
      properties: {
        stationId: b.stationId,
        windKt: b.windKt ?? 0,
        gustKt: b.gustKt ?? 0,
        pressureMb: b.pressureMb,
      },
    })),
  };
}

function buildReconFC(points: import("../../api/live").ReconObs[]) {
  return {
    type: "FeatureCollection" as const,
    features: points.map((p) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
      properties: {
        surfaceKt: p.surfaceKt,
        surfaceSource: p.surfaceSource,
        flWindKt: p.flWindKt,
        flDirDeg: p.flDirDeg,
        // 1 when flight-level direction exists. The arrow points downwind
        // (meteorological "from" + 180). No direction → a small dot.
        hasDir: p.flDirDeg == null ? 0 : 1,
        sfmrKt: p.sfmrKt,
        aircraft: p.aircraft,
        missionId: p.missionId,
        observedAt: p.observedAt,
      },
    })),
  };
}

// Continuous surface-wind ramp. SSHWS steps paint everything under 34 kt
// the same colour, which hides the eyewall on a hunter transect.
export const SURFACE_WIND_STOPS: Array<[number, string]> = [
  [0, "#e0f2fe"],
  [15, "#84cc16"],
  [25, "#facc15"],
  [34, "#f97316"],
  [50, "#dc2626"],
  [64, "#7f1d1d"],
  [96, "#6b21a8"],
];

function surfaceWindPaint(prop: string): unknown[] {
  return [
    "interpolate", ["linear"], ["get", prop],
    ...SURFACE_WIND_STOPS.flatMap(([kt, color]) => [kt, color]),
  ];
}

/** White arrow pointing north. SDF so Mapbox can tint it by wind speed. */
function ensureWindArrow(map: MbMap): void {
  if (map.hasImage("hunter-wind-arrow")) return;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, size, size);
  g.fillStyle = "#ffffff";
  g.beginPath();
  // Shaft plus a wide head, so the heading still reads when the icon is small.
  g.moveTo(16, 1);
  g.lineTo(31, 20);
  g.lineTo(21, 20);
  g.lineTo(21, 31);
  g.lineTo(11, 31);
  g.lineTo(11, 20);
  g.lineTo(1, 20);
  g.closePath();
  g.fill();
  const image = g.getImageData(0, 0, size, size);
  map.addImage("hunter-wind-arrow", image, { sdf: true });
}

function hoursBetween(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.abs(tb - ta) / 3_600_000;
}

function buildReconTrackFC(points: import("../../api/live").ReconObs[]) {
  const byAc = new Map<string, import("../../api/live").ReconObs[]>();
  for (const p of points) {
    const k = p.aircraft || "recon";
    const arr = byAc.get(k) ?? [];
    arr.push(p);
    byAc.set(k, arr);
  }
  // One short segment per pair so Mapbox can colour that stretch by the
  // surface wind at its ends. A gap longer than a refuel is a new pass,
  // not a line across the Gulf.
  const features = [...byAc.values()].flatMap((arr) => {
    const sorted = [...arr].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const segs = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (hoursBetween(prev.observedAt, cur.observedAt) > 1.5) continue;
      const surfaceKt = Math.round((prev.surfaceKt + cur.surfaceKt) / 2);
      segs.push({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: [[prev.lon, prev.lat], [cur.lon, cur.lat]],
        },
        properties: { aircraft: cur.aircraft, surfaceKt },
      });
    }
    return segs;
  });
  return { type: "FeatureCollection" as const, features };
}

function buildVortexFC(v: import("../../api/live").VortexFix | null) {
  if (!v) return { type: "FeatureCollection" as const, features: [] };
  return {
    type: "FeatureCollection" as const,
    features: [{
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [v.lon, v.lat] },
      properties: {
        aircraft: v.aircraft,
        pressureMb: v.pressureMb,
        maxFlWindKt: v.maxFlWindKt,
        observedAt: v.observedAt,
        missionId: v.missionId,
      },
    }],
  };
}

function buildLandFC(stations: import("../../api/live").LandObs[]) {
  return {
    type: "FeatureCollection" as const,
    features: stations.map((s) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
      properties: {
        stationId: s.stationId,
        name: s.name,
        windKt: s.windKt ?? 0,
      },
    })),
  };
}

function buildSstFC(
  sst: import("../../api/live").SSTPoint[],
  stepDeg: number,
) {
  // One square fill polygon per cell, sized to the backend's native step so
  // cells tile the bbox without gaps. Looks like a real SST heatmap.
  const half = stepDeg / 2;
  return {
    type: "FeatureCollection" as const,
    features: sst.map((p) => ({
      type: "Feature" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [[
          [p.lon - half, p.lat - half],
          [p.lon + half, p.lat - half],
          [p.lon + half, p.lat + half],
          [p.lon - half, p.lat + half],
          [p.lon - half, p.lat - half],
        ]],
      },
      properties: { tempC: p.tempC },
    })),
  };
}

function buildConeQuadFC(quads: import("../../api/live").ConeQuad[] | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (!quads) return { type: "FeatureCollection" as const, features };
  for (const q of quads) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [q.corners] },
      properties: { windKt: q.windKt },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildRingFC(rings: import("../../api/live").OuterRing[] | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (!rings) return { type: "FeatureCollection" as const, features };
  for (const r of rings) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [r.corners] },
      properties: { windKt: r.windKt },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildNHCConeFC(cone: import("../../api/live").ForecastCone | null | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (cone && cone.ring.length >= 3) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [cone.ring] },
      properties: {},
    });
  }
  return { type: "FeatureCollection" as const, features };
}

function buildSurgeFC(surge: import("../../api/live").SurgePolygon[] | undefined) {
  const features: GeoJSON.Feature[] = [];
  if (!surge) return { type: "FeatureCollection" as const, features };
  for (const s of surge) {
    if (s.ring.length < 3) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [s.ring] },
      properties: { surgeRange: s.surgeRange, color: s.color },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

interface WindMapCellProps {
  lat: number;
  lon: number;
  windKt: number;
  diff?: number;
  windDirDeg?: number | null;
  sources?: number;
  confidence?: number;
  nearestObsKm?: number | null;
  distScore?: number;
  countScore?: number;
  agreementScore?: number;
  contributorSpreadKt?: number | null;
  hasArrow?: boolean;
  /** Set on shear cells so a click does not read them as 10 m wind. */
  field?: "shear";
}

function buildWindMapFC(cells: WindMapCellProps[] | undefined, stepDeg: number) {
  // One abutting square per cell, sized to the backend's grid step. Same
  // tiling pattern as the SST layer so the map reads as a continuous
  // heatmap rather than dots.
  const half = stepDeg / 2;
  return {
    type: "FeatureCollection" as const,
    features: (cells ?? []).map((c) => ({
      type: "Feature" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [[
          [c.lon - half, c.lat - half],
          [c.lon + half, c.lat - half],
          [c.lon + half, c.lat + half],
          [c.lon - half, c.lat + half],
          [c.lon - half, c.lat - half],
        ]],
      },
      properties: {
        windKt: c.windKt,
        diff: c.diff ?? 0,
        windDirDeg: c.windDirDeg ?? null,
        sources: c.sources ?? 0,
        confidence: c.confidence ?? 0,
        nearestObsKm: c.nearestObsKm ?? null,
        distScore: c.distScore ?? 0,
        countScore: c.countScore ?? 0,
        agreementScore: c.agreementScore ?? 0,
        contributorSpreadKt: c.contributorSpreadKt ?? null,
        lat: c.lat,
        lon: c.lon,
        hasArrow: c.hasArrow ? 1 : 0,
        field: c.field ?? "",
      },
    })),
  };
}

function buildWindObsFC(
  obs: import("../../api/live").WindObs[] | undefined,
  highlighted: Set<string> | null,
) {
  return {
    type: "FeatureCollection" as const,
    features: (obs ?? []).map((o) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [o.lon, o.lat] },
      properties: {
        windKt: o.windKt,
        stationId: o.stationId,
        source: o.source,
        // 1 = visible contributor, 0 = hidden. Obs points are OFF by default
        // — they only appear when the user clicks "N sources" in a wind-map
        // cell popup, and only the stations that fed that specific cell are
        // marked visible.
        highlighted:
          highlighted === null
            ? 0
            : highlighted.has(`${o.stationId}|${o.lat}|${o.lon}`) ? 1 : 0,
      },
    })),
  };
}

/** Flatten a model grid's coords + frame arrays into the {lat, lon,
 *  windKt, windDirDeg} shape the rest of the pipeline expects. Returns
 *  null when the grid is missing or the requested frame is out of range. */
function materializeFrame(
  grid: import("../../api/live").WindModelGrid | null,
  frameIdx: number,
): Array<{ lat: number; lon: number; windKt: number; windDirDeg: number | null }> | null {
  if (!grid || grid.frames.length === 0) return null;
  const clamped = Math.min(Math.max(0, frameIdx), grid.frames.length - 1);
  const frame = grid.frames[clamped];
  if (!frame) return null;
  return grid.cells.map((c, i) => ({
    lat: c.lat,
    lon: c.lon,
    windKt: frame.windKt[i] ?? 0,
    windDirDeg: frame.windDirDeg[i] ?? null,
  }));
}

/** One shear arrow about every this many degrees. A glyph on every 0.5°
 *  cell carpets the 10 m circulation, so the storm center disappears. */
const SHEAR_ARROW_SPACING_DEG = 2;

function keepShearArrow(lat: number, lon: number, stepDeg: number): boolean {
  const step = stepDeg > 0 ? stepDeg : 0.5;
  const stride = Math.max(1, Math.round(SHEAR_ARROW_SPACING_DEG / step));
  const mod = (n: number, m: number) => ((n % m) + m) % m;
  const i = Math.round(lat / step);
  const j = Math.round(lon / step);
  return mod(i, stride) === 0 && mod(j, stride) === 0;
}

/** Shear frame for the slider hour. Null wind is a gap, not calm shear. */
function materializeShearFrame(
  grid: import("../../api/live").WindModelGrid | null,
  hour: number,
): WindMapCellProps[] | null {
  if (!grid || grid.frames.length === 0) return null;
  const frame = grid.frames.find((f) => f.hour === hour)
    ?? grid.frames.reduce((best, f) =>
      Math.abs(f.hour - hour) < Math.abs(best.hour - hour) ? f : best,
    );
  const step = grid.stepDeg || 0.5;
  const cells: WindMapCellProps[] = [];
  grid.cells.forEach((c, i) => {
    const kt = frame.windKt[i];
    if (typeof kt !== "number") return;
    const dir = frame.windDirDeg[i] ?? null;
    cells.push({
      lat: c.lat,
      lon: c.lon,
      windKt: kt,
      windDirDeg: dir,
      hasArrow: dir != null && keepShearArrow(c.lat, c.lon, step),
      field: "shear",
    });
  });
  return cells.length > 0 ? cells : null;
}

/** Half a cell of the coarser grid, diagonally, plus a little slack.
 *  A 2° model cell is more than 0.75° from the obs cells it should cover. */
function modelMatchDeg(stepA: number, stepB: number): number {
  return (Math.max(stepA, stepB) / 2) * Math.SQRT2 + 0.05;
}

/** Diff two grids. Returns one output cell per A cell that has a B match
 *  within ``matchDeg``. Cells with no counterpart are dropped. */
function computeDiffGrid(
  a: Array<{ lat: number; lon: number; windKt: number }>,
  b: Array<{ lat: number; lon: number; windKt: number }>,
  matchDeg = 0.75,
): Array<{ lat: number; lon: number; windKt: number; diff: number }> {
  const STEP = 0.5;
  const reach = Math.max(2, Math.ceil(matchDeg / STEP) + 1);
  const binKey = (lat: number, lon: number) =>
    `${Math.round(lat / STEP)}|${Math.round(lon / STEP)}`;
  const bBins = new Map<
    string,
    Array<{ lat: number; lon: number; windKt: number }>
  >();
  for (const cb of b) {
    const k = binKey(cb.lat, cb.lon);
    const list = bBins.get(k) ?? [];
    list.push(cb);
    bBins.set(k, list);
  }

  const out: Array<{ lat: number; lon: number; windKt: number; diff: number }> =
    [];
  for (const ca of a) {
    const bi = Math.round(ca.lat / STEP);
    const bj = Math.round(ca.lon / STEP);
    let best: { lat: number; lon: number; windKt: number } | null = null;
    let bestD2 = Infinity;
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        const list = bBins.get(`${bi + di}|${bj + dj}`);
        if (!list) continue;
        for (const cb of list) {
          const dlat = ca.lat - cb.lat;
          const dlon = ca.lon - cb.lon;
          const d2 = dlat * dlat + dlon * dlon;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = cb;
          }
        }
      }
    }
    if (!best || Math.sqrt(bestD2) > matchDeg) continue;
    const diff = ca.windKt - best.windKt;
    out.push({ lat: ca.lat, lon: ca.lon, windKt: diff, diff });
  }
  return out;
}

export function LiveStormLayer({ map }: Props) {
  const data = useLiveStormStore((s) => s.data);
  const showForecastHistory = useLiveStormStore((s) => s.showForecastHistory);
  const showAlerts = useLiveStormStore((s) => s.showAlerts);
  const showWatchesWarnings = useLiveStormStore((s) => s.showWatchesWarnings);
  const showBuoys = useLiveStormStore((s) => s.showBuoys);
  const showRecon = useLiveStormStore((s) => s.showRecon);
  const showLand = useLiveStormStore((s) => s.showLand);
  const showSst = useLiveStormStore((s) => s.showSst);
  const showWindField = useLiveStormStore((s) => s.showWindField);
  const showForecastCone = useLiveStormStore((s) => s.showForecastCone);
  const showSurge = useLiveStormStore((s) => s.showSurge);
  const showWindMap = useLiveStormStore((s) => s.showWindMap);
  const windMapMode = useLiveStormStore((s) => s.windMapMode);
  const gfsGrid = useLiveStormStore((s) => s.gfsGrid);
  const ecmwfGrid = useLiveStormStore((s) => s.ecmwfGrid);
  const showWindShear = useLiveStormStore((s) => s.showWindShear);
  const gfsShear = useLiveStormStore((s) => s.gfsShear);
  const ecmwfShear = useLiveStormStore((s) => s.ecmwfShear);
  const gfsShearStatus = useLiveStormStore((s) => s.gfsShearStatus);
  const ecmwfShearStatus = useLiveStormStore((s) => s.ecmwfShearStatus);
  const highlightObs = useLiveStormStore((s) => s.highlightObs);
  const frameIndex = useLiveStormStore((s) => s.windMapFrameIndex);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!map) return;
    const apply = () => {
      // ── Sources (data) — always set, even empty (no features = no draw). ──
      setSource(map, SRC_SST, buildSstFC(data?.sst ?? [], data?.sstMeta?.stepDeg ?? 0.1));
      setSource(map, SRC_ALERTS, buildAlertsFC(data?.alerts ?? []));
      setSource(map, SRC_WW, buildWatchWarnFC(data?.watchesWarnings ?? []));
      setSource(map, SRC_FORECAST_HISTORY, buildForecastHistoryFC(data?.forecasts ?? []));
      const latestForecast = (() => {
        if (!data?.forecasts.length) return [];
        const latest = data.forecasts.reduce((a, b) =>
          a.advisoryNumber >= b.advisoryNumber ? a : b,
        );
        return latest.points.map((p) => ({ lat: p.lat, lon: p.lon, windKt: p.windKt }));
      })();
      setSource(map, SRC_FORECAST_LATEST, buildLineFC(latestForecast));
      const observed = (data?.observedTrack ?? []).map((p) => ({
        lat: p.lat,
        lon: p.lon,
        windKt: p.windKt,
      }));
      setSource(map, SRC_OBSERVED, buildLineFC(observed));
      setSource(map, SRC_BUOYS, buildBuoyFC(data?.buoys ?? []));
      setSource(map, SRC_RECON, buildReconFC(data?.recon ?? []));
      setSource(map, SRC_RECON_TRACK, buildReconTrackFC(data?.recon ?? []));
      setSource(map, SRC_VORTEX, buildVortexFC(data?.vortex ?? null));
      setSource(map, SRC_LAND, buildLandFC(data?.landStations ?? []));
      setSource(map, SRC_OBS_OUTER, buildConeQuadFC(data?.observedWindField.outerCone));
      setSource(map, SRC_OBS_RINGS, buildRingFC(data?.observedWindField.outerRings));
      setSource(map, SRC_OBS_INNER, buildConeQuadFC(data?.observedWindField.innerCone));
      setSource(map, SRC_FCST_OUTER, buildConeQuadFC(data?.forecastWindField.outerCone));
      setSource(map, SRC_FCST_RINGS, buildRingFC(data?.forecastWindField.outerRings));
      setSource(map, SRC_FCST_INNER, buildConeQuadFC(data?.forecastWindField.innerCone));
      setSource(map, SRC_NHC_CONE, buildNHCConeFC(data?.forecastCone));
      setSource(map, SRC_SURGE, buildSurgeFC(data?.peakSurge));
      const jmaGeo = buildJmaFC(data?.jma);
      setSource(map, SRC_JMA_FILL, jmaGeo.fill);
      setSource(map, SRC_JMA_LINE, jmaGeo.line);
      setSource(map, SRC_JMA_LABEL, jmaGeo.label);
      // Compute the current wind-map view data based on mode. Observed grid
      // is always the baseline; model + diff modes replace or subtract it.
      const obsStep = data?.windMapMeta?.stepDeg ?? 0.25;
      const gfsStep = gfsGrid?.stepDeg || obsStep;
      const ecmwfStep = ecmwfGrid?.stepDeg || obsStep;
      const obsCells = data?.windMap ?? [];

      // Materialize model cells at the active frame index. Model grids ship
      // as `{cells: [{lat,lon}], frames: [{windKt[], windDirDeg[]}]}` for
      // wire compactness; slot in the frame's parallel arrays here so the
      // downstream builders see the flat `{lat,lon,windKt,...}` shape.
      const gfsCellsAtFrame = materializeFrame(gfsGrid, frameIndex);
      const ecmwfCellsAtFrame = materializeFrame(ecmwfGrid, frameIndex);

      // Squares are sized to the grid they came from. A 1° GFS cell drawn
      // at the 0.25° obs step is a dot with a hole around it.
      let cellsForView: WindMapCellProps[] = obsCells;
      let viewStep = obsStep;
      let isDiffView = false;
      let isShearView = false;
      if (windMapMode == null) {
        // Source toggled off. Do not fall through to the observed grid.
        cellsForView = [];
      } else if (windMapMode === "gfs" && gfsCellsAtFrame) {
        cellsForView = gfsCellsAtFrame;
        viewStep = gfsStep;
      } else if (windMapMode === "ecmwf" && ecmwfCellsAtFrame) {
        cellsForView = ecmwfCellsAtFrame;
        viewStep = ecmwfStep;
      } else if (windMapMode === "diff-obs-vs-gfs" && gfsCellsAtFrame) {
        cellsForView = computeDiffGrid(
          obsCells, gfsCellsAtFrame, modelMatchDeg(obsStep, gfsStep),
        );
        isDiffView = true;
      } else if (windMapMode === "diff-obs-vs-ecmwf" && ecmwfCellsAtFrame) {
        cellsForView = computeDiffGrid(
          obsCells, ecmwfCellsAtFrame, modelMatchDeg(obsStep, ecmwfStep),
        );
        isDiffView = true;
      } else if (windMapMode === "diff-gfs-vs-ecmwf" && gfsCellsAtFrame && ecmwfCellsAtFrame) {
        cellsForView = computeDiffGrid(
          gfsCellsAtFrame, ecmwfCellsAtFrame, modelMatchDeg(gfsStep, ecmwfStep),
        );
        viewStep = gfsStep;
        isDiffView = true;
      }
      // Shear replaces the surface fill only once that model's shear grid
      // is in hand for this slider hour. While it loads, the surface field stays up.
      if (shearViewActive({
        showWindShear,
        windMapMode,
        windMapFrameIndex: frameIndex,
        gfsGrid,
        ecmwfGrid,
        gfsShear,
        ecmwfShear,
        gfsShearStatus,
        ecmwfShearStatus,
      })) {
        const shearGrid = windMapMode === "gfs" ? gfsShear : ecmwfShear;
        const surface = windMapMode === "gfs" ? gfsGrid : ecmwfGrid;
        const nFrames = surface?.frames.length ?? 0;
        const surfaceFrame = nFrames
          ? surface!.frames[Math.min(Math.max(0, frameIndex), nFrames - 1)]
          : undefined;
        if (shearGrid && surfaceFrame) {
          const shearCells = materializeShearFrame(shearGrid, surfaceFrame.hour);
          if (shearCells) {
            cellsForView = shearCells;
            viewStep = shearGrid.stepDeg || viewStep;
            isShearView = true;
          }
        }
      }
      setSource(map, SRC_WIND_MAP, buildWindMapFC(cellsForView, viewStep));

      // Contributor obs — always populated so the click-drill-down can
      // highlight them. When no highlight is active the obs are dimmed at
      // very low opacity via the layer paint.
      const highlightKey = highlightObs
        ? new Set(
            highlightObs.map((o) => `${o.stationId}|${o.lat}|${o.lon}`),
          )
        : null;
      setSource(
        map, SRC_WIND_OBS, buildWindObsFC(data?.windObs, highlightKey),
      );

      // ── Layers (stable paint, no data-dependent opacity). Visibility is
      //    flipped via setLayoutProperty below so toggling without remounting
      //    Just Works. Stacking: SST (bottom) → alerts → forecast history →
      //    latest forecast → observed track → markers (top). ──

      // SST as small abutting fill polygons sized to backend step. Smooth
      // interpolate palette (cool blue → warm yellow → red). Reads as a
      // continuous heatmap because cells tile the bbox without gaps.
      ensureLayer(map, LAYER_SST, {
        id: LAYER_SST, type: "fill", source: SRC_SST,
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["get", "tempC"],
            16, "#1e3a8a",
            20, "#2563eb",
            24, "#22d3ee",
            26, "#a3e635",
            26.5, "#facc15",
            28, "#fb923c",
            29, "#dc2626",
            30.5, "#7f1d1d",
          ] as unknown as never,
          "fill-opacity": 0.55,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");

      ensureLayer(map, LAYER_ALERTS_FILL, {
        id: LAYER_ALERTS_FILL, type: "fill", source: SRC_ALERTS,
        paint: {
          "fill-color": [
            "match", ["get", "severity"],
            "Extreme", SEVERITY_COLOR.Extreme,
            "Severe", SEVERITY_COLOR.Severe,
            "Moderate", SEVERITY_COLOR.Moderate,
            "Minor", SEVERITY_COLOR.Minor,
            SEVERITY_COLOR.Unknown,
          ] as unknown as never,
          "fill-opacity": 0.25,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_ALERTS_LINE, {
        id: LAYER_ALERTS_LINE, type: "line", source: SRC_ALERTS,
        paint: {
          "line-color": [
            "match", ["get", "severity"],
            "Extreme", SEVERITY_COLOR.Extreme,
            "Severe", SEVERITY_COLOR.Severe,
            "Moderate", SEVERITY_COLOR.Moderate,
            "Minor", SEVERITY_COLOR.Minor,
            SEVERITY_COLOR.Unknown,
          ] as unknown as never,
          "line-width": 1.0,
          "line-opacity": 0.65,
        },
      }, "county-line");

      // NHC operational Tropical Cyclone watches / warnings. Colour comes
      // straight off the feature (pink=Hurricane Warning, cyan=TS Watch,
      // violet=Storm Surge Warning, ...) so this reads exactly like NHC's
      // own product graphics. Fill is translucent enough that overlapping
      // watch × warning at the same coastline both remain visible; the
      // outline gets the same colour but full opacity for definition.
      ensureLayer(map, LAYER_WW_FILL, {
        id: LAYER_WW_FILL, type: "fill", source: SRC_WW,
        paint: {
          "fill-color": ["get", "color"] as unknown as never,
          "fill-opacity": 0.35,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_WW_LINE, {
        id: LAYER_WW_LINE, type: "line", source: SRC_WW,
        paint: {
          "line-color": ["get", "color"] as unknown as never,
          "line-width": 1.6,
          "line-opacity": 0.95,
        },
      });

      // ── Wind-field cones: same Cat palette as historical impact. Outer
      //    R64 (asymmetric) first at low opacity, inner Rmax on top. Forecast
      //    cone uses the same style but with a dashed border on the rings so
      //    you can tell observed vs projected. ──
      ensureLayer(map, LAYER_OBS_OUTER, {
        id: LAYER_OBS_OUTER, type: "fill", source: SRC_OBS_OUTER,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.22,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_OBS_RINGS, {
        id: LAYER_OBS_RINGS, type: "fill", source: SRC_OBS_RINGS,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.22,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_OBS_INNER, {
        id: LAYER_OBS_INNER, type: "fill", source: SRC_OBS_INNER,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.55,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_FCST_OUTER, {
        id: LAYER_FCST_OUTER, type: "fill", source: SRC_FCST_OUTER,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.18,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_FCST_RINGS, {
        id: LAYER_FCST_RINGS, type: "fill", source: SRC_FCST_RINGS,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.18,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_FCST_INNER, {
        id: LAYER_FCST_INNER, type: "fill", source: SRC_FCST_INNER,
        paint: {
          "fill-color": ["step", ["get", "windKt"], ...CONE_STEP_COLOR] as unknown as never,
          "fill-opacity": 0.45,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");

      // Interpolated surface-wind heatmap. Palette switches between the
      // SSHWS-anchored speed ramp (observed / model modes) and the diverging
      // diff palette (obs-vs-model, model-vs-model). Paint is re-set on
      // every apply so switching mode updates the colors without
      // recreating the layer.
      const paintExpr = (
        isShearView ? SHEAR_COLOR : isDiffView ? WIND_DIFF_COLOR : WIND_MAP_COLOR
      ) as unknown as never;
      // Shear is a context field. Keep it lighter than the 10 m wind so
      // the official track, the coast, and the 10 m particles stay readable.
      const fillOpacity = isShearView ? 0.18 : 0.5;
      ensureLayer(map, LAYER_WIND_MAP_FILL, {
        id: LAYER_WIND_MAP_FILL, type: "fill", source: SRC_WIND_MAP,
        paint: {
          "fill-color": paintExpr,
          "fill-opacity": fillOpacity,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      if (map.getLayer(LAYER_WIND_MAP_FILL)) {
        map.setPaintProperty(LAYER_WIND_MAP_FILL, "fill-color", paintExpr);
        map.setPaintProperty(LAYER_WIND_MAP_FILL, "fill-opacity", fillOpacity);
      }
      // Same north-pointing glyph as the hunter arrows, drawn small.
      // A cell-sized arrow hides the track. Direction is meteorological
      // FROM, so +180 points downshear.
      ensureWindArrow(map);
      const shearArrowSize = [
        "interpolate", ["linear"], ["zoom"],
        3, 0.26,
        5, 0.38,
        7, 0.55,
        9, 0.75,
      ] as unknown as never;
      ensureLayer(map, LAYER_WIND_SHEAR_ARROW, {
        id: LAYER_WIND_SHEAR_ARROW, type: "symbol", source: SRC_WIND_MAP,
        filter: ["==", ["get", "hasArrow"], 1] as unknown as never,
        layout: {
          "icon-image": "hunter-wind-arrow",
          "icon-size": shearArrowSize,
          "icon-rotate": ["%", ["+", ["get", "windDirDeg"], 180], 360] as unknown as never,
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-color": "#0f172a",
          "icon-halo-color": "#ffffff",
          "icon-halo-width": 0.6,
          "icon-opacity": 0.55,
        },
      });
      if (map.getLayer(LAYER_WIND_SHEAR_ARROW)) {
        map.setLayoutProperty(LAYER_WIND_SHEAR_ARROW, "icon-size", shearArrowSize);
        map.setPaintProperty(LAYER_WIND_SHEAR_ARROW, "icon-color", "#0f172a");
        map.setPaintProperty(LAYER_WIND_SHEAR_ARROW, "icon-halo-color", "#ffffff");
        map.setPaintProperty(LAYER_WIND_SHEAR_ARROW, "icon-halo-width", 0.6);
        map.setPaintProperty(LAYER_WIND_SHEAR_ARROW, "icon-opacity", 0.55);
      }

      // Contributor observation points. Completely invisible unless the
      // user has drilled into a cell via the "N sources" link — then only
      // the stations that fed that specific cell are shown, so the map
      // stays clean during normal browsing.
      ensureLayer(map, LAYER_WIND_OBS, {
        id: LAYER_WIND_OBS, type: "circle", source: SRC_WIND_OBS,
        paint: {
          "circle-radius": 6,
          "circle-color": [
            "match", ["get", "source"],
            "buoy", "#0891b2",
            "land", "#10b981",
            "recon", "#c026d3",
            "#94a3b8",
          ] as unknown as never,
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 2,
          "circle-opacity": [
            "case",
            ["==", ["get", "highlighted"], 1], 0.95, 0,
          ] as unknown as never,
          "circle-stroke-opacity": [
            "case",
            ["==", ["get", "highlighted"], 1], 0.95, 0,
          ] as unknown as never,
        },
      });

      // JMA bulletin: yellow gale circle, red storm circle, navy forecast
      // circles. These are not an NHC cone. Empty sources draw nothing, so
      // an Atlantic storm leaves the layers in place and invisible.
      ensureLayer(map, LAYER_JMA_GALE, {
        id: LAYER_JMA_GALE, type: "fill", source: SRC_JMA_FILL,
        filter: ["==", ["get", "kind"], "gale"] as unknown as never,
        paint: { "fill-color": "#eab308", "fill-opacity": 0.16 },
      });
      ensureLayer(map, LAYER_JMA_STORM, {
        id: LAYER_JMA_STORM, type: "fill", source: SRC_JMA_FILL,
        filter: ["==", ["get", "kind"], "storm"] as unknown as never,
        paint: { "fill-color": "#dc2626", "fill-opacity": 0.22 },
      });
      ensureLayer(map, LAYER_JMA_CIRCLE, {
        id: LAYER_JMA_CIRCLE, type: "line", source: SRC_JMA_LINE,
        filter: ["==", ["get", "kind"], "probability"] as unknown as never,
        paint: {
          "line-color": "#1e3a8a",
          "line-width": 1.5,
          "line-opacity": 0.9,
          "line-dasharray": [2, 2] as unknown as never,
        },
      });
      ensureLayer(map, LAYER_JMA_TANGENT, {
        id: LAYER_JMA_TANGENT, type: "line", source: SRC_JMA_LINE,
        filter: ["==", ["get", "kind"], "tangent"] as unknown as never,
        paint: { "line-color": "#1e3a8a", "line-width": 1.2, "line-opacity": 0.85 },
      });
      ensureLayer(map, LAYER_JMA_WARN, {
        id: LAYER_JMA_WARN, type: "line", source: SRC_JMA_LINE,
        filter: ["in", ["get", "kind"], ["literal", ["storm-arc", "storm-line"]]] as unknown as never,
        paint: { "line-color": "#b91c1c", "line-width": 1.6, "line-opacity": 0.9 },
      });
      ensureLayer(map, LAYER_JMA_LABEL, {
        id: LAYER_JMA_LABEL, type: "symbol", source: SRC_JMA_LABEL,
        layout: {
          "text-field": ["get", "label"] as unknown as never,
          "text-size": 11,
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-anchor": "center",
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
        },
      });

      // NHC's official cone of uncertainty — the swept-circle envelope of
      // 60-70% forecast-track probability. Sits under the forecast line so it
      // reads as the backdrop, not the primary path.
      ensureLayer(map, LAYER_NHC_CONE_FILL, {
        id: LAYER_NHC_CONE_FILL, type: "fill", source: SRC_NHC_CONE,
        paint: {
          "fill-color": "#94a3b8",
          "fill-opacity": 0.18,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      }, "county-line");
      ensureLayer(map, LAYER_NHC_CONE_LINE, {
        id: LAYER_NHC_CONE_LINE, type: "line", source: SRC_NHC_CONE,
        paint: {
          "line-color": "#475569",
          "line-width": 1.4,
          "line-opacity": 0.7,
          "line-dasharray": [4, 3] as unknown as never,
        },
      });

      // NHC peak-storm-surge coastal bands. Colours mirror NHC's own legend
      // (blue = 1-2 ft → red = 9+ ft). Opaque enough to be legible against
      // the SST fill and county tileset.
      ensureLayer(map, LAYER_SURGE_FILL, {
        id: LAYER_SURGE_FILL, type: "fill", source: SRC_SURGE,
        paint: {
          "fill-color": [
            "match", ["get", "color"],
            "blue", SURGE_COLOR.blue,
            "yellow", SURGE_COLOR.yellow,
            "orange", SURGE_COLOR.orange,
            "red", SURGE_COLOR.red,
            "purple", SURGE_COLOR.purple,
            SURGE_COLOR.gray,
          ] as unknown as never,
          "fill-opacity": 0.55,
          "fill-outline-color": "rgba(0,0,0,0)",
        },
      });
      ensureLayer(map, LAYER_SURGE_LINE, {
        id: LAYER_SURGE_LINE, type: "line", source: SRC_SURGE,
        paint: {
          "line-color": [
            "match", ["get", "color"],
            "blue", SURGE_COLOR.blue,
            "yellow", "#a16207",
            "orange", "#c2410c",
            "red", "#7f1d1d",
            "purple", "#4c1d95",
            SURGE_COLOR.gray,
          ] as unknown as never,
          "line-width": 0.8,
          "line-opacity": 0.9,
        },
      });

      ensureLayer(map, LAYER_FORECAST_HISTORY, {
        id: LAYER_FORECAST_HISTORY, type: "line", source: SRC_FORECAST_HISTORY,
        paint: {
          "line-color": "#475569",
          "line-width": 1.6,
          "line-dasharray": [3, 2],
          // Older advisories fade out; latest (age=0) stays brightest.
          "line-opacity": [
            "case",
            [">", ["get", "age"], 0],
            ["max", 0.05, ["-", 0.40, ["*", 0.05, ["get", "age"]]]],
            0.6,
          ] as unknown as never,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      ensureLayer(map, LAYER_FORECAST_LATEST, {
        id: LAYER_FORECAST_LATEST, type: "line", source: SRC_FORECAST_LATEST,
        paint: {
          "line-color": "#1d4ed8",
          "line-width": 3.0,
          "line-opacity": 0.85,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      ensureLayer(map, LAYER_OBSERVED, {
        id: LAYER_OBSERVED, type: "line", source: SRC_OBSERVED,
        paint: {
          // Same SSHWS swatch palette as the legend at top of the map, so
          // the observed track reads consistently with what users see in the
          // historical IBTrACS overlay. A JMA track is one colour: the
          // bulletin wind is 10-minute, not a Saffir-Simpson category.
          "line-color": ["step", ["get", "windKt"], ...SSHWS_STEP_COLOR] as unknown as never,
          "line-width": 3.5,
          "line-opacity": 0.95,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      if (map.getLayer(LAYER_OBSERVED)) {
        map.setPaintProperty(
          LAYER_OBSERVED,
          "line-color",
          (data?.jma
            ? "#0f766e"
            : ["step", ["get", "windKt"], ...SSHWS_STEP_COLOR]) as never,
        );
      }

      ensureLayer(map, LAYER_BUOYS, {
        id: LAYER_BUOYS, type: "circle", source: SRC_BUOYS,
        paint: {
          "circle-radius": 5,
          "circle-color": ["step", ["get", "windKt"], ...SSHWS_STEP_COLOR] as unknown as never,
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 1.0,
          "circle-opacity": 0.95,
          "circle-stroke-opacity": 0.95,
        },
      });

      ensureLayer(map, LAYER_RECON_TRACK, {
        id: LAYER_RECON_TRACK, type: "line", source: SRC_RECON_TRACK,
        paint: {
          "line-color": surfaceWindPaint("surfaceKt") as unknown as never,
          "line-width": [
            "interpolate", ["linear"], ["get", "surfaceKt"],
            0, 2.2,
            34, 3.6,
            64, 5.5,
            96, 7,
          ] as unknown as never,
          "line-opacity": 0.95,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      ensureWindArrow(map);
      // A session that already added the old circle layer will not pick up
      // a type change — ensureLayer returns when the id exists.
      if (map.getLayer(LAYER_RECON_LEGACY)) map.removeLayer(LAYER_RECON_LEGACY);
      const reconLayer = map.getLayer(LAYER_RECON) as { type?: string } | undefined;
      if (reconLayer && reconLayer.type !== "symbol") map.removeLayer(LAYER_RECON);
      ensureLayer(map, LAYER_RECON, {
        id: LAYER_RECON, type: "symbol", source: SRC_RECON,
        filter: ["==", ["get", "hasDir"], 1] as unknown as never,
        layout: {
          "icon-image": "hunter-wind-arrow",
          "icon-size": [
            "interpolate", ["linear"], ["get", "surfaceKt"],
            0, 0.42,
            34, 0.62,
            64, 0.86,
            96, 1.05,
          ] as unknown as never,
          // Glyph points north. Wind direction is where it comes FROM,
          // so +180 points the arrow where the air is going.
          "icon-rotate": ["%", ["+", ["get", "flDirDeg"], 180], 360] as unknown as never,
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-color": surfaceWindPaint("surfaceKt") as unknown as never,
          "icon-opacity": 0.95,
        },
      });
      ensureLayer(map, LAYER_RECON_NODIR, {
        id: LAYER_RECON_NODIR, type: "circle", source: SRC_RECON,
        filter: ["==", ["get", "hasDir"], 0] as unknown as never,
        paint: {
          "circle-radius": 4,
          "circle-color": surfaceWindPaint("surfaceKt") as unknown as never,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
          "circle-opacity": 0.9,
        },
      });
      ensureLayer(map, LAYER_RECON_TEXT, {
        id: LAYER_RECON_TEXT, type: "symbol", source: SRC_RECON,
        minzoom: 5,
        layout: {
          "text-field": [
            "concat",
            ["to-string", ["round", ["get", "surfaceKt"]]],
            " kt",
          ] as unknown as never,
          "text-size": 10,
          "text-offset": [0, -1.05] as unknown as never,
          "text-anchor": "bottom",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
        },
      });
      ensureLayer(map, LAYER_VORTEX, {
        id: LAYER_VORTEX, type: "circle", source: SRC_VORTEX,
        paint: {
          "circle-radius": 8,
          "circle-color": "#f5d0fe",
          "circle-stroke-color": "#a21caf",
          "circle-stroke-width": 2.2,
          "circle-opacity": 0.95,
        },
      });
      ensureLayer(map, LAYER_VORTEX_TEXT, {
        id: LAYER_VORTEX_TEXT, type: "symbol", source: SRC_VORTEX,
        layout: {
          "text-field": "VDM",
          "text-size": 9,
          "text-offset": [0, 1.3] as unknown as never,
          "text-anchor": "top",
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": "#86198f",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
        },
      });

      ensureLayer(map, LAYER_LAND, {
        id: LAYER_LAND, type: "circle", source: SRC_LAND,
        paint: {
          // Bumped — these were getting visually buried under the cone
          // fills, alerts, and SST. Bigger radius + white halo so they
          // pop out as the "human" indicator on top of the modelled wind
          // field. Distinct from buoys (cyan-coded) by both colour and
          // the white halo.
          "circle-radius": 6,
          "circle-color": "#10b981",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-opacity": 1.0,
          "circle-stroke-opacity": 1.0,
        },
      });

      // Wind-speed text labels right at each marker, kicking in when the
      // user zooms in past the marker-cluster zoom. text-allow-overlap=false
      // keeps the map readable; closely-spaced stations drop their label
      // rather than stacking. Halo gives contrast over the SST fill.
      ensureLayer(map, LAYER_BUOYS_TEXT, {
        id: LAYER_BUOYS_TEXT, type: "symbol", source: SRC_BUOYS,
        minzoom: OBS_LABEL_MIN_ZOOM,
        layout: {
          "text-field": [
            "concat",
            ["to-string", ["round", ["get", "windKt"]]],
            " kt",
          ] as unknown as never,
          "text-size": 10,
          "text-offset": [0, -1.1] as unknown as never,
          "text-anchor": "bottom",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#0f172a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });
      ensureLayer(map, LAYER_LAND_TEXT, {
        id: LAYER_LAND_TEXT, type: "symbol", source: SRC_LAND,
        minzoom: OBS_LABEL_MIN_ZOOM,
        layout: {
          "text-field": [
            "concat",
            ["to-string", ["round", ["get", "windKt"]]],
            " kt",
          ] as unknown as never,
          "text-size": 10,
          "text-offset": [0, -1.1] as unknown as never,
          "text-anchor": "bottom",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": "#064e3b",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      // ── Force paint order for the live overlays. MapView adds the county
      //    tileset on the later `load` event vs our `style.load`, so without
      //    explicit reordering the county choropleth ends up painted over
      //    our layers. The moveLayer calls below are idempotent and set a
      //    deterministic stack, bottom → top: wind heatmap → NHC cone →
      //    surge polygons → forecast + observed track lines. ──
      moveToTop(map, LAYER_WIND_MAP_FILL);
      moveToTop(map, LAYER_WIND_SHEAR_ARROW);
      moveToTop(map, LAYER_WIND_OBS);
      moveToTop(map, LAYER_NHC_CONE_FILL);
      moveToTop(map, LAYER_NHC_CONE_LINE);
      moveToTop(map, LAYER_SURGE_FILL);
      moveToTop(map, LAYER_SURGE_LINE);
      moveToTop(map, LAYER_WW_FILL);
      moveToTop(map, LAYER_WW_LINE);
      moveToTop(map, LAYER_JMA_GALE);
      moveToTop(map, LAYER_JMA_STORM);
      moveToTop(map, LAYER_JMA_CIRCLE);
      moveToTop(map, LAYER_JMA_TANGENT);
      moveToTop(map, LAYER_JMA_WARN);
      moveToTop(map, LAYER_JMA_LABEL);
      moveToTop(map, LAYER_FORECAST_HISTORY);
      moveToTop(map, LAYER_FORECAST_LATEST);
      moveToTop(map, LAYER_OBSERVED);
      moveToTop(map, LAYER_RECON_TRACK);
      moveToTop(map, LAYER_RECON_NODIR);
      moveToTop(map, LAYER_RECON);
      moveToTop(map, LAYER_RECON_TEXT);
      moveToTop(map, LAYER_VORTEX);
      moveToTop(map, LAYER_VORTEX_TEXT);
      // Arrows were just moved above the particle layer. Put the 10 m
      // particles back on top of the shear, under the official track.
      if (isShearView) placeWindParticlesUnderTrack(map);

      // County zoom used to drop state borders. Keep the black state stroke
      // above cones and county fills, and under the track so the line
      // doesn't paint through the advisory.
      raiseStateBoundaries(map, LAYER_FORECAST_HISTORY);

      // ── Visibility — driven purely by the panel toggles. ──
      setVis(map, LAYER_SST, showSst);
      setVis(map, LAYER_ALERTS_FILL, showAlerts);
      setVis(map, LAYER_ALERTS_LINE, showAlerts);
      setVis(map, LAYER_WW_FILL, showWatchesWarnings);
      setVis(map, LAYER_WW_LINE, showWatchesWarnings);
      setVis(map, LAYER_FORECAST_HISTORY, showForecastHistory);
      // Latest forecast + observed track always visible when a storm is loaded.
      setVis(map, LAYER_FORECAST_LATEST, true);
      setVis(map, LAYER_OBSERVED, true);
      setVis(map, LAYER_BUOYS, showBuoys);
      setVis(map, LAYER_BUOYS_TEXT, showBuoys);
      setVis(map, LAYER_RECON, showRecon);
      setVis(map, LAYER_RECON_NODIR, showRecon);
      setVis(map, LAYER_RECON_TRACK, showRecon);
      setVis(map, LAYER_RECON_TEXT, showRecon);
      setVis(map, LAYER_VORTEX, showRecon);
      setVis(map, LAYER_VORTEX_TEXT, showRecon);
      setVis(map, LAYER_LAND, showLand);
      setVis(map, LAYER_LAND_TEXT, showLand);
      setVis(map, LAYER_OBS_OUTER, showWindField);
      setVis(map, LAYER_OBS_RINGS, showWindField);
      setVis(map, LAYER_OBS_INNER, showWindField);
      setVis(map, LAYER_FCST_OUTER, showWindField);
      setVis(map, LAYER_FCST_RINGS, showWindField);
      setVis(map, LAYER_FCST_INNER, showWindField);
      setVis(map, LAYER_NHC_CONE_FILL, showForecastCone);
      setVis(map, LAYER_NHC_CONE_LINE, showForecastCone);
      setVis(map, LAYER_SURGE_FILL, showSurge);
      setVis(map, LAYER_SURGE_LINE, showSurge);
      const windPaint = showWindMap && windMapMode != null;
      setVis(map, LAYER_WIND_MAP_FILL, windPaint);
      setVis(map, LAYER_WIND_SHEAR_ARROW, windPaint);
      setVis(map, LAYER_WIND_OBS, windPaint);
      const showJma = !!data?.jma;
      setVis(map, LAYER_JMA_GALE, showJma);
      setVis(map, LAYER_JMA_STORM, showJma);
      setVis(map, LAYER_JMA_CIRCLE, showJma);
      setVis(map, LAYER_JMA_TANGENT, showJma);
      setVis(map, LAYER_JMA_WARN, showJma);
      setVis(map, LAYER_JMA_LABEL, showJma);
    };

    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
    // MapView adds the state stroke on `load`, after style.load. Seat it
    // again once that layer exists so county zoom still shows state lines.
    map.on("load", apply);
    return () => {
      map.off("load", apply);
      map.off("style.load", apply);
    };
  }, [
    map, data,
    showForecastHistory, showAlerts, showWatchesWarnings,
    showBuoys, showRecon, showLand, showSst,
    showWindField, showForecastCone, showSurge, showWindMap,
    windMapMode, gfsGrid, ecmwfGrid, highlightObs, frameIndex,
    showWindShear, gfsShear, ecmwfShear, gfsShearStatus, ecmwfShearStatus,
  ]);

  // Hover popups for buoys and land stations.
  useEffect(() => {
    if (!map) return;
    let popup: mapboxgl.Popup | null = null;
    const fmt = (v: number | null | undefined, suffix: string, digits = 0) =>
      v == null || Number.isNaN(v) ? "—" : `${Number(v).toFixed(digits)}${suffix}`;

    const onEnterBuoy = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        stationId: string;
        windKt: number | null;
        gustKt: number | null;
        pressureMb: number | null;
      };
      const mb = await import("mapbox-gl");
      popup?.remove();
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4">
            <div><strong>${p.stationId}</strong> · NDBC buoy</div>
            <div>Wind ${fmt(p.windKt, " kt")} · Gust ${fmt(p.gustKt, " kt")}</div>
            <div>Pressure ${fmt(p.pressureMb, " mb")}</div>
          </div>`,
        )
        .addTo(map);
      map.getCanvas().style.cursor = "pointer";
    };

    const onEnterRecon = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        aircraft: string;
        missionId: string;
        surfaceKt: number;
        surfaceSource: string;
        flWindKt: number | null;
        flDirDeg: number | null;
        sfmrKt: number | null;
        observedAt: string;
      };
      const mb = await import("mapbox-gl");
      popup?.remove();
      const src = p.surfaceSource === "sfmr" ? "SFMR surface" : "0.8 × flight-level";
      const when = p.observedAt ? p.observedAt.replace("T", " ").replace("Z", " UTC") : "";
      const dir = p.flDirDeg == null ? "direction n/a" : `from ${Math.round(Number(p.flDirDeg))}° · arrow downwind`;
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4">
            <div><strong>${p.aircraft || "Hunter"}</strong> · ${p.missionId || "recon"}</div>
            <div>Surface ${fmt(p.surfaceKt, " kt")} · ${src}</div>
            <div>SFMR ${fmt(p.sfmrKt, " kt")} · FL ${fmt(p.flWindKt, " kt")}</div>
            <div>${dir}</div>
            <div style="color:#64748b">${when}</div>
          </div>`,
        )
        .addTo(map);
      map.getCanvas().style.cursor = "pointer";
    };

    const onEnterVortex = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        aircraft: string;
        pressureMb: number | null;
        maxFlWindKt: number | null;
        observedAt: string;
        missionId: string;
      };
      const mb = await import("mapbox-gl");
      popup?.remove();
      const when = p.observedAt ? p.observedAt.replace("T", " ").replace("Z", " UTC") : "";
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4">
            <div><strong>Vortex fix</strong> · ${p.aircraft || "recon"}</div>
            <div>Min pressure ${fmt(p.pressureMb, " mb")}</div>
            <div>Max FL wind ${fmt(p.maxFlWindKt, " kt")}</div>
            <div style="color:#64748b">${when}</div>
          </div>`,
        )
        .addTo(map);
      map.getCanvas().style.cursor = "pointer";
    };

    const onEnterLand = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        stationId: string;
        name: string;
        windKt: number | null;
      };
      // Fetch the full record from the store so we can show gust + pressure +
      // temp without bloating the feature properties.
      const full = (
        useLiveStormStore.getState().data?.landStations ?? []
      ).find((ls) => ls.stationId === p.stationId);
      const mb = await import("mapbox-gl");
      popup?.remove();
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4;max-width:240px">
            <div><strong>${p.stationId}</strong> · NWS land station</div>
            <div style="color:#475569">${p.name ?? ""}</div>
            <div>Wind ${fmt(full?.windKt, " kt")} · Gust ${fmt(full?.gustKt, " kt")}</div>
            <div>Pressure ${fmt(full?.pressureMb, " mb")} · Temp ${fmt(full?.tempF, "°F")}</div>
          </div>`,
        )
        .addTo(map);
      map.getCanvas().style.cursor = "pointer";
    };

    const onLeave = () => {
      popup?.remove();
      popup = null;
      map.getCanvas().style.cursor = "";
    };

    const onEnterWW = async (e: mapboxgl.MapMouseEvent) => {
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        event: string;
        color: string;
        headline: string;
        areasAffected: string;
        expiresAt: string;
      };
      const mb = await import("mapbox-gl");
      popup?.remove();
      const expires = p.expiresAt
        ? new Date(p.expiresAt).toUTCString().slice(5, 22) + " UTC"
        : "—";
      popup = new mb.default.Popup({ closeButton: false, closeOnClick: false })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-size:11px;line-height:1.4;max-width:280px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
              <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${p.color}"></span>
              <strong>${p.event}</strong>
            </div>
            <div style="color:#475569;margin-bottom:4px">${p.headline}</div>
            <div style="color:#64748b;font-size:10px">Areas: ${p.areasAffected}</div>
            <div style="color:#64748b;font-size:10px">Expires: ${expires}</div>
          </div>`,
        )
        .addTo(map);
      map.getCanvas().style.cursor = "pointer";
    };

    const reg = () => {
      if (map.getLayer(LAYER_BUOYS)) {
        map.on("mouseenter", LAYER_BUOYS, onEnterBuoy as never);
        map.on("mouseleave", LAYER_BUOYS, onLeave);
      }
      if (map.getLayer(LAYER_RECON)) {
        map.on("mouseenter", LAYER_RECON, onEnterRecon as never);
        map.on("mouseleave", LAYER_RECON, onLeave);
      }
      if (map.getLayer(LAYER_RECON_NODIR)) {
        map.on("mouseenter", LAYER_RECON_NODIR, onEnterRecon as never);
        map.on("mouseleave", LAYER_RECON_NODIR, onLeave);
      }
      if (map.getLayer(LAYER_VORTEX)) {
        map.on("mouseenter", LAYER_VORTEX, onEnterVortex as never);
        map.on("mouseleave", LAYER_VORTEX, onLeave);
      }
      if (map.getLayer(LAYER_LAND)) {
        map.on("mouseenter", LAYER_LAND, onEnterLand as never);
        map.on("mouseleave", LAYER_LAND, onLeave);
      }
      if (map.getLayer(LAYER_WW_FILL)) {
        map.on("mouseenter", LAYER_WW_FILL, onEnterWW as never);
        map.on("mouseleave", LAYER_WW_FILL, onLeave);
      }
    };
    if (map.isStyleLoaded()) reg();
    else map.once("idle", reg);
    return () => {
      try {
        map.off("mouseenter", LAYER_BUOYS, onEnterBuoy as never);
        map.off("mouseleave", LAYER_BUOYS, onLeave);
        map.off("mouseenter", LAYER_RECON, onEnterRecon as never);
        map.off("mouseleave", LAYER_RECON, onLeave);
        map.off("mouseenter", LAYER_RECON_NODIR, onEnterRecon as never);
        map.off("mouseleave", LAYER_RECON_NODIR, onLeave);
        map.off("mouseenter", LAYER_VORTEX, onEnterVortex as never);
        map.off("mouseleave", LAYER_VORTEX, onLeave);
        map.off("mouseenter", LAYER_LAND, onEnterLand as never);
        map.off("mouseleave", LAYER_LAND, onLeave);
        map.off("mouseenter", LAYER_WW_FILL, onEnterWW as never);
        map.off("mouseleave", LAYER_WW_FILL, onLeave);
      } catch {
        /* layer was already torn down */
      }
      popup?.remove();
    };
  }, [map]);

  // Windy.com-style click-to-inspect on the wind heatmap. Shows the IDW
  // -interpolated obs value + confidence + a live GFS / ECMWF forecast fetch
  // so the underwriter can eyeball obs-vs-model agreement.
  useEffect(() => {
    if (!map) return;
    let popup: DraggablePopup | null = null;

    const kmh = (kt: number | null | undefined) =>
      kt == null ? null : Math.round(kt * 1.852);
    const mph = (kt: number | null | undefined) =>
      kt == null ? null : Math.round(kt * 1.15078);

    const compass = (deg: number | null | undefined): string => {
      if (deg == null || Number.isNaN(deg)) return "—";
      const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
      const i = Math.round(((deg % 360) / 22.5)) % 16;
      return `${dirs[i]} (${Math.round(deg)}°)`;
    };

    const confBadge = (c: number): string => {
      if (c >= 0.5) return `<span style="color:#166534;font-weight:600">HIGH</span>`;
      if (c >= 0.25) return `<span style="color:#a16207;font-weight:600">MED</span>`;
      return `<span style="color:#991b1b;font-weight:600">LOW</span>`;
    };

    const speedTriple = (kt: number | null | undefined) =>
      kt == null
        ? "—"
        : `<b>${kt.toFixed(0)} kt</b> · ${mph(kt)} mph · ${kmh(kt)} km/h`;

    // Open-Meteo doesn't return the model init cycle in the point-forecast
    // response, so we estimate it: both GFS and ECMWF cycle every 6 h at
    // 00Z / 06Z / 12Z / 18Z; the most recent cycle available at any moment
    // is roughly `now - typical_latency`. GFS is usually available ~4 h
    // after the cycle time; ECMWF's IFS 0.25° is delayed ~8 h. This is a
    // subtle caption, not authoritative provenance — but it lets the user
    // see roughly how fresh the forecast is.
    const estimateModelRun = (model: "gfs" | "ecmwf"): string => {
      const latencyHours = model === "gfs" ? 4 : 8;
      const now = new Date();
      const nowMs = now.getTime();
      const cycleAgeMs = latencyHours * 3_600_000;
      const cycleTime = new Date(nowMs - cycleAgeMs);
      // Snap to previous multiple of 6 hours UTC.
      const utcHours = cycleTime.getUTCHours();
      const snappedHour = Math.floor(utcHours / 6) * 6;
      cycleTime.setUTCHours(snappedHour, 0, 0, 0);
      const hh = String(cycleTime.getUTCHours()).padStart(2, "0");
      // If the cycle is today, show just "12Z run"; if yesterday, "12Z ·
      // yesterday" so the user notices if the run is stale.
      const todayUtc = new Date(nowMs);
      todayUtc.setUTCHours(0, 0, 0, 0);
      const sameDay = cycleTime.getTime() >= todayUtc.getTime();
      return sameDay ? `${hh}Z run` : `${hh}Z run · yesterday`;
    };

    // Client-side IDW at an arbitrary lat/lon using the shipped obs pool.
    // Mirrors the backend math (power = 2, radius 3°) so the "obs at click"
    // in a diff mode matches what the observed grid would show at that spot.
    const obsIdwAt = (
      lat: number,
      lon: number,
      obs: Array<import("../../api/live").WindObs>,
      radiusDeg = 3.0,
    ): number | null => {
      const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.05);
      const r2 = radiusDeg * radiusDeg;
      let wSum = 0;
      let vSum = 0;
      for (const o of obs) {
        const dlat = o.lat - lat;
        const dlon = (o.lon - lon) * cosLat;
        const d2 = dlat * dlat + dlon * dlon;
        if (d2 > r2) continue;
        const w = 1 / Math.pow(d2 + 0.01, 1);
        wSum += w;
        vSum += w * o.windKt;
      }
      return wSum > 0 ? vSum / wSum : null;
    };

    // Fill and arrow are the same cell. Both layers report the click;
    // keep the first so we don't open two popups.
    let clickBusy = false;
    const onClick = async (e: mapboxgl.MapMouseEvent) => {
      if (clickBusy) return;
      clickBusy = true;
      queueMicrotask(() => { clickBusy = false; });
      const f = (e as any).features?.[0];
      if (!f) return;
      const p = f.properties as {
        windKt: number;
        diff: number;
        windDirDeg: number | null;
        sources: number;
        confidence: number;
        nearestObsKm: number | null;
        distScore: number;
        countScore: number;
        agreementScore: number;
        contributorSpreadKt: number | null;
        lat: number;
        lon: number;
        field?: string;
      };
      const mode = useLiveStormStore.getState().windMapMode;
      const bundleData = useLiveStormStore.getState().data;
      popup?.remove();
      const container = document.createElement("div");
      container.style.cssText =
        "font-size:11px;line-height:1.5;min-width:260px;max-width:300px";
      // Shear cells are not 10 m wind. Skip the point-forecast fetch.
      if (p.field === "shear") {
        container.innerHTML = renderShearPopup(p, mode);
        popup = new DraggablePopup(map, e.lngLat).setContent(container);
        wireClosePopupClearsHighlight(popup);
        return;
      }
      // Obs value at the exact click point — used when the mode's Δ needs
      // an observed value (obs-vs-model diffs).
      const obsAtClick = bundleData
        ? obsIdwAt(e.lngLat.lat, e.lngLat.lng, bundleData.windObs)
        : null;
      container.innerHTML = renderPopupBody(p, null, false, mode, obsAtClick);
      popup = new DraggablePopup(map, e.lngLat).setContent(container);
      wireSourcesDrilldown(container, p, bundleData);
      wireClosePopupClearsHighlight(popup);

      try {
        const { fetchWindPointForecast } = await import("../../api/live");
        const forecast = await fetchWindPointForecast(e.lngLat.lat, e.lngLat.lng);
        if (popup && popup.isOpen()) {
          container.innerHTML = renderPopupBody(p, forecast, true, mode, obsAtClick);
          wireSourcesDrilldown(container, p, bundleData);
        }
      } catch {
        if (popup && popup.isOpen()) {
          container.innerHTML = renderPopupBody(p, null, true, mode, obsAtClick);
          wireSourcesDrilldown(container, p, bundleData);
        }
      }
    };

    function renderShearPopup(
      cell: { windKt: number; windDirDeg: number | null },
      mode: import("../../state/liveStorm").WindMapMode | null,
    ): string {
      const modelName = mode === "ecmwf" ? "ECMWF" : "GFS";
      const kt = cell.windKt;
      const favor = kt < 10
        ? { color: "#166534", text: "Generally favorable for a tropical cyclone (under 10 kt)." }
        : kt < 20
        ? { color: "#a16207", text: "Moderate shear (10-20 kt)." }
        : { color: "#991b1b", text: "Generally hostile for a tropical cyclone (over 20 kt)." };
      const dirLine = cell.windDirDeg == null
        ? `<div>The two levels agree, so there is no downshear direction.</div>`
        : `<div>From ${compass(cell.windDirDeg)} <span style="color:#64748b">· arrow points downshear</span></div>`;
      return [
        `<div style="font-weight:700;color:#0f172a;margin-bottom:4px">850–200 hPa shear <span style="color:#64748b;font-weight:400">· ${modelName}</span></div>`,
        `<div><b>Magnitude:</b> ${speedTriple(kt)}</div>`,
        dirLine,
        `<div style="color:${favor.color};margin-top:4px">${favor.text}</div>`,
        `<div style="color:#64748b;font-size:10px;margin-top:6px">200 hPa wind minus 850 hPa wind at this forecast hour. Not the 200 hPa wind by itself, and not a landfall or intensity forecast.</div>`,
      ].join("");
    }

    function wireSourcesDrilldown(
      container: HTMLElement,
      cell: { sources: number; lat: number; lon: number },
      bundleData: import("../../api/live").LiveStormBundle | null,
    ) {
      if (!bundleData) return;
      const link = container.querySelector<HTMLElement>("[data-sources-link]");
      if (!link) return;
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        // Filter the shipped obs pool by IDW-radius distance from the
        // cell — same math as the backend, so the highlighted set matches
        // what actually contributed.
        const idwRadiusKm = bundleData.windMapMeta.idwRadiusKm;
        const idwRadiusDeg = idwRadiusKm / 111;
        const contributors = bundleData.windObs.filter((o) => {
          const dlat = o.lat - cell.lat;
          const cosLat = Math.max(Math.cos((cell.lat * Math.PI) / 180), 0.05);
          const dlon = (o.lon - cell.lon) * cosLat;
          const d2 = dlat * dlat + dlon * dlon;
          return d2 <= idwRadiusDeg * idwRadiusDeg;
        });
        useLiveStormStore.getState().setHighlightObs(contributors);
      });
    }

    function wireClosePopupClearsHighlight(pop: DraggablePopup) {
      pop.on("close", () => {
        useLiveStormStore.getState().setHighlightObs(null);
      });
    }

    function renderPopupBody(
      obs: {
        windKt: number; diff: number; windDirDeg: number | null;
        sources: number; confidence: number; nearestObsKm: number | null;
        distScore: number; countScore: number; agreementScore: number;
        contributorSpreadKt: number | null;
      },
      forecast: import("../../api/live").PointForecast | null,
      loaded: boolean,
      mode: import("../../state/liveStorm").WindMapMode | null,
      obsAtClick: number | null,
    ): string {
      const rows: string[] = [];
      const isDiff = !!mode && mode.startsWith("diff-");
      const modeLabel: Record<string, string> = {
        "observed": "Observed (IDW blend)",
        "gfs": "GFS forecast",
        "ecmwf": "ECMWF forecast",
        "diff-obs-vs-gfs": "Obs − GFS",
        "diff-obs-vs-ecmwf": "Obs − ECMWF",
        "diff-gfs-vs-ecmwf": "GFS − ECMWF",
      };
      rows.push(
        `<div style="font-weight:700;color:#0f172a;margin-bottom:4px">Wind at point <span style="color:#64748b;font-weight:400">· ${mode ? (modeLabel[mode] ?? mode) : "Wind"}</span></div>`,
      );
      if (isDiff) {
        // Compute the Δ from the actual model / obs values at the click
        // point — same numbers the user sees in the "Model forecast" block
        // below. The cell-level diff was at the 0.5° grid center, not at
        // this exact click, and users read it as inconsistent when the two
        // sums disagree by more than a couple kt. Fall back to the cell
        // value while the forecast loads.
        const gfs = forecast?.forecasts.find((f) => f.model === "gfs") ?? null;
        const ecmwf = forecast?.forecasts.find((f) => f.model === "ecmwf") ?? null;
        let point: { a: number; b: number; aLabel: string; bLabel: string } | null = null;
        if (mode === "diff-gfs-vs-ecmwf" && gfs && ecmwf) {
          point = { a: gfs.windKt, b: ecmwf.windKt, aLabel: "GFS", bLabel: "ECMWF" };
        } else if (mode === "diff-obs-vs-gfs" && obsAtClick != null && gfs) {
          point = { a: obsAtClick, b: gfs.windKt, aLabel: "Obs", bLabel: "GFS" };
        } else if (mode === "diff-obs-vs-ecmwf" && obsAtClick != null && ecmwf) {
          point = { a: obsAtClick, b: ecmwf.windKt, aLabel: "Obs", bLabel: "ECMWF" };
        }
        if (point) {
          const delta = point.a - point.b;
          const sign = delta >= 0 ? "+" : "";
          const color = Math.abs(delta) < 3 ? "#166534" : Math.abs(delta) < 8 ? "#a16207" : "#991b1b";
          rows.push(
            `<div style="font-size:12px"><b>Δ ${point.aLabel} − ${point.bLabel}:</b> <span style="color:${color};font-weight:700">${sign}${delta.toFixed(1)} kt</span></div>`,
            `<div style="color:#64748b;font-size:10px">${point.aLabel} ${point.a.toFixed(1)} kt − ${point.bLabel} ${point.b.toFixed(1)} kt (at click point)</div>`,
          );
        } else {
          const sign = obs.diff >= 0 ? "+" : "";
          rows.push(
            `<div><b>Δ:</b> ${sign}${obs.diff.toFixed(1)} kt <span style="color:#64748b">${loaded ? "" : "(cell value while models load…)"}</span></div>`,
          );
        }
      } else {
        rows.push(
          `<div><b>${mode ? (modeLabel[mode] ?? mode) : "Wind"}:</b> ${speedTriple(obs.windKt)}</div>`,
          `<div>Direction: ${compass(obs.windDirDeg)}</div>`,
        );
      }
      // Confidence and sources only apply to the observed grid — for model
      // and diff modes the value comes from an NWP model / arithmetic, not
      // from local observations, so hide those signals.
      if (mode === "observed") {
        const distStr = obs.nearestObsKm == null
          ? "—"
          : `${obs.nearestObsKm} km`;
        rows.push(
          `<div>Confidence: ${confBadge(obs.confidence)} · <b>${(obs.confidence * 100).toFixed(0)}%</b> · nearest obs ${distStr}</div>`,
          `<div>Contributors: <a href="#" data-sources-link style="color:#2563eb;text-decoration:underline">${obs.sources} sources</a> <span style="color:#64748b">(click to highlight on map)</span></div>`,
        );
        // Score breakdown — why this cell scored what it did. Composite =
        // dist × count × agreement. If any single component drags the
        // number down, you can see which one and why.
        const spreadStr = obs.contributorSpreadKt == null
          ? "n/a"
          : `${obs.contributorSpreadKt.toFixed(1)} kt σ`;
        rows.push(
          `<details style="margin-top:2px"><summary style="font-size:10px;color:#64748b;cursor:pointer">Score breakdown</summary>` +
          `<div style="font-size:10px;color:#475569;margin-top:3px;padding-left:8px;border-left:2px solid #e2e8f0">` +
            `<div>Distance: ${(obs.distScore * 100).toFixed(0)}% <span style="color:#94a3b8">(nearest ${distStr})</span></div>` +
            `<div>Sources: ${(obs.countScore * 100).toFixed(0)}% <span style="color:#94a3b8">(${obs.sources} contributor${obs.sources === 1 ? "" : "s"})</span></div>` +
            `<div>Agreement: ${(obs.agreementScore * 100).toFixed(0)}% <span style="color:#94a3b8">(${spreadStr})</span></div>` +
            `<div style="margin-top:2px;color:#0f172a">= ${(obs.confidence * 100).toFixed(0)}% composite</div>` +
          `</div></details>`,
        );
      }
      rows.push(
        `<hr style="border:0;border-top:1px solid #e2e8f0;margin:6px 0"/>`,
      );
      // In model modes (GFS / ECMWF) the popup's top number already comes
      // from that model at the exact cell — the point-forecast fetch is
      // only needed to show the OTHER model for comparison. Filter what
      // we render so we don't repeat the mode's own value redundantly.
      const wantModels: Array<"gfs" | "ecmwf"> = (() => {
        if (mode === "gfs") return ["ecmwf"];
        if (mode === "ecmwf") return ["gfs"];
        return ["gfs", "ecmwf"];
      })();
      const modelsToShow = (forecast?.forecasts ?? []).filter((m) =>
        wantModels.includes(m.model as "gfs" | "ecmwf"),
      );

      if (!loaded) {
        rows.push(`<div style="color:#64748b">Fetching model forecasts…</div>`);
      } else if (modelsToShow.length > 0) {
        const heading =
          mode === "gfs"
            ? "Compare with ECMWF (10m)"
            : mode === "ecmwf"
            ? "Compare with GFS (10m)"
            : "Model forecast (10m)";
        rows.push(
          `<div style="font-weight:700;color:#0f172a;margin-bottom:2px">${heading}</div>`,
        );
        for (const m of modelsToShow) {
          const badge =
            m.model === "gfs"
              ? `<span style="background:#1e3a8a;color:white;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700">GFS</span>`
              : `<span style="background:#065f46;color:white;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700">ECMWF</span>`;
          const runTag = estimateModelRun(m.model as "gfs" | "ecmwf");
          rows.push(
            `<div style="margin-top:3px">${badge} ${speedTriple(m.windKt)}${
              m.windGustKt != null ? ` · gust ${m.windGustKt.toFixed(0)} kt` : ""
            }</div>`,
            `<div style="color:#475569;margin-left:38px">Dir ${compass(m.windDirDeg)} <span style="color:#94a3b8;font-size:9px">· ${runTag}</span></div>`,
          );
        }
        // Agreement hint — only meaningful in observed mode where the top
        // number represents actual obs. In model / diff modes the comparison
        // is a tautology.
        if (mode === "observed") {
          const speeds = modelsToShow.map((m) => m.windKt);
          const modelMean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
          const gap = Math.abs(obs.windKt - modelMean);
          const note =
            gap < 5
              ? `<span style="color:#166534">obs matches models</span>`
              : gap < 15
              ? `<span style="color:#a16207">obs differs from models by ${gap.toFixed(0)} kt</span>`
              : `<span style="color:#991b1b">obs differs from models by ${gap.toFixed(0)} kt — flag</span>`;
          rows.push(
            `<div style="margin-top:5px;font-size:10px">Δ vs model mean: ${note}</div>`,
          );
        }
      } else if (mode === "observed" || (!!mode && mode.startsWith("diff-"))) {
        // Only warn when the failed fetch actually breaks the popup's
        // purpose — observed mode expects models for cross-validation,
        // and diff modes need both operands. In gfs / ecmwf modes the
        // top of the popup already IS the forecast the user wanted;
        // silently omit the comparison section rather than nagging them
        // about a model they didn't ask for.
        rows.push(
          `<div style="color:#a16207;font-size:10px">Model forecasts couldn't load right now — try again in a moment.</div>`,
        );
      }
      return rows.join("");
    }

    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    const clickLayers = [LAYER_WIND_MAP_FILL, LAYER_WIND_SHEAR_ARROW];
    const reg = () => {
      for (const id of clickLayers) {
        if (!map.getLayer(id)) continue;
        map.on("click", id, onClick as never);
        map.on("mouseenter", id, onEnter);
        map.on("mouseleave", id, onLeave);
      }
    };
    if (map.isStyleLoaded()) reg();
    else map.once("idle", reg);

    return () => {
      for (const id of clickLayers) {
        try {
          map.off("click", id, onClick as never);
          map.off("mouseenter", id, onEnter);
          map.off("mouseleave", id, onLeave);
        } catch {
          /* layer torn down */
        }
      }
      popup?.remove();
    };
  }, [map]);

  return null;
}

// ───────────────────────── draggable popup ─────────────────────────

/**
 * Mapbox's built-in Popup is anchored to a lat/lon and can't be moved off
 * the anchor point — which is annoying when the popup covers the very
 * feature the user is trying to inspect. This lightweight replacement:
 *
 *  - anchors a small circle marker to the click's lat/lon (stays put as
 *    the map pans and zooms)
 *  - lets the user grab the popup's header and drag it anywhere on the
 *    map container
 *  - draws a dashed leader line from the popup's nearest edge back to
 *    the anchor so the visual connection to the data point is preserved
 *
 * DOM-only (no React), same interface shape as the existing Mapbox Popup
 * usage (open / setContent / isOpen / remove / event 'close') so the
 * calling code changes minimally.
 */
class DraggablePopup {
  private map: MbMap;
  private anchor: { lng: number; lat: number };
  private wrapper: HTMLDivElement;
  private contentBox: HTMLDivElement;
  private svg: SVGSVGElement;
  private line: SVGLineElement;
  private anchorDot: SVGCircleElement;
  // Offset from anchor (in screen px). Users drag this delta around.
  private offset: { dx: number; dy: number };
  private removed = false;
  private closeCallbacks: Array<() => void> = [];
  private mapMoveHandler = () => this.reposition();

  constructor(map: MbMap, lngLat: { lng: number; lat: number }) {
    this.map = map;
    this.anchor = { lng: lngLat.lng, lat: lngLat.lat };
    // Default: popup sits up-and-to-the-right of the anchor so the tail
    // line comes in from the lower-left. Matches how Mapbox popups
    // usually float.
    this.offset = { dx: 24, dy: -140 };

    const wrapper = document.createElement("div");
    wrapper.style.cssText = [
      "position:absolute",
      "background:white",
      "border:1px solid var(--ink-300, #cbd5e1)",
      "border-radius:4px",
      "box-shadow:0 4px 14px rgba(0,0,0,0.18)",
      "z-index:10",
      "user-select:none",
      "font-family:inherit",
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText = [
      "display:flex",
      "justify-content:space-between",
      "align-items:center",
      "padding:3px 6px 3px 8px",
      "background:#f1f5f9",
      "border-bottom:1px solid #e2e8f0",
      "cursor:move",
      "border-radius:4px 4px 0 0",
      "font-size:11px",
      "color:#64748b",
    ].join(";");
    header.title = "Drag to reposition";

    const dragGrip = document.createElement("span");
    // Six-dot drag handle glyph — clear affordance without needing an
    // icon library.
    dragGrip.textContent = "⋮⋮";
    dragGrip.style.cssText =
      "letter-spacing:-3px;color:#94a3b8;font-size:13px;line-height:1;";
    const dragLabel = document.createElement("span");
    dragLabel.textContent = "drag";
    dragLabel.style.cssText = "font-size:10px;color:#94a3b8;margin-left:4px;";
    const leftSide = document.createElement("span");
    leftSide.style.cssText = "display:flex;align-items:center";
    leftSide.appendChild(dragGrip);
    leftSide.appendChild(dragLabel);
    header.appendChild(leftSide);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.style.cssText = [
      "all:unset",
      "cursor:pointer",
      "padding:0 4px",
      "color:#64748b",
      "font-size:13px",
      "line-height:1",
    ].join(";");
    closeBtn.addEventListener("click", () => this.remove());
    header.appendChild(closeBtn);

    wrapper.appendChild(header);

    const contentBox = document.createElement("div");
    contentBox.style.cssText = "padding:6px 10px;";
    wrapper.appendChild(contentBox);

    header.addEventListener("mousedown", (e) => this.startDrag(e));
    // Clicks inside the popup shouldn't propagate to the map (would
    // otherwise trip the wind-map-fill click handler and open a new
    // popup for whatever's under the drag).
    wrapper.addEventListener("click", (e) => e.stopPropagation());
    wrapper.addEventListener("mousedown", (e) => e.stopPropagation());

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "z-index:9",
      "left:0", "top:0",
      "width:100%", "height:100%",
      "overflow:visible",
    ].join(";");
    const line = document.createElementNS(NS, "line");
    line.setAttribute("stroke", "#475569");
    line.setAttribute("stroke-width", "1.2");
    line.setAttribute("stroke-dasharray", "4 3");
    line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    const anchorDot = document.createElementNS(NS, "circle");
    anchorDot.setAttribute("r", "4");
    anchorDot.setAttribute("fill", "#0f172a");
    anchorDot.setAttribute("stroke", "white");
    anchorDot.setAttribute("stroke-width", "1.5");
    svg.appendChild(anchorDot);

    const mapContainer = this.map.getContainer();
    mapContainer.appendChild(svg);
    mapContainer.appendChild(wrapper);

    this.wrapper = wrapper;
    this.contentBox = contentBox;
    this.svg = svg;
    this.line = line;
    this.anchorDot = anchorDot;

    this.map.on("move", this.mapMoveHandler);
    // Position on next frame so the wrapper has a measured size.
    requestAnimationFrame(() => this.reposition());
  }

  /** Absolute position in the map container's coordinate space. */
  private anchorPixel(): { x: number; y: number } {
    const p = this.map.project([this.anchor.lng, this.anchor.lat]);
    return { x: p.x, y: p.y };
  }

  private reposition(): void {
    if (this.removed) return;
    const anchor = this.anchorPixel();
    const px = anchor.x + this.offset.dx;
    const py = anchor.y + this.offset.dy;
    this.wrapper.style.left = `${px}px`;
    this.wrapper.style.top = `${py}px`;

    const w = this.wrapper.offsetWidth;
    const h = this.wrapper.offsetHeight;

    // Connect the leader line to whichever edge of the popup is closest
    // to the anchor so the line reads as a natural "come from this
    // direction" rather than crossing through the popup body.
    let x2: number, y2: number;
    if (anchor.x < px) x2 = px;
    else if (anchor.x > px + w) x2 = px + w;
    else x2 = anchor.x;
    if (anchor.y < py) y2 = py;
    else if (anchor.y > py + h) y2 = py + h;
    else y2 = anchor.y;

    this.line.setAttribute("x1", String(anchor.x));
    this.line.setAttribute("y1", String(anchor.y));
    this.line.setAttribute("x2", String(x2));
    this.line.setAttribute("y2", String(y2));
    this.anchorDot.setAttribute("cx", String(anchor.x));
    this.anchorDot.setAttribute("cy", String(anchor.y));
  }

  private startDrag(e: MouseEvent): void {
    e.preventDefault();
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startOffset = { ...this.offset };
    const onMove = (ev: MouseEvent) => {
      this.offset.dx = startOffset.dx + (ev.clientX - startClientX);
      this.offset.dy = startOffset.dy + (ev.clientY - startClientY);
      this.reposition();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  setContent(content: HTMLElement | string): this {
    if (this.removed) return this;
    if (typeof content === "string") {
      this.contentBox.innerHTML = content;
    } else {
      this.contentBox.innerHTML = "";
      this.contentBox.appendChild(content);
    }
    requestAnimationFrame(() => this.reposition());
    return this;
  }

  /** Return the content container so callers can attach event listeners
   *  or querySelector into it, matching the previous pattern of holding
   *  a reference to the DOM element passed to setDOMContent. */
  getContent(): HTMLDivElement {
    return this.contentBox;
  }

  on(event: "close", cb: () => void): this {
    if (event === "close") this.closeCallbacks.push(cb);
    return this;
  }

  isOpen(): boolean {
    return !this.removed;
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.map.off("move", this.mapMoveHandler);
    try { this.wrapper.remove(); } catch { /* already gone */ }
    try { this.svg.remove(); } catch { /* already gone */ }
    this.closeCallbacks.forEach((cb) => { try { cb(); } catch { /* */ } });
    this.closeCallbacks = [];
  }
}

// ───────────────────────── helpers ─────────────────────────

function setSource(
  map: MbMap,
  id: string,
  data: GeoJSON.FeatureCollection,
): void {
  const existing = map.getSource(id) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data as never);
    return;
  }
  map.addSource(id, { type: "geojson", data: data as never });
}

function ensureLayer(
  map: MbMap,
  id: string,
  layer: mapboxgl.AnyLayer,
  beforeId?: string,
): void {
  if (map.getLayer(id)) return;
  if (beforeId && map.getLayer(beforeId)) {
    map.addLayer(layer as never, beforeId);
  } else {
    map.addLayer(layer as never);
  }
}

function setVis(map: MbMap, id: string, visible: boolean): void {
  if (!map.getLayer(id)) return;
  map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}

function moveToTop(map: MbMap, id: string): void {
  if (!map.getLayer(id)) return;
  // Two-arg form with beforeId undefined moves the layer to the very top.
  map.moveLayer(id);
}

/** Slot the state outline above wind polygons but below `beforeId` (the track). */
function raiseStateBoundaries(map: MbMap, beforeId: string): void {
  const before = map.getLayer(beforeId) ? beforeId : undefined;
  for (const id of ["state-line-casing", "state-line"]) {
    if (!map.getLayer(id)) continue;
    if (before) map.moveLayer(id, before);
    else map.moveLayer(id);
  }
}
