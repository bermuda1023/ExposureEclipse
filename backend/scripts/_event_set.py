"""Wind-dominant PCS event set, shared by the damage training scripts.

``mockdata/industry_losses/event_set.json`` holds three exclusion rules and a
loss-mechanism note per event. This module measures each rule's metric from
the track, the PCS county rows and the industry TIV, so a decision can be
re-derived rather than asserted:

  noExposure        share of on-levelled PCS loss in counties with no book TIV
  stalled           hours the centre stays within ``radiusNm`` of the
                    strongest US landfall (Florence 45 h, Sally 51 h; every
                    other supplied event is 24 h or less)
  outsideFootprint  share of the PCS loss that has TIV but falls in counties
                    with no modelled wind on the impact panel's field
                    (historical track, multiplier 2.5, no tropical-storm field)

None of the metrics uses a fitted curve, so no event is dropped for fitting
badly. ``panel_loss`` prices an event exactly as the impact panel's
PCS-calibrated chip does, which is what the displayed range is scored on.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache

from app.services.damage_curves import interp_weights
from app.services.hurricane_impact import DAMAGING_WIND_MULTIPLIER, compute_impact
from app.services.industry_losses import LOSS_SEGMENTS, IndustryTiv, data_dir

NM_PER_RADIAN = 3440.065
# Continental US landfalls only: Caribbean landfalls do not touch the book.
CONUS_LAT = (24.0, 49.5)
CONUS_LON = (-98.0, -66.0)


@dataclass
class Screened:
    storm_id: str
    name: str
    year: int
    mechanism: str
    metrics: dict = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)

    @property
    def included(self) -> bool:
        return not self.reasons

    def to_wire(self) -> dict:
        return {
            "stormId": self.storm_id,
            "name": self.name,
            "year": self.year,
            "included": self.included,
            "reasons": self.reasons,
            "mechanism": self.mechanism,
            "metrics": self.metrics,
        }


def load_event_set() -> dict:
    path = data_dir() / "industry_losses" / "event_set.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _nm(a: tuple[float, float], b: tuple[float, float]) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * NM_PER_RADIAN * math.asin(math.sqrt(h))


def _when(point) -> datetime:
    return datetime.fromisoformat(point.datetime_utc)


def us_landfall(storm):
    """Strongest continental-US landfall fix, or None."""
    fixes = [
        p for p in storm.track
        if p.record_id == "L" and CONUS_LAT[0] < p.lat < CONUS_LAT[1] and CONUS_LON[0] < p.lon < CONUS_LON[1]
    ]
    return max(fixes, key=lambda p: p.wind_kt) if fixes else None


def residence_hours(storm, landfall, radius_nm: float) -> float:
    """Track hours with the centre inside ``radius_nm`` of the landfall point."""
    here = (landfall.lat, landfall.lon)
    hours = 0.0
    for a, b in zip(storm.track, storm.track[1:]):
        if _nm((a.lat, a.lon), here) <= radius_nm and _nm((b.lat, b.lon), here) <= radius_nm:
            hours += (_when(b) - _when(a)).total_seconds() / 3600
    return hours


@lru_cache(maxsize=32)
def _panel_impacts(storm_id: str):
    from app.services.event_loss import resolve_storm

    storm, _source = resolve_storm(storm_id)
    impacts, *_ = compute_impact(storm, multiplier=DAMAGING_WIND_MULTIPLIER)
    return tuple(impacts)


def panel_impacts(storm) -> tuple:
    """County wind mix the impact panel receives for a historical storm."""
    return _panel_impacts(storm.storm_id)


def _in_field(impact) -> bool:
    return any(b.area_fraction > 0 for b in (impact.speed_bins or []))


def screen(storm, county_loss: dict[str, float], tiv: IndustryTiv, event_set: dict) -> Screened:
    """Measure the three rules for one event. ``county_loss`` is on-levelled PCS loss by county."""
    rules = event_set["rules"]
    note = (event_set.get("events") or {}).get(storm.storm_id)
    if note is None:
        raise SystemExit(f"{storm.storm_id}: add a mechanism note to industry_losses/event_set.json")
    total = sum(county_loss.values())
    has_tiv = {g: a for g, a in county_loss.items() if sum((tiv.county.get(g) or {}).values()) > 0}
    with_tiv = sum(has_tiv.values())
    field_ids = {imp.geography_id for imp in panel_impacts(storm) if _in_field(imp)}
    outside = sum(a for g, a in has_tiv.items() if g not in field_ids)
    landfall = us_landfall(storm)
    radius = float(rules["stalled"]["radiusNm"])
    stall = residence_hours(storm, landfall, radius) if landfall else None
    metrics = {
        "pcsLoss": round(total),
        "noTivShare": round(1 - with_tiv / total, 4) if total > 0 else None,
        "outsideFootprintShare": round(outside / with_tiv, 4) if with_tiv > 0 else None,
        "stallHours": round(stall, 1) if stall is not None else None,
        "landfall": (
            {"time": landfall.datetime_utc, "lat": landfall.lat, "lon": landfall.lon, "windKt": landfall.wind_kt}
            if landfall else None
        ),
    }
    reasons: list[str] = []
    if metrics["noTivShare"] is None or metrics["noTivShare"] > rules["noExposure"]["maxShare"]:
        reasons.append("noExposure")
    if stall is not None and stall >= rules["stalled"]["minHours"]:
        reasons.append("stalled")
    share = metrics["outsideFootprintShare"]
    if share is not None and share > rules["outsideFootprint"]["maxShare"] and "noExposure" not in reasons:
        reasons.append("outsideFootprint")
    return Screened(storm.storm_id, note.get("name", storm.name.title()), storm.year,
                    note["mechanism"], metrics, reasons)


def wind_dominant_ids(onlevel: bool = True) -> list[str]:
    """Supplied events that pass every rule, in storm-id order."""
    from app.services.event_loss import resolve_storm
    from app.services.industry_losses import load_actuals, tiv_for_year
    from app.services.onlevel import onlevel_actuals

    event_set = load_event_set()
    keep = []
    for storm_id, act in sorted(load_actuals().items()):
        storm, _source = resolve_storm(storm_id)
        tiv = tiv_for_year(storm.year)
        if onlevel:
            act, _ = onlevel_actuals(act, tiv.as_of)
        by_county: dict[str, float] = {}
        for (gid, _seg), loss in act.county.items():
            by_county[gid] = by_county.get(gid, 0.0) + loss
        if screen(storm, by_county, tiv, event_set).included:
            keep.append(storm_id)
    return keep


def blend(curves: dict[str, list[float]], mix: dict[str, float]) -> list[float]:
    """One curve from the segment curves, weighted by book TIV share, as the panel does."""
    segs = [s for s in LOSS_SEGMENTS if s in curves and mix.get(s, 0) > 0]
    total = sum(mix[s] for s in segs)
    bands = len(curves[segs[0]])
    return [sum(mix[s] / total * curves[s][b] for s in segs) for b in range(bands)]


def panel_loss(storm, curve: list[float], tiv: IndustryTiv, land) -> float:
    """Event loss as the PCS-calibrated chip prices it: bundled county TIV x
    sum over 10 mph bins of area x DR(land wind at the bin midpoint)."""
    loss = 0.0
    for imp in panel_impacts(storm):
        value = sum((tiv.county.get(imp.geography_id) or {}).values())
        if value <= 0:
            continue
        dr = 0.0
        for b in imp.speed_bins or []:
            if b.area_fraction > 0:
                dr += b.area_fraction * sum(w * curve[i] for i, w in interp_weights(land(b.mph_lo + 4.5)))
        loss += value * dr
    return loss


def scored_actual(county_loss: dict[str, float], tiv: IndustryTiv) -> float:
    """PCS loss the book can carry: counties with no TIV cannot be in any scope."""
    return sum(a for g, a in county_loss.items() if sum((tiv.county.get(g) or {}).values()) > 0)


def shortest_coverage(factors: dict[str, float], share: float) -> tuple[float, float, list[str]]:
    """Narrowest (log) range spanning at least ``share`` of the factors.

    With few events an equal-tail P10-P90 is set by single storms on both
    sides; the shortest covering range is the standard empirical alternative
    and names the events it leaves out.
    """
    ordered = sorted(factors.items(), key=lambda kv: kv[1])
    n = len(ordered)
    k = max(1, math.ceil(share * n - 1e-9))
    best = min(range(n - k + 1), key=lambda i: math.log(ordered[i + k - 1][1] / ordered[i][1]))
    low, high = ordered[best][1], ordered[best + k - 1][1]
    outside = [sid for sid, f in ordered if not low <= f <= high]
    return low, high, outside
