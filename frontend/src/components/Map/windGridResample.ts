/** Paint step for model and difference fields. The fetched grid is often
 *  0.5–1.25° because of the forecast-service budget. Drawn as squares that
 *  reads as a few giant color blocks. This resamples onto a fine lattice
 *  with bilinear weights so the same samples look like a continuous field. */
export const DISPLAY_STEP_DEG = 0.12;
const MAX_DISPLAY_CELLS = 8000;

export interface ResampleCell {
  lat: number;
  lon: number;
  windKt: number;
  diff?: number;
  windDirDeg?: number | null;
}

export function displayStepDeg(
  sourceStep: number,
  latSpan: number,
  lonSpan: number,
): number {
  if (sourceStep <= DISPLAY_STEP_DEG + 1e-6) return sourceStep;
  let step = DISPLAY_STEP_DEG;
  const count = (s: number) =>
    (Math.ceil(latSpan / s) + 1) * (Math.ceil(lonSpan / s) + 1);
  while (count(step) > MAX_DISPLAY_CELLS && step + 0.04 < sourceStep) {
    step = Math.round((step + 0.04) * 100) / 100;
  }
  return Math.min(step, sourceStep);
}

function axisIndex(values: number[]): number[] {
  const uniq = Array.from(new Set(values.map((v) => Math.round(v * 1000) / 1000)));
  uniq.sort((a, b) => a - b);
  return uniq;
}

function bracket(
  axis: number[],
  x: number,
): { i0: number; i1: number; t: number } | null {
  if (axis.length === 0) return null;
  if (x < axis[0] - 1e-4 || x > axis[axis.length - 1] + 1e-4) return null;
  let lo = 0;
  let hi = axis.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] <= x) lo = mid;
    else hi = mid;
  }
  if (lo === hi) return { i0: lo, i1: lo, t: 0 };
  const span = axis[hi] - axis[lo];
  return { i0: lo, i1: hi, t: span === 0 ? 0 : (x - axis[lo]) / span };
}

function keyOf(lat: number, lon: number): string {
  return `${lat.toFixed(3)}|${lon.toFixed(3)}`;
}

/** Bilinear resample. Missing corners are dropped and the remaining
 *  weights renormalized, so a failed fetch chunk does not punch a hole. */
export function resampleWindField<T extends ResampleCell>(
  cells: T[],
  sourceStep: number,
): { cells: T[]; step: number } {
  if (cells.length < 4) return { cells, step: sourceStep };
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const c of cells) {
    minLat = Math.min(minLat, c.lat);
    maxLat = Math.max(maxLat, c.lat);
    minLon = Math.min(minLon, c.lon);
    maxLon = Math.max(maxLon, c.lon);
  }
  const step = displayStepDeg(sourceStep, maxLat - minLat, maxLon - minLon);
  if (step >= sourceStep - 1e-6) return { cells, step: sourceStep };

  const by = new Map<string, T>();
  for (const c of cells) by.set(keyOf(c.lat, c.lon), c);
  const lats = axisIndex(cells.map((c) => c.lat));
  const lons = axisIndex(cells.map((c) => c.lon));

  const out: T[] = [];
  for (let lat = minLat; lat <= maxLat + 1e-9; lat += step) {
    const latB = bracket(lats, lat);
    if (!latB) continue;
    for (let lon = minLon; lon <= maxLon + 1e-9; lon += step) {
      const lonB = bracket(lons, lon);
      if (!lonB) continue;
      const corners: Array<{ w: number; c: T }> = [];
      const weights = [
        [(1 - latB.t) * (1 - lonB.t), latB.i0, lonB.i0],
        [(1 - latB.t) * lonB.t, latB.i0, lonB.i1],
        [latB.t * (1 - lonB.t), latB.i1, lonB.i0],
        [latB.t * lonB.t, latB.i1, lonB.i1],
      ] as const;
      let wsum = 0;
      for (const [w, iLat, iLon] of weights) {
        if (w <= 0) continue;
        const sample = by.get(keyOf(lats[iLat], lons[iLon]));
        if (!sample) continue;
        corners.push({ w, c: sample });
        wsum += w;
      }
      if (wsum <= 0) continue;
      let wind = 0;
      let diff = 0;
      let hasDiff = false;
      let u = 0;
      let v = 0;
      let uv = 0;
      for (const { w, c } of corners) {
        const ww = w / wsum;
        wind += ww * c.windKt;
        if (typeof c.diff === "number") {
          diff += ww * c.diff;
          hasDiff = true;
        }
        if (c.windDirDeg != null && Number.isFinite(c.windDirDeg)) {
          const r = (c.windDirDeg * Math.PI) / 180;
          u += ww * -Math.sin(r);
          v += ww * -Math.cos(r);
          uv += ww;
        }
      }
      let windDirDeg: number | null = null;
      if (uv > 0.5) {
        windDirDeg = Math.round(
          ((((Math.atan2(u, v) * 180) / Math.PI + 180) % 360) * 10),
        ) / 10;
      }
      const sample = corners[0].c;
      out.push({
        ...sample,
        lat: Math.round(lat * 1000) / 1000,
        lon: Math.round(lon * 1000) / 1000,
        windKt: Math.round(wind * 10) / 10,
        diff: hasDiff ? Math.round(diff * 10) / 10 : sample.diff,
        windDirDeg,
      });
    }
  }
  return out.length > 0 ? { cells: out, step } : { cells, step: sourceStep };
}
