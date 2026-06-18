"""NOAA IBTrACS — Atlantic basin hurricane tracks + recon Rmax.

NOAA's International Best Track Archive for Climate Stewardship (IBTrACS)
v04r01 North-Atlantic CSV is the source of BOTH:
  - storm tracks (3-hour interpolated USA fixes — denser than HURDAT2's 6-hour
    native, smoother path lines and better hurricane-strength coverage)
  - recon-measured radius of maximum winds (USA_RMW)

Spec PDF / column docs:
  https://www.ncei.noaa.gov/sites/default/files/2025-09/IBTrACS_v04r01_column_documentation.pdf

CSV file:
  https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.NA.list.v04r01.csv

The CSV is ~70 MB. One fetch per cold-start, one parse, two indexes built:

  * ``_rmax_index()``  — ``{(usa_atcf_id, 'YYYYMMDDHHMM') -> rmw_nm}``
  * ``_storms_index()`` — ``{usa_atcf_id -> Storm(track=[TrackPoint, ...])}``

Both shapes are intentionally compatible with the previous HURDAT2 module so
callers (hurricanes API, hurricane_impact service) don't need to know which
source the tracks came from.
"""

from __future__ import annotations

import csv
import io
import urllib.request
from dataclasses import dataclass, field
from functools import lru_cache

IBTRACS_URL = (
    "https://www.ncei.noaa.gov/data/"
    "international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.NA.list.v04r01.csv"
)
FETCH_TIMEOUT_S = 120
MIN_SEASON = 1950  # ignore everything older than what we render in the UI


# ───────────────────────── data shapes (HURDAT2-compatible) ─────────────────────────


@dataclass(slots=True)
class TrackPoint:
    datetime_utc: str       # ISO-8601 "YYYY-MM-DDTHH:MM:SSZ"
    record_id: str          # "L" when this fix is a landfall, "" otherwise
    status: str             # IBTrACS USA_STATUS code (HU, TS, TD, EX, SD, SS, LO, WV, DB, ET)
    lat: float
    lon: float
    wind_kt: int            # USA_WIND; 0 if missing
    pressure_mb: int | None


@dataclass(slots=True)
class Storm:
    storm_id: str           # USA_ATCF_ID, e.g. "AL092022"
    name: str
    year: int
    track: list[TrackPoint] = field(default_factory=list)


# ───────────────────────── single-pass CSV parse ─────────────────────────


def _parse_int(s: str) -> int | None:
    s = s.strip()
    if not s:
        return None
    try:
        v = int(float(s))  # IBTrACS occasionally writes "120.0"
    except ValueError:
        return None
    return v if v > -90 else None  # IBTrACS uses negative sentinels for missing


def _parse_float(s: str) -> float | None:
    s = s.strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


