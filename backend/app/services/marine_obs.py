"""Marine + surface weather observations from NOAA.

Two sources, both free + no auth:

- **NDBC** (National Data Buoy Center) latest_obs.txt — one fixed-width
  file with every station's latest fix; ~900 stations Atlantic + global.
- **NWS observations** via api.weather.gov — METAR/airport surface
  observations near a point.

Both are filtered down to a bounding box so the response stays small
when overlaid alongside a hurricane's forecast cone.
"""

from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from functools import lru_cache

NDBC_LATEST_URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
NWS_STATIONS_URL = "https://api.weather.gov/stations"
NWS_USER_AGENT = "exposure-eclipse/1.0 (contact: support@example.invalid)"
FETCH_TIMEOUT_S = 30


@dataclass(slots=True, frozen=True)
class BuoyObservation:
    station_id: str
    lat: float
    lon: float
    wind_kt: float | None
    wind_dir_deg: float | None
    gust_kt: float | None
    wave_height_ft: float | None
    pressure_mb: float | None
    air_temp_f: float | None
    water_temp_f: float | None
    observed_at: str           # ISO; UTC


@dataclass(slots=True, frozen=True)
class LandObservation:
    station_id: str
    name: str
    lat: float
    lon: float
    wind_kt: float | None
    wind_dir_deg: float | None
    gust_kt: float | None
    pressure_mb: float | None
    temp_f: float | None
    observed_at: str


# ─────────────────────────── NDBC ───────────────────────────


def _mps_to_kt(v: float | None) -> float | None:
    return v * 1.94384 if v is not None else None


def _c_to_f(v: float | None) -> float | None:
    return v * 9 / 5 + 32 if v is not None else None


def _m_to_ft(v: float | None) -> float | None:
    return v * 3.28084 if v is not None else None


def _parse_ndbc_float(s: str) -> float | None:
    s = s.strip()
    if not s or s == "MM":
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v


