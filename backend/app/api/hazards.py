"""Hazard-overlay endpoint — per-county scores for hail / tornado / wildfire.

Frontend chooses one peril at a time and paints the county tileset via
feature-state; the legend metadata travels with the score payload so the
UI can render a colour bar with the right unit + source attribution.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..models.common import CamelModel
from ..services.hazard_overlay import HazardType, build_scores

router = APIRouter(prefix="/hazards", tags=["hazards"])


class HazardScoreOut(CamelModel):
    geoid: str
    raw: float
    normalised: float
    rank_pct: float


class HazardLegendOut(CamelModel):
    title: str
    unit: str
    source: str
    source_url: str
    raw_min: float
    raw_max: float
    palette: list[str]
    stops: list[float]
    note: str | None = None


class HazardResponse(CamelModel):
    hazard: str
    scores: list[HazardScoreOut]
    legend: HazardLegendOut


_VALID: tuple[HazardType, ...] = ("tornado", "hail", "wildfire")


@router.get("/{hazard}", response_model=HazardResponse)
def get_hazard(hazard: str) -> HazardResponse:
    if hazard not in _VALID:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "VALIDATION_ERROR",
                "message": f"Unknown hazard '{hazard}'. Valid: {_VALID}.",
            },
        )
    scores, legend = build_scores(hazard)  # type: ignore[arg-type]
    return HazardResponse(
        hazard=hazard,
        scores=[
            HazardScoreOut(
                geoid=s.geoid, raw=s.raw, normalised=s.normalised, rank_pct=s.rank_pct,
            )
            for s in scores
        ],
        legend=HazardLegendOut(
            title=legend.title,
            unit=legend.unit,
            source=legend.source,
            source_url=legend.source_url,
            raw_min=legend.raw_min,
            raw_max=legend.raw_max,
            palette=legend.palette,
            stops=legend.stops,
            note=legend.note,
        ),
    )


__all__ = ["router"]
