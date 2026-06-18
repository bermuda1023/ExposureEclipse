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

from .hurdat2 import category_for_wind
from .ibtracs import Storm, TrackPoint, lookup_rmax_nm

COUNTIES_TOPO_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json"
FETCH_TIMEOUT_S = 30
DAMAGING_WIND_MULTIPLIER = 2.5  # radius of damaging winds = multiplier × Rmax

# Counties only count as impacted if exposed to at least this sustained wind
# (knots). 85 kt sits inside Cat 2 — anything below is treated as noise.
MIN_IMPACT_WIND_KT = 85

# The wind-footprint VISUALISATION (translucent buffer on the map) spans the
# entire hurricane-strength lifecycle, including post-landfall track when the
# storm is still ≥ Cat 1. Counties only show in the impact set above
# MIN_IMPACT_WIND_KT, but the user wants to see how the wind field grew/shrank
# across the whole hurricane life.
MIN_FOOTPRINT_WIND_KT = 64  # Saffir-Simpson Cat 1 threshold

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


def rmax_nm(
    wind_kt: int,
    lat: float,
    *,
    storm_id: str | None = None,
    datetime_utc: str | None = None,
) -> tuple[float, str]:
    """Radius of maximum winds in nautical miles + the source we used.

    1. **IBTrACS** measured recon Rmax, if available for this (storm_id, time).
       Returned source ``"ibtracs"``.
    2. **Willoughby et al. (2006)** parametric estimate as fallback:

           Rmax(km) = 46.6 · exp(-0.0155 · Vmax(m/s) + 0.0169 · |lat|)

       Returned source ``"willoughby"``. Pre-1988 storms and missing fixes
       always fall back here since recon data is sparse before the modern era.

    Floors to 8 nm so very-weak/missing-wind points still get a non-zero
    radius for visualisation continuity.
    """
    observed = lookup_rmax_nm(storm_id, datetime_utc)
    if observed is not None and observed > 0:
        return max(8.0, observed), "ibtracs"
    if wind_kt <= 0:
        return 0.0, "willoughby"
    v_ms = wind_kt * 0.5144  # kt → m/s
    rmax_km = 46.6 * math.exp(-0.0155 * v_ms + 0.0169 * abs(lat))
    rmax = rmax_km / 1.852  # km → nm
    return max(8.0, rmax), "willoughby"


def _within_us_bbox(pt: TrackPoint) -> bool:
    return (
        US_BBOX_LAT[0] <= pt.lat <= US_BBOX_LAT[1]
        and US_BBOX_LON[0] <= pt.lon <= US_BBOX_LON[1]
    )


# ─────────────────────────── impact calculation ───────────────────────────


@dataclass(slots=True)
class ProgrammeContribution:
    """Per-programme slice of a single county's impacted TIV."""

    dataset_id: str
    tiv: float
    location_count: int


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
    rmax_source: str            # 'ibtracs' (recon) | 'willoughby' (formula)
    tiv: float                  # joined from the user's selection
    location_count: int
    has_data: bool             # true if any fact row exists for this county
    by_programme: list[ProgrammeContribution] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.by_programme is None:
            self.by_programme = []


@dataclass(slots=True, frozen=True)
class FootprintPoint:
    """One contributing track point in the impact footprint — the same Rmax
    we used to test counties, exposed so the frontend draws the visible
    wind-buffer from real IBTrACS-aware radii instead of recomputing."""

    lat: float
    lon: float
    wind_kt: int
    rmax_nm: float
    radius_nm: float
    rmax_source: str  # 'ibtracs' | 'willoughby'


@dataclass(slots=True, frozen=True)
class ConeQuad:
    """One tapered-quad segment of the wind-field cone between two adjacent
    footprint points. Four corners in (lon, lat) so the frontend can build a
    GeoJSON polygon directly; ``wind_kt`` drives the color via a Mapbox
    interpolate expression."""

    corners: tuple[
        tuple[float, float],  # left-of-A
        tuple[float, float],  # left-of-B
        tuple[float, float],  # right-of-B
        tuple[float, float],  # right-of-A
    ]
    wind_kt: int          # midpoint of the segment, for color interpolation
    start_wind_kt: int
    end_wind_kt: int


_NM_PER_DEG_LAT = 60.0


