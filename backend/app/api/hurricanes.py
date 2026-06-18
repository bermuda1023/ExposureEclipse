"""Historical Atlantic hurricane tracks (NOAA HURDAT2).

  GET /api/hurricanes?year_min=1950&year_max=2025&min_category=1&landfall_only=true

Filters:
  - year_min / year_max  → inclusive bounds on storm year
  - min_category         → Saffir-Simpson at landfall (1–5). Storms whose
                            strongest landfall < min_category are dropped.
  - landfall_only        → if true (default), drop storms that never made
                            landfall in any state we can detect.

Response is shaped for direct rendering as a Mapbox source.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..services.hurdat2 import (
    Storm,
    category_for_wind,
    fetch_and_parse,
    landfall_summary,
    peak_wind,
)


def _effective_category(landfall_cat: int, peak_cat: int) -> int:
    """The strength used for the min-category filter.

    With landfall (cat >= -1) we keep the landfall intensity. Without a
    detectable landfall (-2) we fall back to the storm's peak intensity over
    its lifetime — otherwise a Cat 5 storm that stayed at sea would compare
    as ``-2 < 1`` and get dropped from "Cat 1+" filters.
    """
    return landfall_cat if landfall_cat != -2 else peak_cat

router = APIRouter(prefix="/hurricanes", tags=["hurricanes"])


def _serialize(
    storm: Storm,
    landfall_cat: int,
    landfall_state: str | None,
    effective_cat: int,
) -> dict:
    return {
        "stormId": storm.storm_id,
        "name": storm.name,
        "year": storm.year,
        "landfallCategory": landfall_cat,  # -2 = no landfall, -1 = TD, 0 = TS, 1-5 = SS
        "landfallState": landfall_state,
        "peakWindKt": peak_wind(storm),
        # The category used by the strength filter — landfall if it had one,
        # else the storm's peak. Frontend uses this to decide colour for the
        # storm's overall classification in the tooltip.
        "effectiveCategory": effective_cat,
        "track": [
            {
                "lat": p.lat,
                "lon": p.lon,
                "windKt": p.wind_kt,
                "category": category_for_wind(p.wind_kt),
                "status": p.status,
                "datetime": p.datetime_utc,
                "isLandfall": "L" in p.record_id,
            }
            for p in storm.track
        ],
    }


@router.get("")
def list_hurricanes(
    year_min: int = Query(1950, ge=1950, le=2100, alias="yearMin"),
    year_max: int = Query(2100, ge=1950, le=2100, alias="yearMax"),
    min_category: int = Query(1, ge=-2, le=5, alias="minCategory"),
    landfall_only: bool = Query(True, alias="landfallOnly"),
) -> dict:
    if year_max < year_min:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "VALIDATION_ERROR",
                "message": "yearMax must be >= yearMin.",
            },
        )

    try:
        storms = fetch_and_parse()
    except Exception as exc:  # noqa: BLE001 — surface NOAA fetch failures cleanly
        raise HTTPException(
            status_code=502,
            detail={
                "code": "INTERNAL_ERROR",
                "message": "Failed to fetch HURDAT2 data from NOAA.",
                "details": {"error": str(exc)},
            },
        ) from exc

    out: list[dict] = []
    for s in storms:
        if s.year < year_min or s.year > year_max:
            continue
        cat, state = landfall_summary(s)
        if landfall_only and cat == -2:
            continue
        peak_cat = category_for_wind(peak_wind(s))
        effective = _effective_category(cat, peak_cat)
        if effective < min_category:
            continue
        out.append(_serialize(s, cat, state, effective))

    return {
        "storms": out,
        "count": len(out),
        "filters": {
            "yearMin": year_min,
            "yearMax": year_max,
            "minCategory": min_category,
            "landfallOnly": landfall_only,
        },
    }
