"""County TIV from the Industry client book.

Florida counties use the supplied industry exposure database. The residential
and commercial split keeps the prior mix, scaled so the two add up to that
total. Every other county is still a census and build-cost proxy, not an
RMS or AIR industry database.
"""

from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path

from ..config import get_settings


@lru_cache(maxsize=1)
def _by_geography() -> dict[str, tuple[int, int, int]]:
    path = Path(get_settings().mock_data_dir) / "industry_exposure_counties.csv"
    if not path.exists():
        return {}
    out: dict[str, tuple[int, int, int]] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            gid = row.get("geographyId") or ""
            if not gid:
                continue
            res = int(float(row["residentialTiv"]))
            com = int(float(row["commercialTiv"]))
            out[gid] = (res, com, res + com)
    return out


def county_industry_tiv(geography_id: str) -> tuple[int, int, int] | None:
    """Residential, commercial, and bundled TIV for one county geography id.

    Accepts ``US-FL-12086`` or a raw 5-digit GEOID.
    """
    if not geography_id:
        return None
    book = _by_geography()
    if geography_id in book:
        return book[geography_id]
    tail = geography_id.split("-")[-1]
    for gid, values in book.items():
        if gid.endswith("-" + tail):
            return values
    return None
