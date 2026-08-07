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
from ..services import wildfire_exposure

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
    active_fires_total: int
    heat_shapes: int


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
    perimeters: dict     # GeoJSON FeatureCollection (official WFIGS)
    heat_shapes: dict    # GeoJSON FeatureCollection (built from FIRMS clusters)
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
    day_range: int = Query(default=3, ge=1, le=30, alias="dayRange"),  # chained ≤5d FIRMS windows
    include_heat: bool = Query(default=True, alias="includeHeat"),
    include_perimeters: bool = Query(default=True, alias="includePerimeters"),
    simplify: float = Query(
        default=0.005, ge=0.0, le=0.05,
        description="Perimeter generalisation in degrees (0 = full resolution).",
    ),
    min_cells: int = Query(default=2, ge=1, le=20, alias="minCells"),
    min_detections: int = Query(default=4, ge=1, le=200, alias="minDetections"),
    min_confidence: str = Query(default="nominal", alias="minConfidence"),
    min_frp: float = Query(default=0.0, ge=0.0, alias="minFrp"),
) -> WildfireResponse:
    box = _parse_bbox(bbox)
    if min_confidence not in ("low", "nominal", "high"):
        raise HTTPException(status_code=422, detail={
            "code": "VALIDATION_ERROR",
            "message": "minConfidence must be low, nominal, or high.",
        })
    settings = get_settings()
    bundle = build_wildfire_bundle(
        map_key=settings.firms_map_key,
        bbox=box,
        day_range=day_range,
        include_heat=include_heat,
        simplify_deg=simplify,
        min_cells=min_cells,
        min_detections=min_detections,
        min_confidence=min_confidence,
        min_frp=min_frp,
        include_perimeters=include_perimeters,
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

    heat_features = [
        {
            "type": "Feature",
            "geometry": hs.geometry,
            "properties": {
                "detectionCount": hs.detection_count,
                "maxFrpMw": hs.max_frp_mw,
                "sumFrpMw": hs.sum_frp_mw,
                "firstDetectedAt": hs.first_detected_at,
                "lastDetectedAt": hs.last_detected_at,
            },
        }
        for hs in bundle.heat_shapes
    ]

    return WildfireResponse(
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        bbox=list(box) if box else None,
        day_range=day_range,
        perimeters={"type": "FeatureCollection", "features": features},
        heat_shapes={"type": "FeatureCollection", "features": heat_features},
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
            active_fires_total=bundle.detections_total,
            heat_shapes=len(bundle.heat_shapes),
        ),
        notes=bundle.notes,
        attribution=WildfireAttribution(),
    )


# ─────────────────── exposed TIV inside fire polygons ───────────────────


class PolygonIn(CamelModel):
    id: str
    name: str | None = None
    geometry: dict  # GeoJSON Polygon / MultiPolygon


class ExposureRequest(CamelModel):
    polygons: list[PolygonIn]


class ClientExposureOut(CamelModel):
    client: str
    tiv: float
    location_count: int


class PolygonExposureOut(CamelModel):
    id: str
    name: str | None
    total_tiv: float
    location_count: int
    by_client: list[ClientExposureOut]


class WildfireExposureResponse(CamelModel):
    currency: str
    synthetic: bool
    note: str
    results: list[PolygonExposureOut]


@router.post("/exposure", response_model=WildfireExposureResponse)
def post_wildfire_exposure(req: ExposureRequest) -> WildfireExposureResponse:
    """Roll up exposed TIV by client for each supplied fire polygon (official
    perimeter or heat-derived shape). v1 uses synthetic location points derived
    from county-aggregated TIV — see `synthetic`/`note`."""
    if len(req.polygons) > 50:
        raise HTTPException(status_code=422, detail={
            "code": "VALIDATION_ERROR",
            "message": "At most 50 polygons per request.",
        })
    results: list[PolygonExposureOut] = []
    for poly in req.polygons:
        total, count, by_client = wildfire_exposure.exposure_in_polygon(poly.geometry)
        results.append(PolygonExposureOut(
            id=poly.id,
            name=poly.name,
            total_tiv=round(total, 2),
            location_count=count,
            by_client=sorted(
                [ClientExposureOut(client=c, tiv=round(t, 2), location_count=n)
                 for c, (t, n) in by_client.items()],
                key=lambda x: -x.tiv,
            ),
        ))
    return WildfireExposureResponse(
        currency=wildfire_exposure.currency(),
        synthetic=True,
        note=("Estimated from synthetic location points distributed within counties "
              "from aggregate TIV — not real location-level data. Replace the location "
              "source with individual-location exposure for exact in-perimeter TIV."),
        results=results,
    )


__all__ = ["router"]
