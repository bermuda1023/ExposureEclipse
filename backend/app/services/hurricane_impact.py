"""Hurricane wind-field impact analysis.

Given a HURDAT2 storm, walk its on-land track points, compute the radius of
maximum winds (Rmax) for each via the Willoughby et al. (2006) approximation,
inflate to a "damaging-winds" radius (default 2.5× Rmax), and intersect that
swath against US county centroids. Returns the impacted county set joined to
the user's currently-selected portfolio TIV.

We use centroids rather than full polygon-in-radius because (a) it's >100×
faster, (b) centroid-in-radius is a good approximation for ~50 km county
diameters relative to ~50–200 km damaging-winds radii.

County centroids are computed once per cold-start from the us-atlas
topojson source (~3140 counties); the parser is self-contained here so this
module has no dependency on `backend/scripts/build_geo.py`.
"""

from __future__ import annotations

import json
import math
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache

from .hurdat2 import Storm, TrackPoint, category_for_wind

COUNTIES_TOPO_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json"
FETCH_TIMEOUT_S = 30
DAMAGING_WIND_MULTIPLIER = 2.5  # radius of damaging winds = multiplier × Rmax

# Counties only count as impacted if exposed to at least this sustained wind
# (knots). 85 kt sits inside Cat 2 — anything below is treated as noise.
MIN_IMPACT_WIND_KT = 85

# Conterminous US + PR bounding box. Track points outside this never touch
# counties we care about — saves doing 3,000 distance checks per point.
US_BBOX_LAT = (17.5, 50.0)
US_BBOX_LON = (-125.5, -65.0)


# FIPS state code → USPS postal abbreviation. Mirror of backend/scripts/build_geo.py.
STATE_FIPS_TO_USPS: dict[str, str] = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
    "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
    "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN",
    "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
    "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS",
    "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
    "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
    "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
    "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
    "56": "WY", "72": "PR",
}


@dataclass(slots=True, frozen=True)
class CountyMeta:
    geoid: str           # 5-digit FIPS, e.g. "12086"
    geography_id: str    # canonical "US-FL-12086"
    name: str
    state_usps: str
    centroid_lat: float
    centroid_lon: float


# ─────────────────────────── topojson → centroids ───────────────────────────


def _decode_arcs(topology: dict) -> list[list[tuple[float, float]]]:
    """Decode the topojson `arcs` array into absolute (lon, lat) coordinate chains."""
    transform = topology.get("transform")
    if transform is None:
        return [
            [(pt[0], pt[1]) for pt in arc] for arc in topology["arcs"]
        ]
    sx, sy = transform["scale"]
    tx, ty = transform["translate"]
    decoded: list[list[tuple[float, float]]] = []
    for arc in topology["arcs"]:
        x = y = 0
        coords: list[tuple[float, float]] = []
        for dx, dy in arc:
            x += dx
            y += dy
            coords.append((x * sx + tx, y * sy + ty))
        decoded.append(coords)
    return decoded


def _resolve_ring(arc_ids: list[int], arcs: list[list[tuple[float, float]]]) -> list[tuple[float, float]]:
    """Concatenate arcs by index (negative = reversed)."""
    ring: list[tuple[float, float]] = []
    for i, aid in enumerate(arc_ids):
        coords = arcs[~aid] if aid < 0 else arcs[aid]
        if aid < 0:
            coords = list(reversed(coords))
        if i == 0:
            ring.extend(coords)
        else:
            ring.extend(coords[1:])
    return ring


def _polygon_centroid(rings: list[list[tuple[float, float]]]) -> tuple[float, float]:
    """Shoelace centroid of a polygon (outer ring; holes ignored at this scale)."""
    outer = rings[0]
    a = cx = cy = 0.0
    n = len(outer)
    for i in range(n):
        x1, y1 = outer[i]
        x2, y2 = outer[(i + 1) % n]
        cross = x1 * y2 - x2 * y1
        a += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    a *= 0.5
    if abs(a) < 1e-12:
        # Degenerate polygon — fall back to vertex average.
        lon = sum(p[0] for p in outer) / n
        lat = sum(p[1] for p in outer) / n
        return lat, lon
    cx /= 6.0 * a
    cy /= 6.0 * a
    return cy, cx  # return (lat, lon)


