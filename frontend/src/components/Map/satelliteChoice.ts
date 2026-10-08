/**
 * Which geostationary bird covers a longitude, and how RealEarth tiles
 * are addressed. Pure: the layer does the fetch.
 *
 * Birds are the operational full disks (sub-satellite points, degrees
 * east). The nearest disk wins. Meteosat is enhanced infrared, not true
 * color — RealEarth does not publish a Meteosat true-color tile.
 */

export type SatId = "goes-east" | "goes-west" | "himawari" | "meteosat";

export interface SatChoice {
  id: SatId;
  product: string;
  /** Panel label. No promise that the picture is a forecast. */
  label: string;
  note: string;
}

interface Bird {
  id: SatId;
  lon: number;
  product: string;
  label: string;
  note: string;
}

const BIRDS: readonly Bird[] = [
  {
    id: "goes-east",
    lon: -75.2,
    product: "G19-ABI-FD-true-color",
    label: "GOES-East true color",
    note: "GOES-19 full disk. True color by day, multispectral at night.",
  },
  {
    id: "goes-west",
    lon: -137.2,
    product: "G18-ABI-FD-true-color",
    label: "GOES-West true color",
    note: "GOES-18 full disk. True color by day, multispectral at night.",
  },
  {
    id: "himawari",
    lon: 140.7,
    product: "HIMAWARI-true-color",
    label: "Himawari true color",
    note: "Himawari full disk, including Japan. True color, not the JMA 10-minute wind.",
  },
  {
    id: "meteosat",
    lon: 0,
    product: "Met11-SEVIRI-FD-BAND09-enh",
    label: "Meteosat infrared",
    note: "Meteosat-11 enhanced clean infrared (10.8 µm). Not true color. Europe, Africa, and the eastern Atlantic.",
  },
];

/** GOES-East GLM full-disk product on RealEarth. Optical groups, not strikes. */
export const GLM_PRODUCT = "glmgroupdensity";

const GLM_SUBPOINT = -75.2;
/** Inside this many degrees of the subpoint the East disk still sees flashes. */
const GLM_REACH_DEG = 60;

const TILE_ROOT = "https://realearth.ssec.wisc.edu/tiles";

export function wrapLon(lon: number): number {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function angularDegrees(a: number, b: number): number {
  const d = Math.abs(wrapLon(a) - wrapLon(b)) % 360;
  return Math.min(d, 360 - d);
}

export function satelliteFor(lon: number): SatChoice {
  const x = wrapLon(lon);
  let best = BIRDS[0];
  let bestD = angularDegrees(x, best.lon);
  for (const bird of BIRDS) {
    const d = angularDegrees(x, bird.lon);
    if (d < bestD) {
      best = bird;
      bestD = d;
    }
  }
  const edge = bestD > 55
    ? " This point is near the edge of that disk."
    : "";
  return {
    id: best.id,
    product: best.product,
    label: best.label,
    note: best.note + edge,
  };
}

/** GOES-East GLM only. Japan and Europe are outside this disk. */
export function glmCovers(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 55) return false;
  return angularDegrees(lon, GLM_SUBPOINT) <= GLM_REACH_DEG;
}

/** `20261008.005021` → path segment `20261008/005021`. Null if unusable. */
export function stampPath(stamp: string | null | undefined): string | null {
  if (!stamp || !/^\d{8}\.\d{6}$/.test(stamp)) return null;
  const [day, clock] = stamp.split(".");
  return `${day}/${clock}`;
}

export function tileTemplate(product: string, stamp: string | null): string {
  const path = stampPath(stamp);
  if (!path) return `${TILE_ROOT}/${product}/{z}/{x}/{y}.png`;
  return `${TILE_ROOT}/${product}/${path}/{z}/{x}/{y}.png`;
}

/** `20261008.005021` → `2026-10-08 00:50 UTC`. */
export function formatStamp(stamp: string | null | undefined): string | null {
  const path = stampPath(stamp);
  if (!path || !stamp) return null;
  const day = stamp.slice(0, 8);
  const clock = stamp.slice(9, 13);
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)} ${clock.slice(0, 2)}:${clock.slice(2, 4)} UTC`;
}

export const LATEST_URL = "https://realearth.ssec.wisc.edu/api/latest";
