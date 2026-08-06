"""Live wildfire endpoint — real burn-area perimeters + satellite heat.

GET /api/wildfire/active
    ?bbox=west,south,east,north   (optional; default CONUS)
    &dayRange=1                   (FIRMS look-back days, 1-10)
    &includeHeat=true             (fetch NASA FIRMS active-fire pixels)

Returns:
  - perimeters   GeoJSON FeatureCollection of current WFIGS fire polygons
                 (properties: name, acres, percentContained, cause, state, …)
  - activeFires  satellite thermal detections (VIIRS/MODIS) as points
  - affectedStates  per-state roll-up (join key to the exposure/TIV plane)
  - notes        degraded-layer explanations (e.g. FIRMS key missing)

Live overlay, like /live/storms — not part of the mock data plane. Sources:
NIFC/WFIGS (perimeters) + NASA FIRMS (heat).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from ..config import get_settings
from ..models.common import CamelModel
from ..services.live_wildfire import build_wildfire_bundle

router = APIRouter(prefix="/wildfire", tags=["wildfire"])


# ─────────────────────────── wire types ───────────────────────────


class ActiveFireOut(CamelModel):
    lat: float
    lon: float
    brightness_k: float | None
    frp_mw: float | None
    confidence: str | None
    satellite: str
    source: str
    acquired_at: str


class AffectedStateOut(CamelModel):
    state: str
    fire_count: int
    acres: float


class WildfireCounts(CamelModel):
    perimeters: int
    active_fires: int


class WildfireAttribution(CamelModel):
    perimeters: str = "NIFC / WFIGS Interagency Perimeters (Current)"
    perimeters_url: str = (
        "https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-interagency-perimeters-current"
    )
    active_fires: str = "NASA FIRMS (VIIRS/MODIS active fire, NRT)"
    active_fires_url: str = "https://firms.modaps.eosdis.nasa.gov/"


class WildfireResponse(CamelModel):
    generated_at: str
    bbox: list[float] | None
    day_range: int
    perimeters: dict  # GeoJSON FeatureCollection
    active_fires: list[ActiveFireOut]
    affected_states: list[AffectedStateOut]
    counts: WildfireCounts
    notes: list[str]
    attribution: WildfireAttribution


# ─────────────────────────── helpers ───────────────────────────


def _parse_bbox(raw: str | None) -> tuple[float, float, float, float] | None:
    if not raw:
        return None
    parts = raw.split(",")
    if len(parts) != 4:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR",
                    "message": "bbox must be 'west,south,east,north'."},
        )
    try:
        west, south, east, north = (float(p) for p in parts)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR", "message": "bbox values must be numbers."},
        )
    if not (west < east and south < north):
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR",
                    "message": "bbox must satisfy west<east and south<north."},
        )
    return (west, south, east, north)


# ─────────────────────────── route ───────────────────────────


@router.get("/active", response_model=WildfireResponse)
def get_active_wildfire(
    bbox: str | None = Query(default=None, description="west,south,east,north (lon/lat)"),
    day_range: int = Query(default=1, ge=1, le=10, alias="dayRange"),
    include_heat: bool = Query(default=True, alias="includeHeat"),
) -> WildfireResponse:
    box = _parse_bbox(bbox)
    settings = get_settings()
    bundle = build_wildfire_bundle(
        map_key=settings.firms_map_key,
        bbox=box,
        day_range=day_range,
        include_heat=include_heat,
    )

    features = [
        {
            "type": "Feature",
            "id": fp.incident_id,
            "geometry": fp.geometry,
            "properties": {
                "incidentId": fp.incident_id,
                "name": fp.name,
                "gisAcres": fp.gis_acres,
                "incidentSizeAcres": fp.incident_size_acres,
                "percentContained": fp.percent_contained,
                "cause": fp.cause,
                "discoveryAt": fp.discovery_at,
                "perimeterUpdatedAt": fp.perimeter_updated_at,
                "state": fp.state,
            },
        }
        for fp in bundle.perimeters
    ]

    return WildfireResponse(
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        bbox=list(box) if box else None,
        day_range=day_range,
        perimeters={"type": "FeatureCollection", "features": features},
        active_fires=[
            ActiveFireOut(
                lat=a.lat, lon=a.lon, brightness_k=a.brightness_k, frp_mw=a.frp_mw,
                confidence=a.confidence, satellite=a.satellite, source=a.source,
                acquired_at=a.acquired_at,
            )
            for a in bundle.active_fires
        ],
        affected_states=[
            AffectedStateOut(state=st, fire_count=n, acres=ac)
            for (st, n, ac) in bundle.affected_states
        ],
        counts=WildfireCounts(
            perimeters=len(bundle.perimeters),
            active_fires=len(bundle.active_fires),
        ),
        notes=bundle.notes,
        attribution=WildfireAttribution(),
    )


__all__ = ["router"]
