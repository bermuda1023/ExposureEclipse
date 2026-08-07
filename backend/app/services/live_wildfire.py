"""Live wildfire layer — real burn-area perimeters + satellite heat.

Three real, free sources combined into one bundle for the map:

1. **Burn-area perimeters** — NIFC/WFIGS *Interagency Perimeters Current*
   (ArcGIS FeatureServer, GeoJSON). Authoritative mapped fire polygons the
   incident GIS teams / IR flights publish; each polygon already joins its
   incident record (name, GIS acres, % contained, cause, origin state,
   IRWIN id). This is the "actual burn area" layer. No auth.

2. **Satellite active-fire heat** — NASA FIRMS thermal anomalies (VIIRS
   375 m + MODIS 1 km), near-real-time. Point detections with brightness
   temperature and FRP (fire radiative power). Requires a free FIRMS
   ``MAP_KEY`` (``settings.firms_map_key``); without it the heat layer comes
   back empty with a note — perimeters + incidents still work.

3. **Affected-state roll-up** — perimeters grouped by point-of-origin state,
   so the live footprint can be joined to the exposure/TIV plane later.

Caching mirrors ``marine_obs``: a module-level ``{key: (ts, data)}`` dict with
a short TTL, because WFIGS refreshes through the day and FIRMS every few hours.
Every fetch fails soft (returns empty) so one dead upstream never 500s the map.
"""

from __future__ import annotations

import csv
import io
import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

# ─────────────────────────── sources ───────────────────────────

USER_AGENT = "exposure-eclipse/1.0 (contact: support@example.invalid)"
FETCH_TIMEOUT_S = 40

# NIFC/WFIGS current interagency fire perimeters (ArcGIS Online, public).
WFIGS_PERIMETERS_URL = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    "WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query"
)

# NASA FIRMS area API (CSV). {key}/{source}/{west,south,east,north}/{days}/{date?}
FIRMS_AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
# VIIRS 375 m is the workhorse (S-NPP + both NOAA birds); MODIS 1 km for reach.
FIRMS_SOURCES: tuple[str, ...] = (
    "VIIRS_SNPP_NRT",
    "VIIRS_NOAA20_NRT",
    "MODIS_NRT",
)

# CONUS-ish default window when no bbox is supplied (west, south, east, north).
CONUS_BBOX: tuple[float, float, float, float] = (-125.0, 24.0, -66.5, 50.0)

# WFIGS attributes we surface (subset of the joined incident record).
_PERIM_FIELDS = ",".join(
    [
        "poly_IncidentName",
        "poly_GISAcres",
        "poly_IRWINID",
        "poly_DateCurrent",
        "attr_IncidentName",
        "attr_IncidentSize",
        "attr_CalculatedAcres",
        "attr_PercentContained",
        "attr_FireCause",
        "attr_FireCauseGeneral",
        "attr_FireDiscoveryDateTime",
        "attr_POOState",
        "attr_IncidentTypeCategory",
        "attr_IrwinID",
    ]
)

# Raw WFIGS perimeters are IR-mapped at extreme resolution (a single fire can
# carry 60k+ vertices → tens of MB). We ask ArcGIS to generalise server-side
# via maxAllowableOffset (in outSR degrees) so an overview overlay stays light.
# ~0.005° ≈ 550 m: shapes stay faithful, payload drops ~70×.
DEFAULT_SIMPLIFY_DEG = 0.005

# TTL caches. WFIGS updates through the day; FIRMS NRT ~ every 3 h.
_PERIM_CACHE: dict[str, tuple[float, list["FirePerimeter"]]] = {}
_PERIM_TTL_S = 10 * 60
_FIRMS_CACHE: dict[str, tuple[float, list["ActiveFire"]]] = {}
_FIRMS_TTL_S = 30 * 60


# ─────────────────────────── types ───────────────────────────


@dataclass(slots=True, frozen=True)
class FirePerimeter:
    """One mapped burn area (GeoJSON polygon) + its incident record."""

    incident_id: str          # IRWIN id (stable) or synthesized
    name: str
    gis_acres: float | None
    incident_size_acres: float | None
    percent_contained: float | None
    cause: str | None
    discovery_at: str | None  # ISO-8601 or None
    perimeter_updated_at: str | None
    state: str | None         # point-of-origin state (for exposure join)
    geometry: dict            # GeoJSON Polygon / MultiPolygon (EPSG:4326)


