"""IBTrACS Atlantic best-track Rmax lookup.

NOAA's International Best Track Archive for Climate Stewardship (IBTrACS)
v04r01 — North Atlantic basin file. Used as the *measured* source of radius
of maximum winds (Rmax). When IBTrACS has a value for a (storm, time), we use
it directly; otherwise we fall back to the Willoughby (2006) parametric fit.

Spec PDF / column docs:
  https://www.ncei.noaa.gov/sites/default/files/2025-09/IBTrACS_v04r01_column_documentation.pdf

CSV file:
  https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.NA.list.v04r01.csv

The CSV is ~70 MB. We fetch once per cold-start, parse, throw away every column
except (USA_ATCF_ID, ISO_TIME, USA_RMW), and keep only rows where USA_RMW is
present — that's the only column we actually need. Storage after filtering is
~150 KB resident.

Lookup key: ``(USA_ATCF_ID, "YYYYMMDDHHMM")`` where the time matches the same
6-hourly synoptic slot HURDAT2 records (HURDAT2 datetime is "YYYYMMDDHH"; we
pad with "00" for minutes).
"""

from __future__ import annotations

import csv
import io
import urllib.request
from functools import lru_cache

IBTRACS_URL = (
    "https://www.ncei.noaa.gov/data/"
    "international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.NA.list.v04r01.csv"
)
FETCH_TIMEOUT_S = 90
MIN_SEASON = 1950  # ignore everything older than the HURDAT2 cutoff we render


@lru_cache(maxsize=1)
def _rmax_index() -> dict[tuple[str, str], float]:
    """Build {(usa_atcf_id, 'YYYYMMDDHHMM') -> rmw_nm} once per cold-start."""
    req = urllib.request.Request(
        IBTRACS_URL, headers={"User-Agent": "exposure-eclipse-ibtracs/1.0"}
    )
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
        raw = resp.read().decode("utf-8", errors="replace")

    reader = csv.reader(io.StringIO(raw))
    header = next(reader, None)
    if header is None:
        return {}
    # Row 2 is units (e.g. "kts", "nmile") — skip.
    _units = next(reader, None)

    try:
        i_atcf = header.index("USA_ATCF_ID")
        i_time = header.index("ISO_TIME")
        i_rmw = header.index("USA_RMW")
        i_season = header.index("SEASON")
    except ValueError:
        # Header layout changed unexpectedly — empty index is safer than
        # crashing the impact endpoint. Willoughby fallback handles the gap.
        return {}

    out: dict[tuple[str, str], float] = {}
    for row in reader:
        if not row or len(row) <= max(i_atcf, i_time, i_rmw, i_season):
            continue
        season_raw = row[i_season].strip()
        try:
            season = int(season_raw)
        except ValueError:
            continue
        if season < MIN_SEASON:
            continue
        atcf = row[i_atcf].strip()
        if not atcf:
            continue
        rmw_raw = row[i_rmw].strip()
        if not rmw_raw:
            continue
        try:
            rmw = float(rmw_raw)
        except ValueError:
            continue
        if rmw <= 0:
            continue
        iso = row[i_time].strip()  # "YYYY-MM-DD HH:MM:SS"
        if len(iso) < 16:
            continue
        key_dt = iso[0:4] + iso[5:7] + iso[8:10] + iso[11:13] + iso[14:16]
        out[(atcf.upper(), key_dt)] = rmw
    return out


def _normalize_datetime(dt_raw: str) -> str | None:
    """Reduce any of our datetime formats to the 'YYYYMMDDHHMM' index key.

    Accepts:
      - ``YYYYMMDDHH``         (raw HURDAT2, 10 digits)
      - ``YYYYMMDDHHMM``       (raw HURDAT2 + minutes, 12 digits)
      - ``YYYY-MM-DDTHH:MM:SSZ``  (the ISO form our HURDAT2 parser actually emits)
      - ``YYYY-MM-DD HH:MM:SS`` (IBTrACS native)
    """
    dt = dt_raw.strip()
    # Strip anything that isn't a digit; first 12 are YYYYMMDDHHMM.
    digits = "".join(ch for ch in dt if ch.isdigit())
    if len(digits) >= 12:
        return digits[:12]
    if len(digits) == 10:
        return digits + "00"
    return None


def lookup_rmax_nm(storm_id: str | None, datetime_utc: str | None) -> float | None:
    """Return the IBTrACS-measured Rmax (nautical miles) for a HURDAT2 fix.

    ``storm_id`` is the HURDAT2/ATCF id, e.g. ``"AL092022"`` (case-insensitive).
    ``datetime_utc`` may be raw HURDAT2 (``"2022092818"``), HURDAT2 with minutes
    (``"202209281805"``), or our parser's ISO form (``"2022-09-28T18:00:00Z"``).
    Returns ``None`` if not found in IBTrACS or if the record has no recon-
    measured Rmax at that time — caller falls back to Willoughby.
    """
    if not storm_id or not datetime_utc:
        return None
    key_dt = _normalize_datetime(datetime_utc)
    if key_dt is None:
        return None
    return _rmax_index().get((storm_id.upper(), key_dt))


def warm_cache() -> int:
    """Prime the lru_cache; returns the number of indexed Rmax records."""
    return len(_rmax_index())
