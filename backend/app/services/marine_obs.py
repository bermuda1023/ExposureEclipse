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
import urllib.parse
import urllib.request
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


def _nws_get(path: str, params: dict | None = None) -> dict | None:
    """GET against api.weather.gov; returns parsed JSON or None on error."""
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
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def land_stations_in_bbox(
    west: float, south: float, east: float, north: float,
    *, max_stations: int = 80,
) -> list[LandObservation]:
    """Fetch NWS observation stations inside the bbox, then their latest fix.

    NWS API doesn't accept a bbox directly for /stations; we pull a fairly
    big page and filter client-side. The user's bbox is the forecast cone +
    a margin, so this is usually <100 stations.
    """
    # Pull stations via the gridpoint API per state could work, but the
    # /stations endpoint with limit=500 returns evenly across CONUS.
    data = _nws_get("/stations", params={"limit": 500})
    if not data:
        return []
    out: list[LandObservation] = []
    for f in (data.get("features") or [])[:5000]:
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None]
        lon, lat = coords[0], coords[1]
        if lat is None or lon is None:
            continue
        if not (south <= lat <= north and west <= lon <= east):
            continue
        props = f.get("properties") or {}
        sid = props.get("stationIdentifier") or ""
        name = props.get("name") or sid
        # Fetch latest observation per station — that's a separate call each;
        # cap to keep this responsive.
        if len(out) >= max_stations:
            break
        obs = _nws_get(f"/stations/{sid}/observations/latest")
        if not obs:
            continue
        p = (obs.get("properties") or {})
        wind_kt = _mps_to_kt((p.get("windSpeed") or {}).get("value"))
        wind_dir = (p.get("windDirection") or {}).get("value")
        gust_kt = _mps_to_kt((p.get("windGust") or {}).get("value"))
        pres_pa = (p.get("barometricPressure") or {}).get("value")
        temp_c = (p.get("temperature") or {}).get("value")
        out.append(
            LandObservation(
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
        )
    return out