@dataclass(slots=True, frozen=True)
class ActiveFire:
    """One satellite thermal-anomaly detection (a 'heat' pixel)."""

    lat: float
    lon: float
    brightness_k: float | None  # brightness temperature, Kelvin
    frp_mw: float | None        # fire radiative power, megawatts
    confidence: str | None      # low/nominal/high (VIIRS) or 0-100 (MODIS)
    satellite: str
    source: str                 # VIIRS_SNPP_NRT, MODIS_NRT, ...
    acquired_at: str            # ISO-8601 (UTC)


@dataclass(slots=True, frozen=True)
class HeatShape:
    """A burn footprint we build ourselves by clustering FIRMS detections
    over a multi-day window (convex hull per spatial cluster)."""

    geometry: dict            # GeoJSON Polygon (EPSG:4326)
    detection_count: int
    max_frp_mw: float | None
    sum_frp_mw: float | None
    first_detected_at: str | None
    last_detected_at: str | None


@dataclass(slots=True)
class WildfireBundle:
    perimeters: list[FirePerimeter] = field(default_factory=list)
    active_fires: list[ActiveFire] = field(default_factory=list)
    heat_shapes: list[HeatShape] = field(default_factory=list)
    affected_states: list[tuple[str, int, float]] = field(default_factory=list)  # (state, #fires, acres)
    detections_total: int = 0   # before any display thinning
    notes: list[str] = field(default_factory=list)


# ─────────────────────────── helpers ───────────────────────────


def _epoch_ms_to_iso(v) -> str | None:
    """ArcGIS returns dates as epoch milliseconds (UTC)."""
    if v in (None, "", 0):
        return None
    try:
        return (
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(v) / 1000.0))
        )
    except (TypeError, ValueError, OverflowError):
        return None


def _as_float(v) -> float | None:
    try:
        if v in (None, ""):
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _bbox_key(bbox: tuple[float, float, float, float] | None) -> str:
    return "conus" if bbox is None else ",".join(f"{c:.3f}" for c in bbox)


# ─────────────────────────── perimeters ───────────────────────────


def fetch_perimeters(
    bbox: tuple[float, float, float, float] | None = None,
    simplify_deg: float = DEFAULT_SIMPLIFY_DEG,
) -> list[FirePerimeter]:
    """Current WFIGS burn-area polygons, optionally clipped to a lon/lat bbox.
    Geometry is generalised server-side by ``simplify_deg`` (outSR degrees;
    0 = full resolution). Filters to wildfire incidents. Fails soft."""
    key = f"{_bbox_key(bbox)}@{simplify_deg}"
    now = time.monotonic()
    hit = _PERIM_CACHE.get(key)
    if hit is not None and (now - hit[0]) < _PERIM_TTL_S:
        return hit[1]

    params: dict[str, str] = {
        "where": "1=1",
        "outFields": _PERIM_FIELDS,
        "outSR": "4326",
        "f": "geojson",
        "returnGeometry": "true",
        "geometryPrecision": "5",
    }
    if simplify_deg and simplify_deg > 0:
        params["maxAllowableOffset"] = str(simplify_deg)
    if bbox is not None:
        west, south, east, north = bbox
        params["geometry"] = f"{west},{south},{east},{north}"
        params["geometryType"] = "esriGeometryEnvelope"
        params["inSR"] = "4326"
        params["spatialRel"] = "esriSpatialRelIntersects"

    url = WFIGS_PERIMETERS_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return []

    out: list[FirePerimeter] = []
    for f in data.get("features", []) or []:
        p = f.get("properties") or {}
        geom = f.get("geometry")
        if not geom or not geom.get("coordinates"):
            continue
        # Keep wildfires only (WF); drop prescribed fire (RX) and other kinds.
        cat = (p.get("attr_IncidentTypeCategory") or "").strip().upper()
        if cat and cat not in ("WF", ""):
            continue
        name = (
            p.get("poly_IncidentName")
            or p.get("attr_IncidentName")
            or "Unnamed fire"
        )
        irwin = p.get("poly_IRWINID") or p.get("attr_IrwinID") or ""
        out.append(
            FirePerimeter(
                incident_id=irwin or f"{name}:{f.get('id', '')}",
                name=name,
                gis_acres=_as_float(p.get("poly_GISAcres")),
                incident_size_acres=_as_float(p.get("attr_IncidentSize"))
                or _as_float(p.get("attr_CalculatedAcres")),
                percent_contained=_as_float(p.get("attr_PercentContained")),
                cause=p.get("attr_FireCause") or p.get("attr_FireCauseGeneral"),
                discovery_at=_epoch_ms_to_iso(p.get("attr_FireDiscoveryDateTime")),
                perimeter_updated_at=_epoch_ms_to_iso(p.get("poly_DateCurrent")),
                state=(p.get("attr_POOState") or "").replace("US-", "") or None,
                geometry=geom,
            )
        )
    # Biggest burn areas first — that's what an underwriter scans for.
    out.sort(key=lambda fp: -(fp.gis_acres or fp.incident_size_acres or 0.0))
    _PERIM_CACHE[key] = (now, out)
    return out