def _county_geom_to_centroid(geom: dict, arcs: list) -> tuple[float, float] | None:
    if geom.get("type") == "Polygon":
        rings = [_resolve_ring(r, arcs) for r in geom["arcs"]]
        return _polygon_centroid(rings)
    if geom.get("type") == "MultiPolygon":
        # Use the largest polygon (by absolute area of the outer ring).
        biggest_area = -1.0
        biggest_rings: list[list[tuple[float, float]]] | None = None
        for poly in geom["arcs"]:
            rings = [_resolve_ring(r, arcs) for r in poly]
            outer = rings[0]
            a = 0.0
            for i in range(len(outer)):
                x1, y1 = outer[i]
                x2, y2 = outer[(i + 1) % len(outer)]
                a += x1 * y2 - x2 * y1
            if abs(a) > biggest_area:
                biggest_area = abs(a)
                biggest_rings = rings
        if biggest_rings is None:
            return None
        return _polygon_centroid(biggest_rings)
    return None


@lru_cache(maxsize=1)
def county_centroids() -> dict[str, CountyMeta]:
    """Live-fetch us-atlas counties + build a {geoid: CountyMeta} index."""
    req = urllib.request.Request(
        COUNTIES_TOPO_URL,
        headers={"User-Agent": "exposure-eclipse-impact/1.0"},
    )
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
        topo = json.load(resp)
    arcs = _decode_arcs(topo)
    obj = topo["objects"]["counties"]
    out: dict[str, CountyMeta] = {}
    for g in obj["geometries"]:
        if g.get("type") not in {"Polygon", "MultiPolygon"}:
            continue
        geoid = str(g.get("id", "")).zfill(5)
        state_fips = geoid[:2]
        usps = STATE_FIPS_TO_USPS.get(state_fips)
        if not usps:
            continue
        c = _county_geom_to_centroid(g, arcs)
        if c is None:
            continue
        lat, lon = c
        name = (g.get("properties") or {}).get("name", "")
        out[geoid] = CountyMeta(
            geoid=geoid,
            geography_id=f"US-{usps}-{geoid}",
            name=name,
            state_usps=usps,
            centroid_lat=lat,
            centroid_lon=lon,
        )
    return out