@lru_cache(maxsize=1)
def _parse_csv() -> tuple[
    dict[tuple[str, str], float],          # rmax index
    dict[tuple[str, str], float],          # r64 (mean across non-zero quadrants) index
    dict[str, Storm],                       # storms by ATCF id
]:
    """Single-pass fetch + parse → (rmax_index, r64_index, storms_by_atcf)."""
    req = urllib.request.Request(
        IBTRACS_URL, headers={"User-Agent": "exposure-eclipse-ibtracs/1.0"}
    )
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
        raw = resp.read().decode("utf-8", errors="replace")

    reader = csv.reader(io.StringIO(raw))
    header = next(reader, None)
    if header is None:
        return {}, {}
    # Row 2 is units; skip.
    _units = next(reader, None)

    try:
        i_atcf = header.index("USA_ATCF_ID")
        i_time = header.index("ISO_TIME")
        i_rmw = header.index("USA_RMW")
        i_season = header.index("SEASON")
        i_name = header.index("NAME")
        i_lat = header.index("USA_LAT")
        i_lon = header.index("USA_LON")
        i_wind = header.index("USA_WIND")
        i_pres = header.index("USA_PRES")
        i_status = header.index("USA_STATUS")
        i_record = header.index("USA_RECORD")
        i_r64 = [header.index(f"USA_R64_{q}") for q in ("NE", "SE", "SW", "NW")]
    except ValueError:
        # Header layout drifted — bail out clean; downstream falls back gracefully.
        return {}, {}, {}

    rmax_index: dict[tuple[str, str], float] = {}
    r64_index: dict[tuple[str, str], float] = {}
    storms: dict[str, Storm] = {}
    max_col = max(
        i_atcf, i_time, i_rmw, i_season, i_name,
        i_lat, i_lon, i_wind, i_pres, i_status, i_record,
        *i_r64,
    )

    for row in reader:
        if not row or len(row) <= max_col:
            continue

        season_raw = row[i_season].strip()
        try:
            season = int(season_raw)
        except ValueError:
            continue
        if season < MIN_SEASON:
            continue

        atcf = row[i_atcf].strip().upper()
        if not atcf:
            continue  # skip storms NHC didn't track — they have no ATCF id

        iso = row[i_time].strip()
        if len(iso) < 16:
            continue
        key_dt = iso[0:4] + iso[5:7] + iso[8:10] + iso[11:13] + iso[14:16]

        # Rmax index — only rows where USA_RMW is set get in.
        rmw_raw = row[i_rmw].strip()
        if rmw_raw:
            try:
                rmw = float(rmw_raw)
                if rmw > 0:
                    rmax_index[(atcf, key_dt)] = rmw
            except ValueError:
                pass

        # R64 index — IBTrACS records the radius of 64-kt winds in each of
        # four quadrants. Many older fixes carry only NE filled in and the
        # rest blank/zero; the mean of the *non-zero* quadrants is a fair
        # representative size that the visible outer cone uses to convey
        # the hurricane wind field's footprint.
        quad_vals: list[float] = []
        for ci in i_r64:
            v = row[ci].strip()
            if not v:
                continue
            try:
                f = float(v)
            except ValueError:
                continue
            if f > 0:
                quad_vals.append(f)
        if quad_vals:
            r64_index[(atcf, key_dt)] = sum(quad_vals) / len(quad_vals)

        # Track point — needs at minimum lat/lon.
        lat = _parse_float(row[i_lat])
        lon = _parse_float(row[i_lon])
        if lat is None or lon is None:
            continue

        wind = _parse_int(row[i_wind]) or 0
        pres = _parse_int(row[i_pres])
        status = row[i_status].strip() or "XX"
        record = row[i_record].strip()  # "L" when landfall
        # ISO from IBTrACS is "YYYY-MM-DD HH:MM:SS"; emit ISO-8601 Z form so
        # downstream consumers (frontend, lookup_rmax_nm) see the same shape
        # the HURDAT2 parser used to produce.
        dt_iso = f"{iso[0:10]}T{iso[11:19]}Z"

        s = storms.get(atcf)
        if s is None:
            name = row[i_name].strip() or "UNNAMED"
            s = Storm(storm_id=atcf, name=name, year=season)
            storms[atcf] = s

        s.track.append(
            TrackPoint(
                datetime_utc=dt_iso,
                record_id=record,
                status=status,
                lat=lat,
                lon=lon,
                wind_kt=wind,
                pressure_mb=pres,
            )
        )

    # Sort each track chronologically — IBTrACS rows usually are, but the
    # USA_* values can be sparse and a defensive sort costs nothing.
    for s in storms.values():
        s.track.sort(key=lambda p: p.datetime_utc)

    return rmax_index, r64_index, storms


def _rmax_index() -> dict[tuple[str, str], float]:
    return _parse_csv()[0]


def _r64_index() -> dict[tuple[str, str], float]:
    return _parse_csv()[1]


def _storms_index() -> dict[str, Storm]:
    return _parse_csv()[2]


# ───────────────────────── public API ─────────────────────────


def fetch_storms() -> list[Storm]:
    """All Atlantic storms from MIN_SEASON onward, each with its full track.

    Cheap after the first call (lru_cached single-pass parse). Drop-in
    replacement for ``hurdat2.fetch_and_parse``.
    """
    return list(_storms_index().values())


def _normalize_datetime(dt_raw: str) -> str | None:
    """Reduce any of our datetime formats to the 'YYYYMMDDHHMM' index key.

    Accepts:
      - ``YYYYMMDDHH``         (raw HURDAT2, 10 digits)
      - ``YYYYMMDDHHMM``       (raw HURDAT2 + minutes, 12 digits)
      - ``YYYY-MM-DDTHH:MM:SSZ``  (ISO form our parsers emit)
      - ``YYYY-MM-DD HH:MM:SS`` (IBTrACS native)
    """
    dt = dt_raw.strip()
    digits = "".join(ch for ch in dt if ch.isdigit())
    if len(digits) >= 12:
        return digits[:12]
    if len(digits) == 10:
        return digits + "00"
    return None


def lookup_rmax_nm(storm_id: str | None, datetime_utc: str | None) -> float | None:
    """Return IBTrACS-measured Rmax (nautical miles) for one fix, or None."""
    if not storm_id or not datetime_utc:
        return None
    key_dt = _normalize_datetime(datetime_utc)
    if key_dt is None:
        return None
    return _rmax_index().get((storm_id.upper(), key_dt))


def lookup_r64_nm(storm_id: str | None, datetime_utc: str | None) -> float | None:
    """Return IBTrACS-measured mean R64 (nautical miles) for one fix, or None.

    R64 is the radius at which the wind field still reaches 64 kt (hurricane
    threshold). Larger than Rmax; defines the wind footprint that flags
    impacted counties. NHC didn't systematically record R64 before ~2004,
    so older storms commonly return None — caller falls back to 2.5×Rmax.
    """
    if not storm_id or not datetime_utc:
        return None
    key_dt = _normalize_datetime(datetime_utc)
    if key_dt is None:
        return None
    return _r64_index().get((storm_id.upper(), key_dt))


def warm_cache() -> tuple[int, int, int]:
    """Prime the cache; returns (n_storms, n_rmax_records, n_r64_records)."""
    rmw = _rmax_index()
    r64 = _r64_index()
    storms = _storms_index()
    return len(storms), len(rmw), len(r64)
