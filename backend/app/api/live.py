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
    fetch_live_forecast_cone,
    fetch_live_peak_surge,
    replay_summaries,
    storm_and_forecasts,
)
from ..services.marine_obs import buoys_in_bbox, land_stations_in_bbox
from ..services.sea_surface_temp import sst_field
from ..services.weather_alerts import fetch_active_alerts
from ..services.wind_field_map import wind_field_grid
from ..services.wind_forecast import fetch_model_wind_grid, point_forecast

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


class SSTMeta(CamelModel):
    source: str        # 'mur' | 'synthetic'
    step_deg: float    # native cell size — frontend uses this to size polygons


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


class ForecastConeOut(CamelModel):
    """NHC's official forecast cone of uncertainty. Live storms only — empty
    ring on retired/replay storms."""

    ring: list[list[float]]   # [[lon, lat], ...] closed outer boundary


class SurgePolygonOut(CamelModel):
    """One NHC peak-storm-surge band polygon (e.g. '3-6 ft' inundation)."""

    ring: list[list[float]]
    surge_range: str
    color: str


class WindGridPointOut(CamelModel):
    """One cell of the interpolated surface-wind field.

    ``wind_dir_deg`` uses meteorological FROM convention (0°=N, 90°=E).
    ``sources`` counts contributing observations. ``confidence`` is a 0..1
    composite of source count, distance to nearest obs, and speed agreement
    across contributors. ``nearest_obs_km`` is the raw distance to the
    closest contributing obs — surfaced in the click popup so the user can
    see the underlying signal directly."""

    lat: float
    lon: float
    wind_kt: float
    wind_dir_deg: float | None
    sources: int
    confidence: float
    nearest_obs_km: float | None
    # Score breakdown (all 0..1). Multiply to get confidence.
    dist_score: float
    count_score: float
    agreement_score: float
    contributor_spread_kt: float | None


class WindGridMeta(CamelModel):
    step_deg: float
    obs_max_age_hours: float
    idw_radius_km: float


class WindObsOut(CamelModel):
    """One cleaned surface observation used to build the wind heatmap.
    Shipped in the bundle so the frontend can drill down from a cell click
    ('N sources') to the actual contributing stations."""

    lat: float
    lon: float
    wind_kt: float
    wind_dir_deg: float | None
    source: str          # "buoy" | "land"
    station_id: str
    observed_at: str


class WindModelCellOut(CamelModel):
    """One cell of a GFS or ECMWF wind grid, aligned to the observed grid
    so obs/model diffs are trivial cell-by-cell subtractions."""

    lat: float
    lon: float
    wind_kt: float
    wind_dir_deg: float | None


class WindModelGridOut(CamelModel):
    model: str            # "gfs" | "ecmwf"
    step_deg: float
    cells: list[WindModelCellOut]
    valid_time_utc: str


class ModelForecastOut(CamelModel):
    """One NWP model's wind forecast at a single point + time."""

    model: str            # "gfs" | "ecmwf"
    valid_time_utc: str
    wind_kt: float
    wind_dir_deg: float | None
    wind_gust_kt: float | None