@lru_cache(maxsize=1)
def _ndbc_all() -> list[BuoyObservation]:
    """Parse the NDBC latest_obs.txt once per cold-start. ~900 stations."""
    req = urllib.request.Request(NDBC_LATEST_URL, headers={"User-Agent": "eclipse/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
            text = r.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return []

    out: list[BuoyObservation] = []
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        # Fixed-width-ish; split on whitespace works because the data file
        # uses MM for missing and the columns never overlap.
        parts = line.split()
        # Expected columns:
        # STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
        if len(parts) < 21:
            continue
        try:
            lat = float(parts[1])
            lon = float(parts[2])
            yyyy, mm, dd, hh, mn = parts[3:8]
            iso = f"{yyyy}-{int(mm):02d}-{int(dd):02d}T{int(hh):02d}:{int(mn):02d}:00Z"
        except (ValueError, IndexError):
            continue
        wdir = _parse_ndbc_float(parts[8])
        wspd_ms = _parse_ndbc_float(parts[9])
        gst_ms = _parse_ndbc_float(parts[10])
        wvht_m = _parse_ndbc_float(parts[11])
        pres = _parse_ndbc_float(parts[15])
        atmp = _parse_ndbc_float(parts[17])
        wtmp = _parse_ndbc_float(parts[18])
        out.append(
            BuoyObservation(
                station_id=parts[0],
                lat=lat,
                lon=lon,
                wind_kt=_mps_to_kt(wspd_ms),
                wind_dir_deg=wdir,
                gust_kt=_mps_to_kt(gst_ms),
                wave_height_ft=_m_to_ft(wvht_m),
                pressure_mb=pres,
                air_temp_f=_c_to_f(atmp),
                water_temp_f=_c_to_f(wtmp),
                observed_at=iso,
            )
        )
    return out


def buoys_in_bbox(
    west: float, south: float, east: float, north: float
) -> list[BuoyObservation]:
    return [
        b for b in _ndbc_all()
        if south <= b.lat <= north and west <= b.lon <= east
    ]


# ─────────────────────────── NWS land stations ───────────────────────────


def _nws_get(
    path: str,
    params: dict | None = None,
    *,
    timeout_s: int = FETCH_TIMEOUT_S,
) -> dict | None:
    """GET against api.weather.gov; returns parsed JSON or None on error.
    ``timeout_s`` can be overridden by the caller — the /stations pagination
    is happy to wait ~30 s but per-station latest-obs fetches want to fail
    fast so a stuck endpoint doesn't hold up a whole 500-station batch."""
    url = f"https://api.weather.gov{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": NWS_USER_AGENT,
            "Accept": "application/geo+json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


@lru_cache(maxsize=1)
def _nws_all_stations() -> list[dict]:
    """All NWS observation stations (paginated until exhausted, capped).

    NWS's /stations endpoint returns metadata + GeoJSON Point geometry per
    station. We pull up to ~15,000 stations (limit=500 per page × 30 pages)
    which comfortably covers all of CONUS + territories. Was previously
    capped at 4,000 which left interior CONUS under-covered — inland east
    Texas returned "nearest obs 166 km" (Houston metro) even though there
    are dozens of NWS ASOS + mesonet sites within 30-50 km of any point.
    Cached once per cold start."""
    out: list[dict] = []
    cursor = None
    for _ in range(30):
        params = {"limit": 500}
        if cursor:
            params["cursor"] = cursor
        page = _nws_get("/stations", params=params)
        if not page:
            break
        features = page.get("features") or []
        out.extend(features)
        # If NWS returned fewer than we asked for, we're at the end.
        if len(features) < 500:
            break
        cursor = ((page.get("pagination") or {}).get("next") or "")
        if "cursor=" in cursor:
            cursor = cursor.split("cursor=")[-1].split("&")[0]
        else:
            break
    return out


def _fetch_latest_obs(sid: str, name: str, lat: float, lon: float) -> LandObservation | None:
    # 6-second per-station cap. NWS station endpoints occasionally hang for
    # the full 30 s default; with 500 stations in parallel a handful of
    # hangs could push total latency past Vercel's serverless timeout.
    obs = _nws_get(f"/stations/{sid}/observations/latest", timeout_s=6)
    if not obs:
        return None
    p = (obs.get("properties") or {})
    wind_kt = _mps_to_kt((p.get("windSpeed") or {}).get("value"))
    wind_dir = (p.get("windDirection") or {}).get("value")
    gust_kt = _mps_to_kt((p.get("windGust") or {}).get("value"))
    pres_pa = (p.get("barometricPressure") or {}).get("value")
    temp_c = (p.get("temperature") or {}).get("value")
    return LandObservation(
        station_id=sid,
        name=name,
        lat=lat,
        lon=lon,
        wind_kt=wind_kt,
        wind_dir_deg=wind_dir,
        gust_kt=gust_kt,
        pressure_mb=pres_pa / 100.0 if pres_pa else None,
        temp_f=_c_to_f(temp_c),
        observed_at=p.get("timestamp") or "",
    )


def _spatial_subsample(
    stations: list[tuple[str, str, float, float]],
    west: float, south: float, east: float, north: float,
    target: int,
) -> list[tuple[str, str, float, float]]:
    """Grid-based one-per-cell subsample. Guarantees stations are spread over
    the whole bbox instead of clumping wherever NWS densely instrumented (e.g.
    Texas mesonet). Target is a soft cap: the returned count may be smaller
    when regions of the bbox have no stations (open ocean, sparse states)."""
    if len(stations) <= target:
        return stations
    side = max(2, math.ceil(math.sqrt(target)))
    dw = (east - west) / side
    dh = (north - south) / side
    if dw <= 0 or dh <= 0:
        return stations[:target]
    picked: dict[tuple[int, int], tuple[str, str, float, float]] = {}
    # Sort so the choice within a cell is deterministic across requests.
    for s in sorted(stations, key=lambda x: x[0]):
        sid, name, lat, lon = s
        ix = min(side - 1, max(0, int((lon - west) / dw)))
        iy = min(side - 1, max(0, int((lat - south) / dh)))
        picked.setdefault((ix, iy), s)
    return list(picked.values())


def land_stations_in_bbox(
    west: float, south: float, east: float, north: float,
    *, max_stations: int = 80,
) -> list[LandObservation]:
    """NWS observation stations spread evenly across ``bbox``, each enriched
    with the latest observation.

    Previously this iterated NWS's global station list in whatever order the
    API returned it and stopped after 250 in-bbox candidates — which for a
    bbox spanning e.g. Louisiana + Texas would fill up on the ~300 automated
    Texas mesonet sites before ever reaching Louisiana. We now collect every
    in-bbox candidate and spatially subsample onto a grid so obs are visible
    across the whole storm footprint.

    Concurrent fetch (12 workers). NWS has no rate-limit headers; 12 parallel
    reads is polite.
    """
    all_in_bbox: list[tuple[str, str, float, float]] = []
    for f in _nws_all_stations():
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None]
        lon, lat = coords[0], coords[1]
        if lat is None or lon is None:
            continue
        if not (south <= lat <= north and west <= lon <= east):
            continue
        props = f.get("properties") or {}
        sid = props.get("stationIdentifier") or ""
        if not sid:
            continue
        all_in_bbox.append((sid, props.get("name") or sid, lat, lon))

    candidates = _spatial_subsample(
        all_in_bbox, west, south, east, north, max_stations,
    )

    out: list[LandObservation] = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [
            pool.submit(_fetch_latest_obs, sid, name, lat, lon)
            for sid, name, lat, lon in candidates
        ]
        for fut in as_completed(futures, timeout=30):
            try:
                rec = fut.result()
                if rec is not None:
                    out.append(rec)
            except Exception:  # noqa: BLE001
                continue
    return out
