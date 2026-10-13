"""Supplied industry losses (PCS-style) and the matching industry TIV.

Two drop-in folders under ``mockdata/``:

``industry_losses/*.csv`` — one or more events per file::

    stormId,geographyId,segment,loss,currency[,asOfDate,source,includesFlood,includesSurge]

``industry_tiv/<year>.csv`` — the exposure the losses are measured against::

    geographyId,segment,tiv,currency[,asOfDate,source]

``geographyId`` is ``US-FL-12086``, a raw 5-digit county GEOID, or a state id
``US-FL``. Segment is ``RESIDENTIAL``, ``COMMERCIAL`` or ``AUTO``. A storm with
no loss file has no actuals; it is never read as a zero loss.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from ..config import get_settings
from ..models.enums import OccupancySegment
from .hurricane_impact import STATE_FIPS_TO_USPS

LOSS_SEGMENTS: tuple[str, ...] = (
    OccupancySegment.RESIDENTIAL.value,
    OccupancySegment.COMMERCIAL.value,
    OccupancySegment.AUTO.value,
)

LOSSES_DIR = "industry_losses"
TIV_DIR = "industry_tiv"


class IndustryDataError(ValueError):
    """A supplied file is malformed. The message names the file and line."""


@dataclass(frozen=True, slots=True)
class Geo:
    level: str  # COUNTY | STATE
    geography_id: str  # US-FL-12086 | US-FL
    state: str


def normalize_geography(raw: str) -> Geo | None:
    """``US-FL-12086`` / ``12086`` / ``12-086`` → county, ``US-FL`` / ``FL`` → state."""
    s = (raw or "").strip().upper()
    if not s:
        return None
    digits = s.replace("-", "")
    if digits.isdigit() and len(digits) in (4, 5):
        geoid = digits.zfill(5)
        usps = STATE_FIPS_TO_USPS.get(geoid[:2])
        if usps is None:
            return None
        return Geo("COUNTY", f"US-{usps}-{geoid}", usps)
    parts = s.split("-")
    if len(parts) == 3 and parts[0] == "US" and parts[2].isdigit():
        geoid = parts[2].zfill(5)
        usps = STATE_FIPS_TO_USPS.get(geoid[:2])
        if usps is None or usps != parts[1]:
            return None
        return Geo("COUNTY", f"US-{usps}-{geoid}", usps)
    if len(parts) == 2 and parts[0] == "US" and len(parts[1]) == 2:
        return Geo("STATE", s, parts[1])
    if len(s) == 2 and s.isalpha() and s in STATE_FIPS_TO_USPS.values():
        return Geo("STATE", f"US-{s}", s)
    return None


def _segment(raw: str, where: str) -> str:
    seg = (raw or "").strip().upper()
    aliases = {"RES": "RESIDENTIAL", "PERSONAL": "RESIDENTIAL", "COM": "COMMERCIAL",
               "COMM": "COMMERCIAL", "AUTOMOBILE": "AUTO"}
    seg = aliases.get(seg, seg)
    if seg not in LOSS_SEGMENTS:
        raise IndustryDataError(f"{where}: segment {raw!r} is not one of {LOSS_SEGMENTS}")
    return seg


def _money(raw: str, where: str) -> float:
    try:
        value = float((raw or "").replace(",", "").replace("$", "").strip())
    except ValueError as exc:
        raise IndustryDataError(f"{where}: {raw!r} is not a number") from exc
    if value < 0:
        raise IndustryDataError(f"{where}: negative value {value}")
    return value


def _flag(raw: str | None) -> bool | None:
    if raw is None or raw.strip() == "":
        return None
    return raw.strip().lower() in ("1", "true", "yes", "y")


def _rows(path: Path) -> list[tuple[int, dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        lines = [line for line in handle if line.strip() and not line.lstrip().startswith("#")]
    reader = csv.DictReader(lines)
    if reader.fieldnames is None:
        return []
    reader.fieldnames = [name.strip() for name in reader.fieldnames]
    return [(n + 2, row) for n, row in enumerate(reader)]


# ─────────────────────────────── actual losses ───────────────────────────────


@dataclass(slots=True)
class EventActuals:
    storm_id: str
    currency: str
    # (geography_id, segment) -> loss. County rows only.
    county: dict[tuple[str, str], float] = field(default_factory=dict)
    # (state, segment) -> loss from explicit state rows.
    state_rows: dict[tuple[str, str], float] = field(default_factory=dict)
    as_of: str | None = None
    source: str | None = None
    includes_flood: bool | None = None
    includes_surge: bool | None = None
    files: list[str] = field(default_factory=list)

    def segment_totals(self) -> dict[str, float]:
        """Event loss by segment. County rows win; state rows fill states with no county rows."""
        out = {seg: 0.0 for seg in LOSS_SEGMENTS}
        county_states: set[tuple[str, str]] = set()
        for (gid, seg), loss in self.county.items():
            out[seg] += loss
            county_states.add((gid.split("-")[1], seg))
        for (state, seg), loss in self.state_rows.items():
            if (state, seg) not in county_states:
                out[seg] += loss
        return out

    def total(self) -> float:
        return sum(self.segment_totals().values())


_BACKEND_DIR = Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    """mock_data_dir, resolved relative to backend/ when not absolute."""
    p = Path(get_settings().mock_data_dir)
    return p if p.is_absolute() else (_BACKEND_DIR / p).resolve()


@lru_cache(maxsize=1)
def load_actuals() -> dict[str, EventActuals]:
    folder = data_dir() / LOSSES_DIR
    events: dict[str, EventActuals] = {}
    if not folder.is_dir():
        return events
    for path in sorted(folder.glob("*.csv")):
        for line, row in _rows(path):
            where = f"{path.name}:{line}"
            storm_id = (row.get("stormId") or "").strip().upper()
            if not storm_id:
                raise IndustryDataError(f"{where}: stormId is required")
            geo = normalize_geography(row.get("geographyId") or "")
            if geo is None:
                raise IndustryDataError(f"{where}: unknown geographyId {row.get('geographyId')!r}")
            seg = _segment(row.get("segment") or "", where)
            loss = _money(row.get("loss") or "", where)
            currency = (row.get("currency") or "USD").strip().upper()
            event = events.get(storm_id)
            if event is None:
                event = events[storm_id] = EventActuals(storm_id=storm_id, currency=currency)
            if currency != event.currency:
                raise IndustryDataError(
                    f"{where}: currency {currency} differs from {event.currency} for {storm_id}"
                )
            if path.name not in event.files:
                event.files.append(path.name)
            event.as_of = (row.get("asOfDate") or "").strip() or event.as_of
            event.source = (row.get("source") or "").strip() or event.source
            flood = _flag(row.get("includesFlood"))
            surge = _flag(row.get("includesSurge"))
            event.includes_flood = flood if flood is not None else event.includes_flood
            event.includes_surge = surge if surge is not None else event.includes_surge
            if geo.level == "COUNTY":
                key = (geo.geography_id, seg)
                event.county[key] = event.county.get(key, 0.0) + loss
            else:
                key = (geo.state, seg)
                event.state_rows[key] = event.state_rows.get(key, 0.0) + loss
    return events


def actuals_for(storm_id: str) -> EventActuals | None:
    return load_actuals().get((storm_id or "").upper())


# ───────────────────────────────── industry TIV ─────────────────────────────────


@dataclass(slots=True)
class IndustryTiv:
    """County TIV by segment for one exposure vintage."""

    kind: str  # "supplied" | "book"
    year: int | None
    currency: str
    county: dict[str, dict[str, float]]  # geography_id -> segment -> tiv
    state: dict[str, dict[str, float]] = field(default_factory=dict)  # state rows as supplied
    file: str | None = None

    def segments_present(self) -> set[str]:
        out: set[str] = set()
        for segs in self.county.values():
            out.update(seg for seg, v in segs.items() if v > 0)
        return out


def _load_tiv_file(path: Path, year: int) -> IndustryTiv:
    county: dict[str, dict[str, float]] = {}
    state: dict[str, dict[str, float]] = {}
    currency: str | None = None
    for line, row in _rows(path):
        where = f"{path.name}:{line}"
        geo = normalize_geography(row.get("geographyId") or "")
        if geo is None:
            raise IndustryDataError(f"{where}: unknown geographyId {row.get('geographyId')!r}")
        seg = _segment(row.get("segment") or "", where)
        tiv = _money(row.get("tiv") or "", where)
        cur = (row.get("currency") or "USD").strip().upper()
        if currency is None:
            currency = cur
        elif cur != currency:
            raise IndustryDataError(f"{where}: currency {cur} differs from {currency}")
        target = county if geo.level == "COUNTY" else state
        key = geo.geography_id if geo.level == "COUNTY" else geo.state
        segs = target.setdefault(key, {})
        segs[seg] = segs.get(seg, 0.0) + tiv
    return IndustryTiv(
        kind="supplied", year=year, currency=currency or "USD",
        county=county, state=state, file=path.name,
    )


@lru_cache(maxsize=1)
def supplied_tiv_years() -> dict[int, Path]:
    folder = data_dir() / TIV_DIR
    if not folder.is_dir():
        return {}
    out: dict[int, Path] = {}
    for path in folder.glob("*.csv"):
        stem = path.stem.split("_")[0]
        if stem.isdigit() and len(stem) == 4:
            out[int(stem)] = path
    return out


@lru_cache(maxsize=16)
def _supplied_tiv(year: int) -> IndustryTiv:
    return _load_tiv_file(supplied_tiv_years()[year], year)


@lru_cache(maxsize=1)
def _book_tiv() -> IndustryTiv:
    """The built-in Industry book (residential + commercial, no auto)."""
    path = data_dir() / "industry_exposure_counties.csv"
    county: dict[str, dict[str, float]] = {}
    if path.exists():
        with path.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                gid = row.get("geographyId") or ""
                if not gid:
                    continue
                county[gid] = {
                    "RESIDENTIAL": float(row["residentialTiv"]),
                    "COMMERCIAL": float(row["commercialTiv"]),
                }
    return IndustryTiv(kind="book", year=None, currency="USD", county=county,
                       file="industry_exposure_counties.csv")


def tiv_for_year(year: int) -> IndustryTiv:
    """Supplied TIV for the storm year, else the latest earlier vintage, else
    the earliest later one, else the built-in book.

    ASSUMPTION: an older vintage is a better match for a past storm than a
    newer one, because PCS losses are not trended to today's exposure.
    """
    years = supplied_tiv_years()
    if not years:
        return _book_tiv()
    if year in years:
        return _supplied_tiv(year)
    earlier = [y for y in years if y <= year]
    pick = max(earlier) if earlier else min(years)
    return _supplied_tiv(pick)


def clear_caches() -> None:
    load_actuals.cache_clear()
    supplied_tiv_years.cache_clear()
    _supplied_tiv.cache_clear()
    _book_tiv.cache_clear()