# ─────────────────────────── satellite heat (FIRMS) ───────────────────────────


# The FIRMS NRT area API caps a single request at 5 days. We chain dated
# ≤5-day windows to reach longer look-backs (NRT retention easily covers 2 wk).
FIRMS_MAX_WINDOW_DAYS = 5
# NRT retention is ~2 months; we chain windows up to this. Long look-backs are
# for the "total burned this season" footprint, at the cost of latency + volume.
FIRMS_MAX_DAYS = 30

# Confidence ranking (VIIRS: l/n/h; MODIS: 0-100). Used to drop marginal
# detections (a lot of the "is that a factory?" noise sits in low confidence).
_CONF_RANK = {"low": 0, "nominal": 1, "high": 2}


def _confidence_rank(raw: str | None) -> int:
    if raw is None:
        return 1
    v = raw.strip().lower()
    if v in ("l", "low"):
        return 0
    if v in ("n", "nominal"):
        return 1
    if v in ("h", "high"):
        return 2
    # MODIS numeric 0-100.
    try:
        n = float(v)
        return 0 if n < 30 else (1 if n < 80 else 2)
    except ValueError:
        return 1


def _firms_windows(total_days: int) -> list[tuple[int, str | None]]:
    """Split a look-back into consecutive ≤5-day (chunk, start_date) windows
    ending today. Most-recent window omits the date (FIRMS 'last N days')."""
    total_days = max(1, min(total_days, FIRMS_MAX_DAYS))
    today = datetime.now(timezone.utc).date()
    windows: list[tuple[int, str | None]] = []
    remaining = total_days
    end = today
    while remaining > 0:
        chunk = min(FIRMS_MAX_WINDOW_DAYS, remaining)
        start = end - timedelta(days=chunk - 1)
        windows.append((chunk, None if end == today else start.isoformat()))
        end = start - timedelta(days=1)
        remaining -= chunk
    return windows


def fetch_active_fires(
    *,
    map_key: str | None,
    bbox: tuple[float, float, float, float] | None = None,
    day_range: int = 1,
    min_confidence: str = "nominal",
    min_frp: float = 0.0,
) -> tuple[list[ActiveFire], str | None]:
    """NASA FIRMS thermal anomalies for the bbox over ``day_range`` days
    (chained ≤5-day windows). Drops detections below ``min_confidence`` /
    ``min_frp``. Returns (fires, note); note is set when degraded."""
    if not map_key:
        return [], (
            "Satellite heat layer disabled: set FIRMS_MAP_KEY (free key at "
            "https://firms.modaps.eosdis.nasa.gov/api/map_key/) to enable "
            "VIIRS/MODIS active-fire detections."
        )
    box = bbox or CONUS_BBOX
    day_range = max(1, min(day_range, FIRMS_MAX_DAYS))
    area = ",".join(f"{c:.4f}" for c in box)  # west,south,east,north
    min_rank = _CONF_RANK.get(min_confidence, 1)

    key = f"{map_key[:6]}:{_bbox_key(box)}:{day_range}:{min_confidence}:{min_frp}"
    now = time.monotonic()
    hit = _FIRMS_CACHE.get(key)
    if hit is not None and (now - hit[0]) < _FIRMS_TTL_S:
        return hit[1], None

    out: list[ActiveFire] = []
    any_ok = False
    for source in FIRMS_SOURCES:
        for chunk, start_date in _firms_windows(day_range):
            url = f"{FIRMS_AREA_URL}/{map_key}/{source}/{area}/{chunk}"
            if start_date:
                url += f"/{start_date}"
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
                    text = r.read().decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001
                continue
            if not text or text.lstrip().lower().startswith(("invalid", "<!doctype", "<html")):
                continue
            any_ok = True
            for row in csv.DictReader(io.StringIO(text)):
                lat, lon = _as_float(row.get("latitude")), _as_float(row.get("longitude"))
                if lat is None or lon is None:
                    continue
                if _confidence_rank(row.get("confidence")) < min_rank:
                    continue
                frp = _as_float(row.get("frp"))
                if min_frp > 0 and (frp is None or frp < min_frp):
                    continue
                acq_date = row.get("acq_date") or ""
                acq_time = (row.get("acq_time") or "0000").zfill(4)
                out.append(
                    ActiveFire(
                        lat=lat,
                        lon=lon,
                        brightness_k=_as_float(row.get("bright_ti4") or row.get("brightness")),
                        frp_mw=frp,
                        confidence=(row.get("confidence") or None),
                        satellite=row.get("satellite") or source,
                        source=source,
                        acquired_at=f"{acq_date}T{acq_time[:2]}:{acq_time[2:]}:00Z"
                        if acq_date
                        else "",
                    )
                )
    if not any_ok:
        return [], "Satellite heat layer unavailable: FIRMS did not respond (check FIRMS_MAP_KEY / quota)."
    _FIRMS_CACHE[key] = (now, out)
    return out, None


