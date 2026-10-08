/**
 * Continental US NEXRAD composite for the live-storm map.
 * Iowa Environmental Mesonet mosaics NWS WSR-88D base reflectivity (N0Q)
 * about every 5 minutes. The live offsets reach 55 minutes back.
 * Alaska, Hawaii, Japan, and Europe are outside this mosaic.
 */

const RADAR_ROOT = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0";

/** Oldest offset the live mosaic publishes, in minutes. */
export const RADAR_MAX_AGE_MIN = 55;

export function radarCovers(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= 18 && lat <= 52 && lon >= -128 && lon <= -64;
}

/** Snap an age to the 5-minute mosaic grid and keep it inside the live offsets. */
export function radarAgeMin(ageMin: number): number {
  if (!Number.isFinite(ageMin) || ageMin <= 2) return 0;
  const snapped = Math.round(ageMin / 5) * 5;
  return Math.min(RADAR_MAX_AGE_MIN, Math.max(5, snapped));
}

/** How old `frameMs` is relative to the newest scan, on the mosaic grid. */
export function radarAgeBetween(newestMs: number, frameMs: number): number {
  if (!Number.isFinite(newestMs) || !Number.isFinite(frameMs)) return 0;
  return radarAgeMin((newestMs - frameMs) / 60000);
}

export function radarTileUrl(ageMin: number, cacheKey: number): string {
  const age = radarAgeMin(ageMin);
  const layer = age === 0
    ? "nexrad-n0q-900913"
    : `nexrad-n0q-900913-m${String(age).padStart(2, "0")}m`;
  return `${RADAR_ROOT}/${layer}/{z}/{x}/{y}.png?r=${cacheKey}`;
}

/**
 * Forward reel for radar alone. Ten-minute steps back to 50 minutes,
 * which is as far as a 10-minute stride stays inside the live offsets.
 */
export function radarLoopAges(): number[] {
  const ages: number[] = [];
  for (let age = 50; age >= 0; age -= 10) ages.push(age);
  return ages;
}