class PointForecastOut(CamelModel):
    """Wind at a lat/lon, per model. Empty ``forecasts`` when Open-Meteo is
    unreachable; the click UI shows 'model data unavailable' in that case."""

    lat: float
    lon: float
    fetched_at_utc: str
    forecasts: list[ModelForecastOut]


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
    sst_meta: SSTMeta
    # Wind fields built from the same IBTrACS-driven Rmax + R64 quads we use
    # for historical impact. `observed` covers the track to date; `forecast`
    # is the latest advisory's projected track.
    observed_wind_field: WindFieldOut
    forecast_wind_field: WindFieldOut
    # NHC-issued products, populated only for live storms. `forecast_cone` is
    # the swept-circle envelope from NHC's cone KMZ; `peak_surge` is the
    # per-band coastal inundation polygons from NHC's peak-surge KML.
    forecast_cone: ForecastConeOut | None
    peak_surge: list[SurgePolygonOut]
    # Interpolated surface-wind heatmap (IDW over NDBC buoys + NWS land obs).
    # Empty when include_wind_map is off or no fresh obs are in the bbox.
    wind_map: list[WindGridPointOut]
    wind_map_meta: WindGridMeta
    # The cleaned obs pool that fed the heatmap. Shipped so the click popup
    # can show contributor stations for any given cell.
    wind_obs: list[WindObsOut]


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
    include_surge: bool = Query(default=True, alias="includeSurge"),
    include_wind_map: bool = Query(default=True, alias="includeWindMap"),
) -> LiveStormBundle:
    """Full data bundle for one storm — track + forecast + obs + alerts + SST."""
    result = storm_and_forecasts(atcf_id, as_of_index=as_of_index)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DATASET_NOT_FOUND",
                "message": (
                    f"Storm '{atcf_id}' not found in the live NHC feed or the "
                    "replay set."
                ),
            },
        )
    observed_storm, forecasts, is_live = result

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
        # max_stations=80 is the service default — gives a spatially uniform
        # grid subsample instead of clumping into whichever region has the
        # densest instrumentation.
        for ls in land_stations_in_bbox(*bbox):
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
    sst_source = "synthetic"
    span = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    sst_step = 0.05 if span < 6 else 0.10 if span < 12 else 0.25 if span < 25 else 0.5
    if include_sst:
        grid, sst_source = sst_field(bbox)
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
        is_live=is_live,
        label=f"{observed_storm.name} ({observed_storm.year})",
    )

    # Wind fields: inner Rmax + outer asymmetric R64, same machinery as
    # historical impact. Built for the OBSERVED track (history) and the
    # LATEST forecast advisory (projection). For LIVE storms we pass
    # storm_id="" to disable the IBTrACS Rmax/R64 lookups — those datasets
    # never contain the current year, and even the failing lookup would
    # trigger a 70 MB CSV fetch that blew Vercel's cold-start budget.
    cone_storm_id = "" if is_live else observed_storm.storm_id
    observed_fixes_for_cone = [
        (p.lat, p.lon, p.wind_kt, p.datetime_utc) for p in observed_storm.track
    ]
    obs_fp, obs_inner, obs_outer, obs_rings = build_wind_cones(
        cone_storm_id, observed_fixes_for_cone
    )

    if forecasts:
        latest = max(forecasts, key=lambda f: f.advisory_number)
        forecast_fixes_for_cone = [
            (fp.lat, fp.lon, fp.wind_kt, fp.valid_time) for fp in latest.points
        ]
        _fp_fcst, fcst_inner, fcst_outer, fcst_rings = build_wind_cones(
            cone_storm_id, forecast_fixes_for_cone
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

    # NHC-issued products only exist for live storms. Cone is a single ring;
    # peak surge is per-band coloured polygons along the coast.
    forecast_cone_out: ForecastConeOut | None = None
    peak_surge_out: list[SurgePolygonOut] = []
    if is_live:
        cone_ring = fetch_live_forecast_cone(atcf_id)
        if cone_ring:
            forecast_cone_out = ForecastConeOut(
                ring=[[round(lon, 4), round(lat, 4)] for lon, lat in cone_ring],
            )
        if include_surge:
            for poly in fetch_live_peak_surge(atcf_id):
                peak_surge_out.append(
                    SurgePolygonOut(
                        ring=[[round(lon, 5), round(lat, 5)] for lon, lat in poly.coords],
                        surge_range=poly.surge_range,
                        color=poly.color,
                    )
                )

    # Interpolated wind heatmap. Runs for any storm (live or replay) since it
    # is purely observation-driven; caller can turn it off if the extra land
    # -station fetch is too slow.
    wind_map_out: list[WindGridPointOut] = []
    wind_obs_out: list[WindObsOut] = []
    wind_step = 0.5
    if include_wind_map:
        cells, wind_step, obs_pool = wind_field_grid(*bbox)
        wind_map_out = [
            WindGridPointOut(
                lat=c.lat,
                lon=c.lon,
                wind_kt=c.wind_kt,
                wind_dir_deg=c.wind_dir_deg,
                sources=c.sources,
                confidence=c.confidence,
                nearest_obs_km=c.nearest_obs_km,
                dist_score=c.dist_score,
                count_score=c.count_score,
                agreement_score=c.agreement_score,
                contributor_spread_kt=c.contributor_spread_kt,
            )
            for c in cells
        ]
        wind_obs_out = [
            WindObsOut(
                lat=o.lat, lon=o.lon,
                wind_kt=o.wind_kt, wind_dir_deg=o.wind_dir_deg,
                source=o.source, station_id=o.station_id,
                observed_at=o.observed_at,
            )
            for o in obs_pool
        ]

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
        sst_meta=SSTMeta(source=sst_source, step_deg=sst_step),
        observed_wind_field=observed_wind,
        forecast_wind_field=forecast_wind,
        forecast_cone=forecast_cone_out,
        peak_surge=peak_surge_out,
        wind_map=wind_map_out,
        wind_map_meta=WindGridMeta(
            step_deg=wind_step, obs_max_age_hours=4.0, idw_radius_km=333.0,
        ),
        wind_obs=wind_obs_out,
    )