# ─────────────────── heat-derived shapes (our own) ───────────────────

# Display cap for raw heat points — a 10-day CONUS pull can be 50k+ pixels,
# which bogs the map. Shapes are built from the FULL set first; only the
# returned point list is thinned (evenly strided) past this.
HEAT_POINT_DISPLAY_CAP = 8000
# Grid for clustering detections into footprints (~2.2 km); VIIRS pixels are
# ~375 m so this groups a fire's pixels without merging distant fires.
HEAT_CLUSTER_GRID_DEG = 0.02
HEAT_CLUSTER_MIN_POINTS = 5
# Finer grid for the actual footprint outline. We trace the UNION of occupied
# cells (not a convex hull), so unburned interior/concavities are NOT filled —
# a far truer "what burned" shape. ~0.01° ≈ 1.1 km ≈ sensor pixel scale.
FOOTPRINT_GRID_DEG = 0.01


def _convex_hull(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Andrew's monotone chain. Returns CCW hull (no repeat of first point)."""
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _cluster_components(
    fires: list[ActiveFire], grid_deg: float,
) -> list[tuple[set[tuple[int, int]], list[ActiveFire]]]:
    """Grid-bin detections and return connected components (8-way) as
    (cell-set, member-points). A component's cell count is its spatial extent —
    a persistent point source (factory/flare) stays 1 cell no matter how many
    detections; a spreading fire fills many cells."""
    import math

    cells: dict[tuple[int, int], list[ActiveFire]] = {}
    for a in fires:
        cells.setdefault((math.floor(a.lon / grid_deg), math.floor(a.lat / grid_deg)), []).append(a)

    seen: set[tuple[int, int]] = set()
    comps: list[tuple[set[tuple[int, int]], list[ActiveFire]]] = []
    for start in cells:
        if start in seen:
            continue
        stack = [start]
        seen.add(start)
        comp_cells: set[tuple[int, int]] = set()
        while stack:
            c = stack.pop()
            comp_cells.add(c)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (c[0] + dx, c[1] + dy)
                    if n in cells and n not in seen:
                        seen.add(n)
                        stack.append(n)
        pts = [a for c in comp_cells for a in cells[c]]
        comps.append((comp_cells, pts))
    return comps


def _footprint_geometry(pts: list[ActiveFire], g: float = FOOTPRINT_GRID_DEG) -> dict | None:
    """Trace the outline of the UNION of occupied grid cells (marching edges).
    Respects concavities and gaps — no convex-hull over-fill. Returns a GeoJSON
    Polygon/MultiPolygon, or None if degenerate."""
    import math

    cells = {(math.floor(a.lon / g), math.floor(a.lat / g)) for a in pts}
    if not cells:
        return None

    # Directed boundary edges so the burned area sits on the left (CCW outer).
    edges: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def add(a: tuple[int, int], b: tuple[int, int]) -> None:
        edges.setdefault(a, []).append(b)

    for (x, y) in cells:
        if (x, y - 1) not in cells: add((x, y), (x + 1, y))          # bottom → right
        if (x + 1, y) not in cells: add((x + 1, y), (x + 1, y + 1))  # right → up
        if (x, y + 1) not in cells: add((x + 1, y + 1), (x, y + 1))  # top → left
        if (x - 1, y) not in cells: add((x, y + 1), (x, y))          # left → down

    def simplify(ring: list[tuple[int, int]]) -> list[list[float]]:
        # Drop collinear staircase vertices, then scale to lon/lat.
        out = []
        n = len(ring)
        for i in range(n):
            a, b, c = ring[(i - 1) % n], ring[i], ring[(i + 1) % n]
            if (b[0] - a[0]) * (c[1] - a[1]) != (b[1] - a[1]) * (c[0] - a[0]):
                out.append(b)
        pts_ll = [[vx * g, vy * g] for (vx, vy) in (out or ring)]
        if pts_ll and pts_ll[0] != pts_ll[-1]:
            pts_ll.append(pts_ll[0])
        return pts_ll

    rings: list[list[list[float]]] = []
    while edges:
        start = next(iter(edges))
        ring = [start]
        cur = start
        guard = 0
        while True:
            nxts = edges.get(cur)
            if not nxts:
                break
            nxt = nxts.pop()
            if not nxts:
                edges.pop(cur, None)
            ring.append(nxt)
            cur = nxt
            guard += 1
            if cur == start or guard > 200_000:
                break
        if len(ring) >= 4:
            r = simplify(ring[:-1] if ring[0] == ring[-1] else ring)
            if len(r) >= 4:
                rings.append(r)

    if not rings:
        return None

    # Nest interior rings as HOLES (unburned pockets) rather than filled
    # polygons. A ring contained by an odd number of others is a hole; assign
    # it to the smallest ring that contains it. Outers keep their holes.
    def area(r: list[list[float]]) -> float:
        s = 0.0
        for i in range(len(r) - 1):
            s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]
        return abs(s) / 2.0

    def contains(outer: list[list[float]], pt: list[float]) -> bool:
        x, y = pt
        inside = False
        n = len(outer)
        j = n - 1
        for i in range(n):
            xi, yi = outer[i]
            xj, yj = outer[j]
            if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi):
                inside = not inside
            j = i
        return inside

    n = len(rings)
    depth = [0] * n            # how many other rings contain this one
    parent = [-1] * n          # smallest containing ring
    for i in range(n):
        pt = rings[i][0]
        best_area = float("inf")
        for k in range(n):
            if k == i:
                continue
            if contains(rings[k], pt):
                depth[i] += 1
                a = area(rings[k])
                if a < best_area:
                    best_area = a
                    parent[i] = k

    polys: dict[int, list[list[list[float]]]] = {}
    for i in range(n):
        if depth[i] % 2 == 0:            # outer ring
            polys.setdefault(i, [rings[i]])
    for i in range(n):
        if depth[i] % 2 == 1 and parent[i] in polys:  # hole → its outer
            polys[parent[i]].append(rings[i])

    coords = list(polys.values())
    if not coords:
        return None
    if len(coords) == 1:
        return {"type": "Polygon", "coordinates": coords[0]}
    return {"type": "MultiPolygon", "coordinates": coords}


