"""Live flood endpoint — active NWS flood watches, warnings and advisories.

GET /api/flood/active
    ?bbox=west,south,east,north   (optional; omit for nationwide)
    &minSeverity=Minor            (Unknown|Minor|Moderate|Severe|Extreme)

Returns a GeoJSON FeatureCollection of polygon-bearing flood alerts, a
per-state roll-up, and notes explaining anything that was dropped.

POST /api/flood/exposure
    Exposed TIV by client for a set of selected alert polygons — same engine
    and the same rules-3+4 rollup the wildfire overlay uses.

Live overlay, like /live/storms and /wildfire/active — not part of the mock
data plane. Source: NWS api.weather.gov.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from ..models.common import CamelModel
from ..services import wildfire_exposure
from ..services.live_flood import SEVERITY_ORDER, SEVERITY_RANK, fetch_flood_alerts
from .geometry_input import ExposureRequest, PolygonExposureOut, exposure_out

router = APIRouter(prefix="/flood", tags=["flood"])


# ─────────────────────────── wire types ───────────────────────────


class AffectedStateOut(CamelModel):
    state: str
    alert_count: int


class FloodCounts(CamelModel):
    alerts: int
    zone_only: int


class FloodAttribution(CamelModel):
    alerts: str = "NOAA / National Weather Service active alerts"
    alerts_url: str = "https://api.weather.gov/alerts/active"


class FloodResponse(CamelModel):
    generated_at: str
    bbox: list[float] | None
    min_severity: str
    alerts: dict  # GeoJSON FeatureCollection
    affected_states: list[AffectedStateOut]
    counts: FloodCounts
    notes: list[str]
    attribution: FloodAttribution


class FloodExposureResponse(CamelModel):
    currency: str
    synthetic: bool
    note: str
    results: list[PolygonExposureOut]
    combined: PolygonExposureOut
    warnings: list[str]


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


# ─────────────────────────── routes ───────────────────────────


@router.get("/active", response_model=FloodResponse)
def get_active_flood(
    bbox: str | None = Query(default=None, description="west,south,east,north (lon/lat)"),
    min_severity: str = Query(default="Unknown", alias="minSeverity"),
) -> FloodResponse:
    """Active NWS flood alerts that carry mappable geometry.

    Only polygon-bearing alerts are returned. Zone-coded alerts (Coastal,
    Lakeshore, and most Watch products) are counted in ``counts.zoneOnly`` and
    explained in ``notes`` rather than silently dropped — they have no geometry
    to draw or intersect.

    Alert polygons are *warning areas*, often drawn to county or zone
    boundaries rather than observed water extent, so exposed TIV derived from
    them is an upper bound. See docs/API.md §GET /api/flood/active.

    Args:
        bbox: Bounding box ``"west,south,east,north"`` (lon/lat, EPSG:4326).
            Omit for nationwide.
        min_severity: Drop alerts below this NWS CAP severity. Use ``Severe``
            to approximate "major flooding only" — it is the only severity
            signal that arrives attached to the geometry.

    Returns:
        FloodResponse with the alert FeatureCollection, per-state roll-up,
        counts, notes and attribution.

    Raises:
        HTTPException 422: If ``bbox`` is malformed or ``minSeverity`` is not
            a recognised CAP severity.
    """
    box = _parse_bbox(bbox)
    if min_severity not in SEVERITY_RANK:
        raise HTTPException(status_code=422, detail={
            "code": "VALIDATION_ERROR",
            "message": f"minSeverity must be one of {', '.join(SEVERITY_ORDER)}.",
        })

    bundle = fetch_flood_alerts(bbox=box, min_severity=min_severity)

    features = [
        {
            "type": "Feature",
            # NWS alert ids are stable URNs, so unlike the wildfire heat shapes
            # there is nothing to hash — the upstream id is the selection key.
            "id": a.alert_id,
            "geometry": a.geometry,
            "properties": {
                "alertId": a.alert_id,
                "event": a.event,
                "headline": a.headline,
                "severity": a.severity,
                # Numeric twin of `severity` so the map ramp can interpolate
                # without a string match expression.
                "severityRank": SEVERITY_RANK.get(a.severity, 0),
                "urgency": a.urgency,
                "certainty": a.certainty,
                "sentAt": a.sent_at,
                "expiresAt": a.expires_at,
                "areaDesc": a.areas_affected,
            },
        }
        for a in bundle.alerts
    ]

    return FloodResponse(
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        bbox=list(box) if box else None,
        min_severity=min_severity,
        alerts={"type": "FeatureCollection", "features": features},
        affected_states=[
            AffectedStateOut(state=st, alert_count=n) for (st, n) in bundle.affected_states
        ],
        counts=FloodCounts(alerts=len(bundle.alerts), zone_only=bundle.zone_only_count),
        notes=bundle.notes,
        attribution=FloodAttribution(),
    )


@router.post("/exposure", response_model=FloodExposureResponse)
def post_flood_exposure(req: ExposureRequest) -> FloodExposureResponse:
    """Roll up exposed TIV by client for the supplied flood-alert polygons.

    ``results`` holds one entry per polygon. ``combined`` is the union across
    all of them with each location counted once — adjacent flood warnings
    routinely overlap, and summing the per-polygon totals would double-count
    the shared ground.

    TIV is combined max-across-perils at the (client, county) grain per
    CLAUDE.md rules 3+4. v1 uses synthetic location points derived from
    county-aggregated TIV — see ``synthetic``/``note``.
    """
    try:
        per, union = wildfire_exposure.exposure_in_polygons(
            [p.geometry for p in req.polygons]
        )
        currency = wildfire_exposure.currency()
        warnings = list(wildfire_exposure.load_warnings())
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail={
            "code": "UPSTREAM_UNAVAILABLE",
            "message": f"Exposure data could not be loaded: {exc}",
        }) from exc
    except ValueError as exc:
        # Geometry passed per-field validation but would cost too much to
        # evaluate; that is a bad request, not a server fault.
        raise HTTPException(status_code=422, detail={
            "code": "GEOMETRY_TOO_COMPLEX",
            "message": str(exc),
        }) from exc

    results = [exposure_out(p.id, p.name, r) for p, r in zip(req.polygons, per)]
    combined = exposure_out("combined", None, union)

    return FloodExposureResponse(
        currency=currency,
        synthetic=True,
        note=("Estimated from synthetic location points distributed within counties "
              "from aggregate TIV — not real location-level data. Alert polygons are "
              "warning areas rather than observed water extent, so this is an upper "
              "bound on the affected area."),
        results=results,
        combined=combined,
        warnings=warnings,
    )


__all__ = ["router"]