# ─────────────────────────── geometry helpers ───────────────────────────


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in nautical miles."""
    r_nm = 3440.065
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r_nm * math.asin(math.sqrt(a))


def rmax_nm(wind_kt: int, lat: float) -> float:
    """Radius of maximum winds in nautical miles via Willoughby et al. (2006):

        Rmax(km) = 46.6 · exp(-0.0155 · Vmax(m/s) + 0.0169 · |lat|)

    Returns a sane floor of 8 nm so very-weak/missing-wind points still get a
    non-zero radius for visualisation continuity.
    """
    if wind_kt <= 0:
        return 0.0
    v_ms = wind_kt * 0.5144  # kt → m/s
    rmax_km = 46.6 * math.exp(-0.0155 * v_ms + 0.0169 * abs(lat))
    rmax = rmax_km / 1.852  # km → nm
    return max(8.0, rmax)


def _within_us_bbox(pt: TrackPoint) -> bool:
    return (
        US_BBOX_LAT[0] <= pt.lat <= US_BBOX_LAT[1]
        and US_BBOX_LON[0] <= pt.lon <= US_BBOX_LON[1]
    )


# ─────────────────────────── impact calculation ───────────────────────────


@dataclass(slots=True)
class CountyImpact:
    geoid: str
    geography_id: str
    name: str
    state_usps: str
    centroid_lat: float
    centroid_lon: float
    max_wind_kt: int          # strongest wind any nearby track-point carried
    max_category: int          # Saffir-Simpson of max_wind_kt
    closest_distance_nm: float  # closest approach of the storm's eye
    rmax_at_closest_nm: float   # the Rmax we used for that point
    tiv: float                  # joined from the user's selection
    location_count: int
    has_data: bool             # true if any fact row exists for this county


def compute_impact(
    storm: Storm,
    *,
    multiplier: float = DAMAGING_WIND_MULTIPLIER,
) -> list[CountyImpact]:
    """Walk the storm's track and return every US county whose centroid falls
    within ``multiplier × Rmax`` of any on-land point.

    Returned counties carry NO TIV yet — that's joined in by the router from
    the user's current selection.
    """
    centroids = county_centroids()
    impacts: dict[str, CountyImpact] = {}

    for pt in storm.track:
        if not _within_us_bbox(pt):
            continue
        # Skip weak track points entirely: they wouldn't drive a county into
        # the impact set anyway and let us avoid 3000 distance checks per leg.
        if pt.wind_kt < MIN_IMPACT_WIND_KT:
            continue
        rmax = rmax_nm(pt.wind_kt, pt.lat)
        radius = rmax * multiplier
        # Pre-filter by a generous lat/lon box (~1 deg ≈ 60 nm) to avoid 3,000
        # haversines per track point.
        deg = radius / 50.0  # over-generous so we never miss border counties
        lat_lo, lat_hi = pt.lat - deg, pt.lat + deg
        lon_lo, lon_hi = pt.lon - deg, pt.lon + deg
        for c in centroids.values():
            if not (lat_lo <= c.centroid_lat <= lat_hi and lon_lo <= c.centroid_lon <= lon_hi):
                continue
            d = haversine_nm(pt.lat, pt.lon, c.centroid_lat, c.centroid_lon)
            if d > radius:
                continue
            existing = impacts.get(c.geoid)
            if existing is None:
                impacts[c.geoid] = CountyImpact(
                    geoid=c.geoid,
                    geography_id=c.geography_id,
                    name=c.name,
                    state_usps=c.state_usps,
                    centroid_lat=c.centroid_lat,
                    centroid_lon=c.centroid_lon,
                    max_wind_kt=pt.wind_kt,
                    max_category=category_for_wind(pt.wind_kt),
                    closest_distance_nm=d,
                    rmax_at_closest_nm=rmax,
                    tiv=0.0,
                    location_count=0,
                    has_data=False,
                )
            else:
                if pt.wind_kt > existing.max_wind_kt:
                    existing.max_wind_kt = pt.wind_kt
                    existing.max_category = category_for_wind(pt.wind_kt)
                if d < existing.closest_distance_nm:
                    existing.closest_distance_nm = d
                    existing.rmax_at_closest_nm = rmax

    return sorted(impacts.values(), key=lambda i: -i.max_wind_kt)


def join_tiv(
    impacts: list[CountyImpact],
    facts: Iterable,
) -> list[CountyImpact]:
    """Add TIV + location_count from fact rows whose geography_id matches.

    Facts is iterable of ExposureFactNormalized — we only sum COUNTY-grain
    rows. State-grain rows are intentionally ignored here (state-rollup would
    be misleading for a county-level wind-field).
    """
    by_geo: dict[str, tuple[float, int]] = {}
    for f in facts:
        gid = getattr(f, "geography_id", None)
        agg = getattr(f, "aggregation", None)
        if gid is None or agg != "COUNTY":
            continue
        cur_tiv, cur_loc = by_geo.get(gid, (0.0, 0))
        by_geo[gid] = (cur_tiv + (f.tiv or 0.0), cur_loc + (f.location_count or 0))

    for imp in impacts:
        if imp.geography_id in by_geo:
            tiv, loc = by_geo[imp.geography_id]
            imp.tiv = tiv
            imp.location_count = loc
            imp.has_data = True
    return impacts