def _shape_from_points(pts: list[ActiveFire]) -> HeatShape | None:
    geom = _footprint_geometry(pts)
    if geom is None:
        hull = _convex_hull([(a.lon, a.lat) for a in pts])
        if len(hull) < 3:
            return None
        ring = [[x, y] for (x, y) in hull]
        ring.append(ring[0])
        geom = {"type": "Polygon", "coordinates": [ring]}
    frps = [a.frp_mw for a in pts if a.frp_mw is not None]
    acqs = sorted(a.acquired_at for a in pts if a.acquired_at)
    return HeatShape(
        geometry=geom,
        detection_count=len(pts),
        max_frp_mw=max(frps) if frps else None,
        sum_frp_mw=sum(frps) if frps else None,
        first_detected_at=acqs[0] if acqs else None,
        last_detected_at=acqs[-1] if acqs else None,
    )


def cluster_heat_shapes(
    fires: list[ActiveFire],
    *,
    grid_deg: float = HEAT_CLUSTER_GRID_DEG,
    min_points: int = HEAT_CLUSTER_MIN_POINTS,
    min_cells: int = 1,
) -> list[HeatShape]:
    """Convex-hull footprint per qualifying cluster. Clusters below
    ``min_points`` detections or ``min_cells`` spatial extent are dropped
    (removes factories/flares and one-off tiny detections). Pure Python."""
    if not fires:
        return []
    shapes: list[HeatShape] = []
    for comp_cells, pts in _cluster_components(fires, grid_deg):
        if len(pts) < min_points or len(comp_cells) < min_cells:
            continue
        s = _shape_from_points(pts)
        if s is not None:
            shapes.append(s)
    shapes.sort(key=lambda s: -s.detection_count)
    return shapes