@router.get("/wind-model-grid", response_model=WindModelGridOut)
def wind_model_grid(
    west: float = Query(..., ge=-180.0, le=180.0),
    south: float = Query(..., ge=-90.0, le=90.0),
    east: float = Query(..., ge=-180.0, le=180.0),
    north: float = Query(..., ge=-90.0, le=90.0),
    model: str = Query(..., pattern="^(gfs|ecmwf)$"),
) -> WindModelGridOut:
    """GFS or ECMWF surface-wind grid over a bbox at 0.5° resolution.

    Powers the "flip between obs / GFS / ECMWF / diff" mode on the live wind
    heatmap. Cell step is aligned with the observed grid so diffs are cheap
    cell-to-cell on the frontend. Fetches from Open-Meteo — degrades to an
    empty grid on failure rather than 5xx'ing the mode selector."""
    grid = fetch_model_wind_grid(west, south, east, north, model)
    return WindModelGridOut(
        model=grid.model,
        step_deg=grid.step_deg,
        valid_time_utc=grid.valid_time_utc,
        cells=[
            WindModelCellOut(
                lat=c.lat, lon=c.lon,
                wind_kt=c.wind_kt, wind_dir_deg=c.wind_dir_deg,
            )
            for c in grid.cells
        ],
    )


@router.get("/wind-forecast", response_model=PointForecastOut)
def wind_forecast_at_point(
    lat: float = Query(..., ge=-90.0, le=90.0),
    lon: float = Query(..., ge=-180.0, le=180.0),
) -> PointForecastOut:
    """GFS + ECMWF surface-wind forecast for a single point.

    Powers the click-to-inspect popup on the interpolated wind heatmap —
    users see obs vs both models side-by-side to sanity-check the field
    (agreement = high confidence; large disagreement = the observation is
    unusual or a model is off, either way worth flagging)."""
    result = point_forecast(lat, lon)
    return PointForecastOut(
        lat=result.lat,
        lon=result.lon,
        fetched_at_utc=result.fetched_at_utc,
        forecasts=[
            ModelForecastOut(
                model=f.model,
                valid_time_utc=f.valid_time_utc,
                wind_kt=f.wind_kt,
                wind_dir_deg=f.wind_dir_deg,
                wind_gust_kt=f.wind_gust_kt,
            )
            for f in result.forecasts
        ],
    )


__all__ = ["router"]
