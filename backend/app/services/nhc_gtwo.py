"""NHC Graphical Tropical Weather Outlook (GTWO) — the "what could become a
storm" formation-chance polygons.

Every 6 hours NHC issues a GTWO with 2-day and 5-day disturbance-formation
areas. Each area is a polygon coloured yellow/orange/red for low/medium/high
formation chance (< 40% / 40-60% / > 60%). This is the earliest possible
underwriting signal — days before an invest is designated, and week+ before
a storm is named.

KML products live at ``https://www.nhc.noaa.gov/xgtwo/gtwo_{basin}_{days}d0
.kml`` where basin ∈ {atl, ep, cp} and days ∈ {2, 5}.

Stdlib-only per CLAUDE.md — reuses the KML helpers from :mod:`nhc_gis`.
"""

from __future__ import annotations

import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from functools import lru_cache

from .nhc_gis import _extract_coord_list, _iter_placemarks

FETCH_TIMEOUT_S = 20

GTWO_URL = "https://www.nhc.noaa.gov/xgtwo/gtwo_{basin}_{days}d0.kml"

GTWO_BASINS: tuple[str, ...] = ("atl", "ep", "cp")


# ─────────────────────────── chance parsing ───────────────────────────


# Formation-chance percent lives in the Placemark description as
# "Formation chance through 2 days...50 percent" (variation in punctuation).
# The percent number is what we key everything else on.
_PCT_RE = re.compile(r"(\d{1,3})\s*percent", re.IGNORECASE)
# Fallback: styleUrl often encodes the bucket, e.g. "#40percent" or
# "#low" / "#medium" / "#high".
_STYLE_PCT_RE = re.compile(r"(\d{1,3})\s*(?:percent|pc|%)", re.IGNORECASE)


def _bucket_for_percent(pct: int) -> str:
    if pct < 40:
        return "low"
    if pct < 60:
        return "medium"
    return "high"


def _extract_chance(desc: str, style_url: str, name: str) -> tuple[int, str]:
    """Return (percent, bucket). Walks description → styleUrl → name until
    something parses; defaults to (0, "low") if everything's blank so the
    placemark isn't silently dropped."""
    for source in (desc, style_url, name):
        if not source:
            continue
        m = _PCT_RE.search(source) or _STYLE_PCT_RE.search(source)
        if m:
            pct = min(100, max(0, int(m.group(1))))
            return pct, _bucket_for_percent(pct)
    # Legacy style names (some vintages of the KML use bucket words).
    low = (style_url + " " + name).lower()
    if "high" in low:
        return 70, "high"
    if "medium" in low:
        return 50, "medium"
    if "low" in low:
        return 20, "low"
    return 0, "low"


# ─────────────────────────── data classes ───────────────────────────


@dataclass(slots=True, frozen=True)
class GTWOArea:
    """One disturbance-formation polygon from a GTWO product."""

    basin: str              # "atl" | "ep" | "cp"
    window_days: int        # 2 | 5
    chance_pct: int         # 0..100
    chance_bucket: str      # "low" | "medium" | "high"
    label: str              # placemark name (e.g. "Two-day area 1")
    description: str        # trimmed description text
    ring: list[tuple[float, float]]   # closed [(lon, lat), ...] ring


@dataclass(slots=True, frozen=True)
class GTWOBundle:
    """Full outlook for a basin — 2-day + 5-day areas combined."""

    basin: str
    two_day: list[GTWOArea]
    five_day: list[GTWOArea]
    note: str | None = None


# ─────────────────────────── fetch + parse ───────────────────────────


@lru_cache(maxsize=8)
def _download_kml(url: str) -> bytes | None:
    """Fetch a single GTWO KML; return None on any network / HTTP failure."""
    req = urllib.request.Request(
        url, headers={"User-Agent": "exposure-eclipse-live/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
            return resp.read()
    except Exception:  # noqa: BLE001 — network / 404 → degrade
        return None


def _text(el) -> str:
    return (el.text or "").strip() if el is not None else ""


def _parse_gtwo(payload: bytes, basin: str, window_days: int) -> list[GTWOArea]:
    """Extract disturbance polygons from a GTWO KML payload."""
    areas: list[GTWOArea] = []
    for pm in _iter_placemarks(payload):
        polygon = pm.find("Polygon")
        if polygon is None:
            continue
        ring_el = polygon.find(".//outerBoundaryIs/LinearRing/coordinates")
        if ring_el is None or not (ring_el.text or "").strip():
            continue
        coords = _extract_coord_list(ring_el.text or "")
        if len(coords) < 3:
            continue
        if coords[0] != coords[-1]:
            coords.append(coords[0])

        name = _text(pm.find("name"))
        desc = _text(pm.find("description"))
        style_url = _text(pm.find("styleUrl"))
        chance_pct, bucket = _extract_chance(desc, style_url, name)

        areas.append(
            GTWOArea(
                basin=basin,
                window_days=window_days,
                chance_pct=chance_pct,
                chance_bucket=bucket,
                label=name,
                description=desc[:500],   # truncate — the raw HTML gets long
                ring=coords,
            )
        )
    return areas


def fetch_gtwo(basin: str) -> GTWOBundle:
    """Fetch and parse the 2-day + 5-day GTWO for one basin in parallel.

    Args:
        basin: "atl" | "ep" | "cp"

    Returns:
        GTWOBundle with two_day + five_day area lists. Returns an empty
        bundle (both lists empty, note set) if the KML is unreachable —
        callers must not confuse "no outlook areas" with "outlook
        unavailable".
    """
    basin_lc = basin.lower()
    if basin_lc not in GTWO_BASINS:
        return GTWOBundle(
            basin=basin_lc, two_day=[], five_day=[],
            note=f"Unknown basin '{basin}'.",
        )
    windows: list[tuple[int, str]] = [
        (d, GTWO_URL.format(basin=basin_lc, days=d)) for d in (2, 5)
    ]
    results: dict[int, list[GTWOArea]] = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            pool.submit(_download_kml, url): (days, url)
            for days, url in windows
        }
        for fut in as_completed(futures, timeout=25):
            days, _url = futures[fut]
            payload = fut.result()
            if payload is None:
                results[days] = []
                continue
            try:
                results[days] = _parse_gtwo(payload, basin_lc, days)
            except Exception:  # noqa: BLE001 — malformed KML → empty
                results[days] = []

    two_day = results.get(2, [])
    five_day = results.get(5, [])
    note: str | None = None
    if not two_day and not five_day:
        note = (
            f"NHC GTWO for basin '{basin_lc}' returned no data — the "
            "product is issued every 6h and may be quiet, or the KML feed "
            "may be temporarily unreachable."
        )
    return GTWOBundle(basin=basin_lc, two_day=two_day, five_day=five_day, note=note)


def clear_cache() -> None:
    """Test hook."""
    _download_kml.cache_clear()


__all__ = [
    "GTWOArea",
    "GTWOBundle",
    "GTWO_BASINS",
    "fetch_gtwo",
    "clear_cache",
]