def _thin(fires: list[ActiveFire], cap: int) -> list[ActiveFire]:
    if len(fires) <= cap:
        return fires
    stride = len(fires) / cap
    return [fires[int(i * stride)] for i in range(cap)]


# ─────────────────────────── bundle ───────────────────────────


def build_wildfire_bundle(
    *,
    map_key: str | None,
    bbox: tuple[float, float, float, float] | None = None,
    day_range: int = 1,
    include_heat: bool = True,
    simplify_deg: float = DEFAULT_SIMPLIFY_DEG,
    min_cells: int = 1,
    min_detections: int = 1,
    min_confidence: str = "nominal",
    min_frp: float = 0.0,
    include_perimeters: bool = True,
) -> WildfireBundle:
    """Assemble perimeters + satellite heat + affected-state roll-up.
    Perimeters and heat are independent so callers can fetch the fast layer
    (perimeters) without waiting on the slow one (FIRMS).

    Small-hotspot cleanup: detections below ``min_confidence``/``min_frp`` are
    dropped up front; then clusters below ``min_cells`` (spatial extent) or
    ``min_detections`` are discarded — this removes factories/flares (1 cell,
    high count) and one-off tiny fires. Both the returned points and the heat
    shapes come from the surviving clusters."""
    bundle = WildfireBundle()
    if include_perimeters:
        bundle.perimeters = fetch_perimeters(bbox, simplify_deg=simplify_deg)

    if include_heat:
        fires, note = fetch_active_fires(
            map_key=map_key, bbox=bbox, day_range=day_range,
            min_confidence=min_confidence, min_frp=min_frp,
        )
        bundle.detections_total = len(fires)
        # Cluster once; keep only qualifying clusters. Shapes + displayed
        # points both derive from them, so "cleaning" applies consistently.
        kept_points: list[ActiveFire] = []
        shapes: list[HeatShape] = []
        for comp_cells, pts in _cluster_components(fires, HEAT_CLUSTER_GRID_DEG):
            if len(pts) < min_detections or len(comp_cells) < min_cells:
                continue
            kept_points.extend(pts)
            s = _shape_from_points(pts)
            if s is not None:
                shapes.append(s)
        shapes.sort(key=lambda s: -s.detection_count)
        bundle.heat_shapes = shapes
        bundle.active_fires = _thin(kept_points, HEAT_POINT_DISPLAY_CAP)
        dropped = len(fires) - len(kept_points)
        if dropped > 0:
            bundle.notes.append(
                f"Cleaned {dropped:,} small/low-confidence detections "
                f"(factories, one-off hotspots); kept {len(kept_points):,}."
            )
        if len(bundle.active_fires) < len(kept_points):
            bundle.notes.append(
                f"Showing {len(bundle.active_fires):,} of {len(kept_points):,} "
                f"detections (thinned for display); shapes use all of them."
            )
        if note:
            bundle.notes.append(note)

    # Affected-state roll-up from perimeters (join key for exposure/TIV).
    agg: dict[str, list[float]] = {}
    for fp in bundle.perimeters:
        if not fp.state:
            continue
        acres = fp.gis_acres or fp.incident_size_acres or 0.0
        cur = agg.setdefault(fp.state, [0.0, 0.0])
        cur[0] += 1
        cur[1] += acres
    bundle.affected_states = sorted(
        [(st, int(v[0]), v[1]) for st, v in agg.items()],
        key=lambda t: -t[2],
    )

    if include_perimeters and not bundle.perimeters:
        bundle.notes.append(
            "No current WFIGS perimeters returned (upstream empty or unreachable)."
        )
    return bundle


__all__ = [
    "FirePerimeter",
    "ActiveFire",
    "HeatShape",
    "WildfireBundle",
    "fetch_perimeters",
    "fetch_active_fires",
    "cluster_heat_shapes",
    "build_wildfire_bundle",
    "CONUS_BBOX",
]
