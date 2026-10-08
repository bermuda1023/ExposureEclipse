/**
 * Which geostationary bird covers a longitude, and where its tiles come
 * from. Pure: the layer does the fetch.
 *
 * GOES-East, GOES-West, and Himawari are NASA GIBS. GIBS tile order is
 * {z}/{y}/{x}, not Mapbox {z}/{x}/{y}. Meteosat and GOES-East lightning
 * stay on SSEC RealEarth. RealEarth replaces some tiles with a
 * "Size limit exceeded" notice; those are detected and not drawn.
 * A dark GOES limb is not that notice, so GIBS tiles are never filtered.
 */

export type SatId = "goes-east" | "goes-west" | "himawari" | "meteosat";
export type ImageryHost = "gibs" | "realearth";

export interface SatChoice {
  id: SatId;
  host: ImageryHost;
  /** RealEarth product id. Null when the picture is NASA GIBS. */
  product: string | null;
  /**
   * GIBS XYZ template. Null for RealEarth, which is stamped per scan.
   * Placeholders are {z}/{y}/{x}.
   */
  tiles: string | null;
  maxzoom: number;
  attribution: string;
  /** Panel label. No promise that the picture is a forecast. */
  label: string;
  note: string;
}

interface Bird {
  id: SatId;
  lon: number;
  host: ImageryHost;
  product: string | null;
  tiles: string | null;
  maxzoom: number;
  attribution: string;
  label: string;
  note: string;
}

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

function gibsTiles(layer: string, level: number, ext: "jpg" | "png"): string {
  return `${GIBS}/${layer}/default/default/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.${ext}`;
}

const GIBS_ATTR = "NASA GIBS";
const REAL_EARTH_ATTR = "SSEC RealEarth";

const BIRDS: readonly Bird[] = [
  {
    id: "goes-east",
    lon: -75.2,
    host: "gibs",
    product: null,
    tiles: gibsTiles("GOES-East_ABI_GeoColor", 7, "jpg"),
    maxzoom: 7,
    attribution: GIBS_ATTR,
    label: "GOES-East true color",
    note: "GOES-East full disk from NASA GIBS. True color by day, multispectral at night.",
  },
  {
    id: "goes-west",
    lon: -137.2,
    host: "gibs",
    product: null,
    tiles: gibsTiles("GOES-West_ABI_GeoColor", 7, "jpg"),
    maxzoom: 7,
    attribution: GIBS_ATTR,
    label: "GOES-West true color",
    note: "GOES-West full disk from NASA GIBS. True color by day, multispectral at night.",
  },
  {
    id: "himawari",
    lon: 140.7,
    host: "gibs",
    product: null,
    tiles: gibsTiles("Himawari_AHI_Band13_Clean_Infrared", 6, "png"),
    maxzoom: 6,
    attribution: GIBS_ATTR,
    label: "Himawari infrared",
    note: "Himawari clean infrared (10.4 µm), including Japan. Not true color, and not the JMA 10-minute wind.",
  },
  {
    id: "meteosat",
    lon: 0,
    host: "realearth",
    product: "Met11-SEVIRI-FD-BAND09-enh",
    tiles: null,
    maxzoom: 7,
    attribution: REAL_EARTH_ATTR,
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
  const edge = bestD > 55 ? " This point is near the edge of that disk." : "";
  return {
    id: best.id,
    host: best.host,
    product: best.product,
    tiles: best.tiles,
    maxzoom: best.maxzoom,
    attribution: best.attribution,
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

/** `2026-10-08T01:30:00Z` from the GIBS `layer-time-actual` header. */
export function formatGibsTime(iso: string | null | undefined): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return null;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** One low-zoom tile, used only to read the scan time. */
export function gibsProbeUrl(tiles: string): string {
  return tiles.replace("{z}", "0").replace("{y}", "0").replace("{x}", "0");
}

export const LATEST_URL = "https://realearth.ssec.wisc.edu/api/latest";

export interface NoticeSample {
  pixels: number;
  transparent: number;
  black: number;
  white: number;
}

/**
 * Counts used by {@link isRealEarthNotice}. A pixel is transparent below
 * alpha 20, black when each channel is below 30, and white when each
 * channel is above 170 and the channels agree. Yellow lightning is neither.
 */
export function sampleNoticePixels(data: ArrayLike<number>): NoticeSample {
  let pixels = 0;
  let transparent = 0;
  let black = 0;
  let white = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    pixels += 1;
    if (a < 20) transparent += 1;
    else if (r < 30 && g < 30 && b < 30) black += 1;
    else if (r > 170 && g > 170 && b > 170 && Math.abs(r - g) < 25 && Math.abs(g - b) < 25) {
      white += 1;
    }
  }
  return { pixels, transparent, black, white };
}

/**
 * RealEarth's size-limit notice, measured on returned tiles: an opaque
 * placard is about 98% black and 1.6% white text, and the same text on a
 * lightning tile is about 1.6% white on a transparent field. A clean GLM
 * tile has yellow flashes and no white. GeoColor is not this shape.
 */
export function isRealEarthNotice(sample: NoticeSample): boolean {
  const n = sample.pixels;
  if (!(n > 0)) return false;
  const black = sample.black / n;
  const white = sample.white / n;
  const transparent = sample.transparent / n;
  if (black > 0.9 && white > 0.004 && black + white > 0.98) return true;
  if (transparent > 0.8 && white > 0.004 && black < 0.2) return true;
  return false;
}

/** ESM source Mapbox imports as the RealEarth raster tile provider. */
export function realEarthProviderModule(): string {
  return [
    `const isRealEarthNotice = ${isRealEarthNotice.toString()};`,
    `const sampleNoticePixels = ${sampleNoticePixels.toString()};`,
    "export default class RealEarthTileProvider {",
    "  async loadTile(_tile, options) {",
    "    const res = await fetch(options.request.url, { signal: options.signal });",
    "    if (!res.ok) throw new Error('Tile ' + res.status);",
    "    const bitmap = await createImageBitmap(await res.blob());",
    "    if (typeof OffscreenCanvas !== 'function') return { data: bitmap };",
    "    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);",
    "    const ctx = canvas.getContext('2d', { willReadFrequently: true });",
    "    if (!ctx) return { data: bitmap };",
    "    ctx.drawImage(bitmap, 0, 0);",
    "    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;",
    "    if (isRealEarthNotice(sampleNoticePixels(pixels))) {",
    "      bitmap.close();",
    "      return { data: null };",
    "    }",
    "    return { data: bitmap };",
    "  }",
    "}",
  ].join("\n");
}
