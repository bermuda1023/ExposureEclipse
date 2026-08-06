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


@dataclass(slots=True)
class WildfireBundle:
    perimeters: list[FirePerimeter] = field(default_factory=list)
    active_fires: list[ActiveFire] = field(default_factory=list)
    affected_states: list[tuple[str, int, float]] = field(default_factory=list)  # (state, #fires, acres)
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
) -> list[FirePerimeter]:
    """Current WFIGS burn-area polygons, optionally clipped to a lon/lat bbox.
    Filters to wildfire incidents (drops prescribed burns). Fails soft."""
    key = _bbox_key(bbox)
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
    }
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


def fetch_active_fires(
    *,
    map_key: str | None,
    bbox: tuple[float, float, float, float] | None = None,
    day_range: int = 1,
) -> tuple[list[ActiveFire], str | None]:
    """NASA FIRMS thermal anomalies for the bbox. Returns (fires, note).
    ``note`` is non-None when the layer is degraded (no key / fetch failed)."""
    if not map_key:
        return [], (
            "Satellite heat layer disabled: set FIRMS_MAP_KEY (free key at "
            "https://firms.modaps.eosdis.nasa.gov/api/map_key/) to enable "
            "VIIRS/MODIS active-fire detections."
        )
    box = bbox or CONUS_BBOX
    day_range = max(1, min(day_range, 10))  # FIRMS caps at 10 days
    area = ",".join(f"{c:.4f}" for c in box)  # west,south,east,north

    key = f"{map_key[:6]}:{_bbox_key(box)}:{day_range}"
    now = time.monotonic()
    hit = _FIRMS_CACHE.get(key)
    if hit is not None and (now - hit[0]) < _FIRMS_TTL_S:
        return hit[1], None

    out: list[ActiveFire] = []
    any_ok = False
    for source in FIRMS_SOURCES:
        url = f"{FIRMS_AREA_URL}/{map_key}/{source}/{area}/{day_range}"
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
            acq_date = row.get("acq_date") or ""
            acq_time = (row.get("acq_time") or "0000").zfill(4)
            out.append(
                ActiveFire(
                    lat=lat,
                    lon=lon,
                    brightness_k=_as_float(row.get("bright_ti4") or row.get("brightness")),
                    frp_mw=_as_float(row.get("frp")),
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


# ─────────────────────────── bundle ───────────────────────────


def build_wildfire_bundle(
    *,
    map_key: str | None,
    bbox: tuple[float, float, float, float] | None = None,
    day_range: int = 1,
    include_heat: bool = True,
) -> WildfireBundle:
    """Assemble perimeters + satellite heat + affected-state roll-up."""
    bundle = WildfireBundle()
    bundle.perimeters = fetch_perimeters(bbox)

    if include_heat:
        fires, note = fetch_active_fires(map_key=map_key, bbox=bbox, day_range=day_range)
        bundle.active_fires = fires
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

    if not bundle.perimeters:
        bundle.notes.append(
            "No current WFIGS perimeters returned (upstream empty or unreachable)."
        )
    return bundle


__all__ = [
    "FirePerimeter",
    "ActiveFire",
    "WildfireBundle",
    "fetch_perimeters",
    "fetch_active_fires",
    "build_wildfire_bundle",
    "CONUS_BBOX",
]
