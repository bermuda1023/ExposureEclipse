"""Live + replay hurricane endpoint.

GET  /api/live/storms                 — picker rows: active NHC storms + replay candidates
GET  /api/live/storms/{atcf_id}       — full bundle for one storm:
                                          observed track, forecast (latest + history),
                                          alerts in cone, buoys + land stations in cone,
                                          SST grid covering the bbox

Replay mode (default for retired storms): synthesises prior-advisory tracks
from the IBTrACS truth. Live mode: just the NHC current summary — full
text-advisory scraping is out of scope for v1.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..models.common import CamelModel
from ..services.hurdat2 import category_for_wind
from ..services.live_hurricane import (
    LiveStormSummary,
    build_wind_cones,
    fetch_active_summaries,
    replay_summaries,
    storm_and_forecasts,
)
from ..services.marine_obs import buoys_in_bbox, land_stations_in_bbox
from ..services.sea_surface_temp import sst_grid
from ..services.weather_alerts import fetch_active_alerts

router = APIRouter(prefix="/live", tags=["live"])


# ─────────────────────────── wire types ───────────────────────────


class LiveStormRow(CamelModel):
    storm_id: str
    name: str
    year: int
    classification: str
    intensity_kt: int
    pressure_mb: int | None
    lat: float | None
    lon: float | None
    is_live: bool
    label: str


class LiveStormListResponse(CamelModel):
    active: list[LiveStormRow]
    replay: list[LiveStormRow]
    has_active: bool
    note: str | None = None


class ObservedFix(CamelModel):
    lat: float
    lon: float
    wind_kt: int
    category: int
    status: str
    datetime: str


class ForecastFix(CamelModel):
    lat: float
    lon: float
    wind_kt: int
    hours_out: int
    valid_time: str


class ForecastAdvisory(CamelModel):
    advisory_number: int
    issued_at: str
    points: list[ForecastFix]
    synthetic: bool


class WeatherAlertOut(CamelModel):
    alert_id: str
    event: str
    headline: str
    severity: str
    urgency: str
    certainty: str
    sent_at: str
    expires_at: str
    areas_affected: str
    geometry: dict | None


class BuoyOut(CamelModel):
    station_id: str
    lat: float
    lon: float
    wind_kt: float | None
    wind_dir_deg: float | None
    gust_kt: float | None
    wave_height_ft: float | None
    pressure_mb: float | None
    air_temp_f: float | None
    water_temp_f: float | None
    observed_at: str


class LandObsOut(CamelModel):
    station_id: str
    name: str
    lat: float
    lon: float
    wind_kt: float | None
    wind_dir_deg: float | None
    gust_kt: float | None
    pressure_mb: float | None
    temp_f: float | None
    observed_at: str


class SSTOut(CamelModel):
    lat: float
    lon: float
    temp_c: float
    favorable_for_intensification: bool


class ConeQuadOut(CamelModel):
    corners: list[list[float]]   # closed ring [[lon,lat], ...]
    wind_kt: int
    start_wind_kt: int
    end_wind_kt: int


class OuterRingOut(CamelModel):
    corners: list[list[float]]
    wind_kt: int
    r64_nm: float
    r64_source: str


class WindFieldOut(CamelModel):
    inner_cone: list[ConeQuadOut]
    outer_cone: list[ConeQuadOut]
    outer_rings: list[OuterRingOut]


class LiveStormBundle(CamelModel):
    storm: LiveStormRow
    observed_track: list[ObservedFix]
    forecasts: list[ForecastAdvisory]      # latest first
    bbox: list[float]                      # [west, south, east, north]
    alerts: list[WeatherAlertOut]
    buoys: list[BuoyOut]
    land_stations: list[LandObsOut]
    sst: list[SSTOut]
    sst_min_c: float | None
    sst_max_c: float | None
    # Wind fields built from the same IBTrACS-driven Rmax + R64 quads we use
    # for historical impact. `observed` covers the track to date; `forecast`
    # is the latest advisory's projected track.
    observed_wind_field: WindFieldOut
    forecast_wind_field: WindFieldOut


# ─────────────────────────── helpers ───────────────────────────


def _summary_to_row(s: LiveStormSummary) -> LiveStormRow:
    return LiveStormRow(
        storm_id=s.storm_id,
        name=s.name,
        year=s.year,
        classification=s.classification,
        intensity_kt=s.intensity_kt,
        pressure_mb=s.pressure_mb,
        lat=s.lat,
        lon=s.lon,
        is_live=s.is_live,
        label=s.label,
    )


def _bbox_for_storm(observed_track, forecasts) -> tuple[float, float, float, float]:
    """Bbox for fetching nearby live data — last day of observed + all forecast.

    Using the storm's entire historical path would pull most of the Atlantic
    for a long-lived hurricane like Michael; we only need the bbox where
    overlays (alerts, buoys, SST) matter operationally.
    """
    recent = observed_track[-8:] if len(observed_track) >= 8 else observed_track
    lats: list[float] = [p.lat for p in recent]
    lons: list[float] = [p.lon for p in recent]
    for adv in forecasts:
        lats.extend(p.lat for p in adv.points)
        lons.extend(p.lon for p in adv.points)
    if not lats:
        return (-100.0, 10.0, -50.0, 50.0)
    # Pad ~3° so the cone of uncertainty + observation buffer fits.
    west = min(lons) - 3.0
    east = max(lons) + 3.0
    south = min(lats) - 3.0
    north = max(lats) + 3.0
    return (west, south, east, north)


def _states_in_bbox(bbox: tuple[float, float, float, float]) -> list[str]:
    """Rough state filter for NWS alerts: returns the USPS codes whose
    bounding boxes overlap ``bbox``. Used to narrow the alerts request.
    Coarse — better to over-request than miss an alert."""
    # Very coarse state bboxes (lon_min, lat_min, lon_max, lat_max). Only
    # hurricane-prone states; everything else falls through to "all".
    STATE_BBOXES = {
        "FL": (-87.6, 24.5, -80.0, 31.0),
        "GA": (-85.6, 30.4, -80.8, 35.0),
        "SC": (-83.4, 32.0, -78.5, 35.2),
        "NC": (-84.4, 33.8, -75.4, 36.6),
        "VA": (-83.7, 36.5, -75.2, 39.5),
        "AL": (-88.5, 30.2, -84.9, 35.0),
        "MS": (-91.7, 30.2, -88.1, 35.0),
        "LA": (-94.0, 28.9, -89.0, 33.0),
        "TX": (-106.6, 25.8, -93.5, 36.5),
        "NY": (-79.8, 40.5, -71.9, 45.0),
        "NJ": (-75.6, 38.9, -73.9, 41.4),
        "MA": (-73.5, 41.2, -69.9, 42.9),
        "PR": (-67.3, 17.9, -65.2, 18.5),
    }
    west, south, east, north = bbox
    states: list[str] = []
    for code, (w, s, e, n) in STATE_BBOXES.items():
        if not (e < west or w > east or n < south or s > north):
            states.append(code)
    return states


# ─────────────────────────── endpoints ───────────────────────────


@router.get("/storms", response_model=LiveStormListResponse)
def list_live_storms() -> LiveStormListResponse:
    """Active NHC storms + curated replay candidates (always available)."""
    active = [_summary_to_row(s) for s in fetch_active_summaries()]
    replay = [_summary_to_row(s) for s in replay_summaries()]
    note = None
    if not active:
        note = (
            "No active Atlantic storms right now. Pick a replay storm below "
            "for a demo of the live-data overlays."
        )
    return LiveStormListResponse(
        active=active,
        replay=replay,
        has_active=bool(active),
        note=note,
    )


@router.get("/storms/{atcf_id}", response_model=LiveStormBundle)
def live_storm_bundle(
    atcf_id: str,
    as_of_index: int | None = Query(default=None, ge=0, alias="asOfIndex"),
    include_obs: bool = Query(default=True, alias="includeObs"),
    include_alerts: bool = Query(default=True, alias="includeAlerts"),
    include_sst: bool = Query(default=True, alias="includeSst"),
    include_land: bool = Query(default=True, alias="includeLand"),
) -> LiveStormBundle:
    """Full data bundle for one storm — track + forecast + obs + alerts + SST."""
    result = storm_and_forecasts(atcf_id, as_of_index=as_of_index)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DATASET_NOT_FOUND",
                "message": f"Storm '{atcf_id}' not found in IBTrACS replay set.",
            },
        )
    observed_storm, forecasts = result

    observed_fixes = [
        ObservedFix(
            lat=p.lat,
            lon=p.lon,
            wind_kt=p.wind_kt,
            category=category_for_wind(p.wind_kt),
            status=p.status,
            datetime=p.datetime_utc,
        )
        for p in observed_storm.track
    ]
    forecast_out = [
        ForecastAdvisory(
            advisory_number=adv.advisory_number,
            issued_at=adv.issued_at,
            points=[
                ForecastFix(
                    lat=fp.lat,
                    lon=fp.lon,
                    wind_kt=fp.wind_kt,
                    hours_out=fp.hours_out,
                    valid_time=fp.valid_time,
                )
                for fp in adv.points
            ],
            synthetic=adv.synthetic,
        )
        for adv in forecasts
    ]

    bbox = _bbox_for_storm(observed_storm.track, forecasts)

    alerts_out: list[WeatherAlertOut] = []
    if include_alerts:
        # Live alerts as of today — used for demo even when the replay storm
        # is historical, per user instruction.
        states = _states_in_bbox(bbox)
        for a in fetch_active_alerts(bbox=bbox, states=states or None):
            alerts_out.append(
                WeatherAlertOut(
                    alert_id=a.alert_id,
                    event=a.event,
                    headline=a.headline,
                    severity=a.severity,
                    urgency=a.urgency,
                    certainty=a.certainty,
                    sent_at=a.sent_at,
                    expires_at=a.expires_at,
                    areas_affected=a.areas_affected,
                    geometry=a.geometry,
                )
            )

    buoys_out: list[BuoyOut] = []
    land_out: list[LandObsOut] = []
    if include_obs:
        for b in buoys_in_bbox(*bbox):
            buoys_out.append(
                BuoyOut(
                    station_id=b.station_id,
                    lat=b.lat,
                    lon=b.lon,
                    wind_kt=b.wind_kt,
                    wind_dir_deg=b.wind_dir_deg,
                    gust_kt=b.gust_kt,
                    wave_height_ft=b.wave_height_ft,
                    pressure_mb=b.pressure_mb,
                    air_temp_f=b.air_temp_f,
                    water_temp_f=b.water_temp_f,
                    observed_at=b.observed_at,
                )
            )
    if include_land:
        for ls in land_stations_in_bbox(*bbox, max_stations=40):
            land_out.append(
                LandObsOut(
                    station_id=ls.station_id,
                    name=ls.name,
                    lat=ls.lat,
                    lon=ls.lon,
                    wind_kt=ls.wind_kt,
                    wind_dir_deg=ls.wind_dir_deg,
                    gust_kt=ls.gust_kt,
                    pressure_mb=ls.pressure_mb,
                    temp_f=ls.temp_f,
                    observed_at=ls.observed_at,
                )
            )

    sst_out: list[SSTOut] = []
    sst_min = sst_max = None
    if include_sst:
        # 0.25° step (the OISST native resolution) for a real heatmap look;
        # bbox-adaptive so we don't ship 100k+ cells for a basin-wide storm.
        span = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
        if span < 12:
            step = 0.25
        elif span < 25:
            step = 0.5
        else:
            step = 1.0
        grid = sst_grid(bbox=bbox, step_deg=step)
        sst_out = [
            SSTOut(
                lat=p.lat,
                lon=p.lon,
                temp_c=p.temp_c,
                favorable_for_intensification=p.favorable_for_intensification,
            )
            for p in grid
        ]
        if grid:
            sst_min = round(min(p.temp_c for p in grid), 1)
            sst_max = round(max(p.temp_c for p in grid), 1)

    storm_row = LiveStormRow(
        storm_id=observed_storm.storm_id,
        name=observed_storm.name,
        year=observed_storm.year,
        classification=observed_storm.track[-1].status,
        intensity_kt=max((p.wind_kt for p in observed_storm.track), default=0),
        pressure_mb=observed_storm.track[-1].pressure_mb,
        lat=observed_storm.track[-1].lat,
        lon=observed_storm.track[-1].lon,
        is_live=False,
        label=f"{observed_storm.name} ({observed_storm.year})",
    )

    # Wind fields: inner Rmax + outer asymmetric R64, same machinery as
    # historical impact. Built for the OBSERVED track (history) and the
    # LATEST forecast advisory (projection).
    observed_fixes_for_cone = [
        (p.lat, p.lon, p.wind_kt, p.datetime_utc) for p in observed_storm.track
    ]
    obs_fp, obs_inner, obs_outer, obs_rings = build_wind_cones(
        observed_storm.storm_id, observed_fixes_for_cone
    )

    if forecasts:
        latest = max(forecasts, key=lambda f: f.advisory_number)
        forecast_fixes_for_cone = [
            (fp.lat, fp.lon, fp.wind_kt, fp.valid_time) for fp in latest.points
        ]
        _fp_fcst, fcst_inner, fcst_outer, fcst_rings = build_wind_cones(
            observed_storm.storm_id, forecast_fixes_for_cone
        )
    else:
        fcst_inner, fcst_outer, fcst_rings = [], [], []

    def _q_out(q) -> ConeQuadOut:
        return ConeQuadOut(
            corners=[
                [round(lon, 4), round(lat, 4)] for (lon, lat) in q.corners
            ] + [[round(q.corners[0][0], 4), round(q.corners[0][1], 4)]],
            wind_kt=q.wind_kt,
            start_wind_kt=q.start_wind_kt,
            end_wind_kt=q.end_wind_kt,
        )

    def _r_out(r: dict) -> OuterRingOut:
        return OuterRingOut(
            corners=r["ring"],
            wind_kt=r["wind_kt"],
            r64_nm=round(r["r64_nm"], 1),
            r64_source=r["r64_source"],
        )

    observed_wind = WindFieldOut(
        inner_cone=[_q_out(q) for q in obs_inner],
        outer_cone=[_q_out(q) for q in obs_outer],
        outer_rings=[_r_out(r) for r in obs_rings],
    )
    forecast_wind = WindFieldOut(
        inner_cone=[_q_out(q) for q in fcst_inner],
        outer_cone=[_q_out(q) for q in fcst_outer],
        outer_rings=[_r_out(r) for r in fcst_rings],
    )

    return LiveStormBundle(
        storm=storm_row,
        observed_track=observed_fixes,
        forecasts=forecast_out,
        bbox=list(bbox),
        alerts=alerts_out,
        buoys=buoys_out,
        land_stations=land_out,
        sst=sst_out,
        sst_min_c=sst_min,
        sst_max_c=sst_max,
        observed_wind_field=observed_wind,
        forecast_wind_field=forecast_wind,
    )


__all__ = ["router"]