def _offset_latlon(
    lat: float, lon: float, distance_nm: float, bearing_deg: float
) -> tuple[float, float]:
    """Move (lat, lon) by ``distance_nm`` along compass bearing — small-distance
    flat-earth approximation. Accurate to <1% within typical Rmax distances."""
    if distance_nm <= 0:
        return lat, lon
    br = math.radians(bearing_deg)
    cos_lat = math.cos(math.radians(lat))
    d_lat = (distance_nm * math.cos(br)) / _NM_PER_DEG_LAT
    d_lon = (distance_nm * math.sin(br)) / (_NM_PER_DEG_LAT * max(cos_lat, 0.01))
    return lat + d_lat, lon + d_lon


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial compass bearing from point 1 to point 2 (degrees, 0=N, 90=E)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    y = math.sin(dlon) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _build_cone(footprint: list[FootprintPoint]) -> list[ConeQuad]:
    """Tapered quads between consecutive hurricane-strength fixes.

    Caps at each point are NOT in the cone — they're rendered as discs by the
    frontend (one ring per FootprintPoint) so corners read smoothly when the
    track turns sharply. Together: disc + quad + disc + quad + … forms a
    continuous swath colored by per-segment wind speed.
    """
    quads: list[ConeQuad] = []
    for i in range(len(footprint) - 1):
        a = footprint[i]
        b = footprint[i + 1]
        # Sanity: skip a degenerate pair at the same lat/lon (shouldn't happen
        # with IBTrACS, but defensive — we'd otherwise divide by zero in bearing).
        if a.lat == b.lat and a.lon == b.lon:
            continue
        # Skip absurd jumps (e.g. crossing the dateline or hopping basins) —
        # >300 nm between consecutive fixes is wrong for a 3-hour interp.
        gap = haversine_nm(a.lat, a.lon, b.lat, b.lon)
        if gap > 300:
            continue
        bearing = _bearing_deg(a.lat, a.lon, b.lat, b.lon)
        left_bearing = (bearing - 90.0) % 360.0
        right_bearing = (bearing + 90.0) % 360.0
        la_lat, la_lon = _offset_latlon(a.lat, a.lon, a.rmax_nm, left_bearing)
        ra_lat, ra_lon = _offset_latlon(a.lat, a.lon, a.rmax_nm, right_bearing)
        lb_lat, lb_lon = _offset_latlon(b.lat, b.lon, b.rmax_nm, left_bearing)
        rb_lat, rb_lon = _offset_latlon(b.lat, b.lon, b.rmax_nm, right_bearing)
        quads.append(
            ConeQuad(
                corners=(
                    (la_lon, la_lat),
                    (lb_lon, lb_lat),
                    (rb_lon, rb_lat),
                    (ra_lon, ra_lat),
                ),
                wind_kt=(a.wind_kt + b.wind_kt) // 2,
                start_wind_kt=a.wind_kt,
                end_wind_kt=b.wind_kt,
            )
        )
    return quads


def compute_impact(
    storm: Storm,
    *,
    multiplier: float = DAMAGING_WIND_MULTIPLIER,
) -> tuple[list[CountyImpact], list[FootprintPoint], list[ConeQuad]]:
    """Walk the storm's track and return every US county whose centroid falls
    within ``multiplier × Rmax`` of any on-land point, plus the list of
    contributing footprint points (one per >=85kt track fix in the US bbox).

    Returned counties carry NO TIV yet — that's joined in by the router from
    the user's current selection.
    """
    centroids = county_centroids()
    impacts: dict[str, CountyImpact] = {}
    footprint: list[FootprintPoint] = []

    for pt in storm.track:
        if not _within_us_bbox(pt):
            continue
        if pt.wind_kt < MIN_FOOTPRINT_WIND_KT:
            # Sub-hurricane-strength fix: skip entirely; doesn't enter footprint
            # OR county checks.
            continue
        rmax, rmax_src = rmax_nm(
            pt.wind_kt,
            pt.lat,
            storm_id=storm.storm_id,
            datetime_utc=pt.datetime_utc,
        )
        radius = rmax * multiplier
        footprint.append(
            FootprintPoint(
                lat=pt.lat,
                lon=pt.lon,
                wind_kt=pt.wind_kt,
                rmax_nm=rmax,
                radius_nm=radius,
                rmax_source=rmax_src,
            )
        )
        # County membership: only the more intense subset triggers a county hit.
        # The weaker hurricane points still appear in the visible footprint so
        # the user can see the full hurricane lifecycle.
        if pt.wind_kt < MIN_IMPACT_WIND_KT:
            continue
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
                    rmax_source=rmax_src,
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
                    existing.rmax_source = rmax_src

    cone = _build_cone(footprint)
    return sorted(impacts.values(), key=lambda i: -i.max_wind_kt), footprint, cone


def join_tiv(
    impacts: list[CountyImpact],
    facts: Iterable,
) -> list[CountyImpact]:
    """Add TIV + location_count from fact rows whose geography_id matches.

    Facts is iterable of ExposureFactNormalized — we only sum COUNTY-grain
    rows. State-grain rows are intentionally ignored here (state-rollup would
    be misleading for a county-level wind-field).

    Also produces a per-programme breakdown (``by_programme``) so the right-rail
    detail view can expand each county and show which deals contributed.
    """
    by_geo: dict[str, tuple[float, int]] = {}
    # Two-level index: geo -> dataset_id -> (tiv, loc)
    by_geo_prog: dict[str, dict[str, tuple[float, int]]] = {}
    for f in facts:
        gid = getattr(f, "geography_id", None)
        agg = getattr(f, "aggregation", None)
        if gid is None or agg != "COUNTY":
            continue
        cur_tiv, cur_loc = by_geo.get(gid, (0.0, 0))
        by_geo[gid] = (cur_tiv + (f.tiv or 0.0), cur_loc + (f.location_count or 0))
        ds_id = getattr(f, "dataset_id", "(unknown)")
        prog_map = by_geo_prog.setdefault(gid, {})
        cur_p_tiv, cur_p_loc = prog_map.get(ds_id, (0.0, 0))
        prog_map[ds_id] = (cur_p_tiv + (f.tiv or 0.0), cur_p_loc + (f.location_count or 0))

    for imp in impacts:
        if imp.geography_id in by_geo:
            tiv, loc = by_geo[imp.geography_id]
            imp.tiv = tiv
            imp.location_count = loc
            imp.has_data = True
            prog_map = by_geo_prog.get(imp.geography_id, {})
            imp.by_programme = [
                ProgrammeContribution(dataset_id=ds, tiv=t, location_count=lc)
                for ds, (t, lc) in sorted(prog_map.items(), key=lambda kv: -kv[1][0])
            ]
    return impacts
