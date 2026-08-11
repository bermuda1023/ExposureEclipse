"""Active NHC invests — pre-advisory systems with model data but no NHC
tropical-cyclone advisories yet.

Invests are numbered 90-99 in each basin (AL / EP / CP). Once a system is
recognised as worth tracking by NHC / NCEP, they publish an ATCF a-deck at
``https://ftp.nhc.noaa.gov/atcf/aid_public/a{basin}{cy}{year}.dat.gz`` even
before any advisory is issued. That's the earliest signal an underwriter can
get on a system that MIGHT become a named storm 3-5 days out — hugely
valuable for cat-modelling pre-loss.

We probe all 30 possible invest slots (3 basins × 10 numbers) in parallel,
reusing the a-deck download cache in :mod:`atcf_adecks`. Any a-deck whose
latest init cycle is within the last 3 days is treated as active. Everything
else (stale, deleted, never issued) is silently omitted.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from . import atcf_adecks

# Invest storm numbers are always 90-99, recycled through the season. Basins
# we care about for Atlantic + Eastern Pacific + Central Pacific.
INVEST_BASINS: tuple[str, ...] = ("AL", "EP", "CP")
INVEST_NUMBERS: range = range(90, 100)

# An a-deck older than this is a stale invest slot — NHC recycles the 90-99
# numbers throughout the season, so a lingering file from a system that
# fizzled last month must not surface as "active".
INVEST_MAX_AGE = timedelta(days=3)


@dataclass(slots=True, frozen=True)
class InvestSummary:
    """One active invest — surfaced in the storm picker as a distinct
    section so an underwriter can eyeball what's brewing before it gets
    named."""

    atcf_id: str            # e.g. "AL912026"
    basin: str              # "AL" | "EP" | "CP"
    cy: int                 # 90..99
    name: str               # "Invest AL91"
    lat: float
    lon: float
    intensity_kt: int
    latest_cycle: str       # "YYYY-MM-DDTHHZ" — model cycle age
    label: str              # display string for the picker chip


def _probe_one(basin: str, cy: int, year: int) -> InvestSummary | None:
    """Fetch the a-deck (via the shared cache) and return an ``InvestSummary``
    if it's live enough to render, else None."""
    payload = atcf_adecks._download_adeck(basin.lower(), cy, year)
    if payload is None:
        return None
    rows = list(atcf_adecks._parse_lines(payload))
    if not rows:
        return None

    # Latest cycle in the file drives the "how fresh is this?" check.
    latest = max(r["init"] for r in rows)
    try:
        latest_dt = datetime.strptime(latest, "%Y%m%d%H").replace(
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None
    if datetime.now(timezone.utc) - latest_dt > INVEST_MAX_AGE:
        return None

    # Current position: prefer CARQ TAU=0 (best-track analysis), else the
    # earliest TAU=0 fix from any tech, else the earliest fix at all.
    latest_rows = [r for r in rows if r["init"] == latest]
    carq_tau0 = [r for r in latest_rows if r["tech"] == "CARQ" and r["tau"] == 0]
    any_tau0 = [r for r in latest_rows if r["tau"] == 0]
    seed = carq_tau0 or any_tau0 or latest_rows
    seed_row = seed[0]

    lat = float(seed_row["lat"])
    lon = float(seed_row["lon"])
    wind = int(seed_row["wind_kt"] or 0)

    latest_iso = atcf_adecks._format_init_iso(latest)
    label = f"Invest {basin.upper()}{cy:02d} — {wind} kt · {latest_iso}"
    return InvestSummary(
        atcf_id=f"{basin.upper()}{cy:02d}{year}",
        basin=basin.upper(),
        cy=cy,
        name=f"Invest {basin.upper()}{cy:02d}",
        lat=lat,
        lon=lon,
        intensity_kt=wind,
        latest_cycle=latest_iso,
        label=label,
    )


def _current_year() -> int:
    return datetime.now(timezone.utc).year


# Cache the probe result — 30 parallel HEADs is not free, and the picker
# refresh cadence doesn't need sub-minute freshness for pre-advisory systems.
# lru_cache with maxsize=2 covers "this year" plus one for edge cases.
@lru_cache(maxsize=2)
def _fetch_invests_for_year(year: int) -> tuple[InvestSummary, ...]:
    """Parallel probe every (basin × 90..99) slot for the given season year."""
    tasks: list[tuple[str, int, int]] = [
        (basin, cy, year) for basin in INVEST_BASINS for cy in INVEST_NUMBERS
    ]
    results: list[InvestSummary] = []
    with ThreadPoolExecutor(max_workers=15) as pool:
        futures = {
            pool.submit(_probe_one, basin, cy, year): (basin, cy)
            for basin, cy, year in tasks
        }
        for fut in as_completed(futures, timeout=60):
            try:
                out = fut.result()
            except Exception:  # noqa: BLE001 — per-slot failure → skip
                continue
            if out is not None:
                results.append(out)
    # Alphabetical by atcf_id — stable ordering for the picker (AL first,
    # then CP, then EP).
    results.sort(key=lambda i: i.atcf_id)
    return tuple(results)


def fetch_active_invests(year: int | None = None) -> list[InvestSummary]:
    """Return the currently-active invests across AL / EP / CP basins.

    Args:
        year: Season year. Defaults to the current UTC year. Late-season
            wraparound (Northern winter) intentionally sticks with the
            current year — invest slots don't span calendar boundaries.

    Returns:
        List sorted by ATCF id. Empty when nothing's brewing anywhere in the
        northern basins or when NHC's FTP is unreachable.
    """
    return list(_fetch_invests_for_year(year or _current_year()))


def is_invest_id(atcf_id: str) -> bool:
    """True if ``atcf_id`` looks like an invest (CY 90-99)."""
    if len(atcf_id) < 8:
        return False
    try:
        cy = int(atcf_id[2:4])
    except ValueError:
        return False
    return 90 <= cy <= 99


def clear_cache() -> None:
    """Test hook — flush the parallel-probe cache."""
    _fetch_invests_for_year.cache_clear()


__all__ = [
    "InvestSummary",
    "INVEST_BASINS",
    "INVEST_NUMBERS",
    "fetch_active_invests",
    "is_invest_id",
    "clear_cache",
]
