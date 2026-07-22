"""Live + replay hurricane data.

Live: fetches NHC's CurrentStorms.json and adapts each active storm to the
same Storm shape we use everywhere else (so the cone/impact/footprint code
just works).

Replay: for demo purposes when no Atlantic storm is active. The user picks
a recent retired storm (Helene 2024, Milton 2024, Beryl 2024, Ian 2022)
and we treat its IBTrACS track as the "currently observed" track. The
"as of now" point along the track is provided by the caller (or defaults
to the strongest fix), and the rest of the track is treated as forecast
truth. Synthetic prior-advisory tracks are produced by truncating the
track at earlier points + adding a small lateral perturbation — clearly
labelled as `synthetic` so the UI can flag them.

NHC publishes ATCF-style text products and per-advisory KMZ shapefiles for
live storms; rather than scrape them, replay mode is the demo path and the
live path returns whatever CurrentStorms.json holds at fetch time.
"""

from __future__ import annotations

import json
import math
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from .hurdat2 import category_for_wind
from .hurricane_impact import (
    ConeQuad,
    FootprintPoint,
    _asymmetric_ring,
    _quads_asymmetric_r64,
    _quads_symmetric,
    rmax_nm,
)
from .ibtracs import Storm, TrackPoint, fetch_storms, lookup_r64_quads_nm
from .nhc_gis import (
    NHCSurgePolygon,
    fetch_forecast_track,
    fetch_peak_surge,
    fetch_track_cone,
)

CURRENT_STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json"
FETCH_TIMEOUT_S = 30

# Curated replay candidates — one recent recognizable Atlantic hurricane with
# rich IBTrACS coverage (full Rmax + R64 quadrants). Kept as a single demo
# case so the "replay" picker shows one option when the basin is quiet.
REPLAY_CANDIDATES: tuple[tuple[str, str, int], ...] = (
    # (atcf_id, display_name, year)
    ("AL092022", "Ian", 2022),
)


DAMAGING_WIND_MULTIPLIER = 2.5  # mirrors hurricane_impact for the synthetic fallback


def _fixes_to_footprint(
    storm_id: str,
    fixes: list[tuple[float, float, int, str]],
    *,
    min_wind_kt: int = 34,
) -> list[FootprintPoint]:
    """Convert (lat, lon, wind_kt, datetime_iso) tuples → FootprintPoints.

    Rmax: IBTrACS measured if present, else Willoughby fallback.
    R64 quadrants: IBTrACS measured if present, else None (symmetric fallback).
    ``min_wind_kt`` defaults to 34 (TS strength) so the forecast cone is
    drawn for tropical-storm-strength forecasts too, not just hurricane.
    """
    out: list[FootprintPoint] = []
    for lat, lon, wind, dt in fixes:
        if wind < min_wind_kt:
            continue
        rmax, rmax_src = rmax_nm(
            wind, lat, storm_id=storm_id, datetime_utc=dt,
        )
        if rmax <= 0:
            continue
        measured_quads = lookup_r64_quads_nm(storm_id, dt)
        if measured_quads:
            nonzero = [v for v in measured_quads if v > 0]
            r64_mean = sum(nonzero) / len(nonzero) if nonzero else rmax * DAMAGING_WIND_MULTIPLIER
            r64_src = "ibtracs"
        else:
            r64_mean = rmax * DAMAGING_WIND_MULTIPLIER
            r64_src = "fallback"
        out.append(
            FootprintPoint(
                lat=lat,
                lon=lon,
                wind_kt=wind,
                rmax_nm=rmax,
                radius_nm=rmax * DAMAGING_WIND_MULTIPLIER,
                rmax_source=rmax_src,
                r64_nm=r64_mean,
                r64_source=r64_src,
                r64_quads_nm=measured_quads,
            )
        )
    return out


def build_wind_cones(
    storm_id: str,
    fixes: list[tuple[float, float, int, str]],
) -> tuple[list[FootprintPoint], list[ConeQuad], list[ConeQuad], list[dict]]:
    """Build inner (Rmax) + outer (asymmetric R64) cones + asymmetric outer
    cap rings for the given track of fixes. Returns
    ``(footprint, inner_cone, outer_cone, outer_rings)``.
    """
    fp = _fixes_to_footprint(storm_id, fixes)
    inner = _quads_symmetric(fp, lambda p: p.rmax_nm)
    outer = _quads_asymmetric_r64(fp)
    outer_rings: list[dict] = []
    for pt in fp:
        ring = _asymmetric_ring(pt.lat, pt.lon, pt.r64_quads_nm, fallback_nm=pt.r64_nm)
        outer_rings.append(
            {
                "ring": ring,
                "wind_kt": pt.wind_kt,
                "r64_nm": pt.r64_nm,
                "r64_source": pt.r64_source,
            }
        )
    return fp, inner, outer, outer_rings


@dataclass(slots=True, frozen=True)
class LiveStormSummary:
    """Row in the live-storm picker — minimal data for the dropdown."""

    storm_id: str
    name: str
    year: int
    classification: str        # "HU" / "TS" / "TD" / "PT" for live; same convention as IBTrACS
    intensity_kt: int
    pressure_mb: int | None
    lat: float | None
    lon: float | None
    is_live: bool              # True from NHC, False for replay candidates
    label: str                 # display string ("Helene (2024) — live, Cat 3")


@dataclass(slots=True, frozen=True)
class ForecastPoint:
    """One point in a forecast track (current OR a prior advisory)."""

    lat: float
    lon: float
    wind_kt: int
    hours_out: int             # T+0, T+12, T+24, T+36, T+48, T+72, T+96, T+120
    valid_time: str            # ISO


@dataclass(slots=True, frozen=True)
class ForecastTrack:
    """One advisory's forecast track. ``synthetic=True`` flags demo data so
    the UI can label it accordingly."""

    advisory_number: int       # advisory issue number (latest = highest)
    issued_at: str             # ISO
    points: list[ForecastPoint]
    synthetic: bool


# ─────────────────────────── live NHC fetch ───────────────────────────


@lru_cache(maxsize=1)
def _fetch_current_storms_raw() -> dict:
    req = urllib.request.Request(
        CURRENT_STORMS_URL,
        headers={"User-Agent": "exposure-eclipse-live/1.0"},
    )
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _coerce_float(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _coerce_int(v) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _year_from_atcf(atcf_id: str) -> int:
    """NHC ATCF IDs encode the season year in the trailing four digits
    (e.g. ``AL022026`` → 2026). Falls back to 0 if the id is malformed."""
    if len(atcf_id) < 4:
        return 0
    try:
        return int(atcf_id[-4:])
    except ValueError:
        return 0


def fetch_active_summaries() -> list[LiveStormSummary]:
    """Return the live list from NHC; empty list when nothing's active."""
    try:
        data = _fetch_current_storms_raw()
    except Exception:  # noqa: BLE001 — network failure → degrade to empty
        return []
    out: list[LiveStormSummary] = []
    for s in data.get("activeStorms", []) or []:
        # NHC field naming varies; defensive .get everywhere.
        storm_id = (s.get("id") or s.get("binNumber") or "").upper()
        if not storm_id:
            continue
        name = s.get("name") or "UNNAMED"
        classification = s.get("classification") or s.get("intensityClassification") or "TC"
        intensity = _coerce_int(s.get("intensity")) or 0
        pressure = _coerce_int(s.get("pressure"))
        lat = _coerce_float(s.get("latitudeNumeric") or s.get("latitude"))
        lon = _coerce_float(s.get("longitudeNumeric") or s.get("longitude"))
        # Season year lives in the ATCF id itself; NHC's CurrentStorms.json
        # does not expose a stable top-level year field.
        year = _year_from_atcf(storm_id)
        cat = category_for_wind(intensity)
        cat_label = f"Cat {cat}" if cat >= 1 else "TS" if intensity >= 34 else "TD"
        out.append(
            LiveStormSummary(
                storm_id=storm_id,
                name=name,
                year=year,
                classification=classification,
                intensity_kt=intensity,
                pressure_mb=pressure,
                lat=lat,
                lon=lon,
                is_live=True,
                label=f"{name} ({year}) — live, {cat_label}",
            )
        )
    return out


def _get_live_entry(atcf_id: str) -> dict | None:
    """Look up the raw CurrentStorms.json entry for one live NHC storm."""
    try:
        data = _fetch_current_storms_raw()
    except Exception:  # noqa: BLE001
        return None
    target = atcf_id.upper()
    for s in data.get("activeStorms", []) or []:
        sid = (s.get("id") or s.get("binNumber") or "").upper()
        if sid == target:
            return s
    return None


def fetch_live_forecast_cone(atcf_id: str) -> list[tuple[float, float]]:
    """NHC's forecast cone-of-uncertainty polygon for a live storm — the
    familiar swept-circle envelope shown on hurricanes.gov. Empty list when
    the storm is not in the live feed or the KMZ is unreachable."""
    entry = _get_live_entry(atcf_id)
    if entry is None:
        return []
    cone_kmz = (entry.get("trackCone") or {}).get("kmzFile")
    if not cone_kmz:
        return []
    return fetch_track_cone(cone_kmz)


def fetch_live_peak_surge(atcf_id: str) -> list[NHCSurgePolygon]:
    """NHC's peak storm-surge forecast for a live storm — coloured coastal
    polygons per surge band (1-2 ft, 3-6 ft, ...). Not every storm publishes a
    surge product (open-ocean systems, weak systems); empty list in that case.
    """
    entry = _get_live_entry(atcf_id)
    if entry is None:
        return []
    surge = entry.get("peakSurgeKML") or {}
    surge_url = surge.get("peakSurgeKMLFile")
    if not surge_url:
        return []
    return fetch_peak_surge(surge_url)


def _project_point(
    lat: float, lon: float, bearing_deg: float, distance_nm: float,
) -> tuple[float, float]:
    """Flat-earth projection from (lat, lon) along ``bearing_deg`` (measured
    clockwise from true north, i.e. NHC's ``movementDir``). Good enough over
    forecast distances (< ~1500 nm) for a demo cone."""
    d_deg = distance_nm / 60.0  # 1° latitude ≈ 60 nm
    b_rad = math.radians(bearing_deg)
    d_lat = d_deg * math.cos(b_rad)
    d_lon = d_deg * math.sin(b_rad) / max(math.cos(math.radians(lat)), 0.01)
    return lat + d_lat, lon + d_lon


def _shift_iso_hours(iso_str: str, hours: int) -> str:
    """Shift an ISO-8601 datetime by ``hours`` (may be negative). Returns the
    input unchanged if it can't be parsed — the field is display-only."""
    if not iso_str:
        return ""
    try:
        s = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        shifted = dt + timedelta(hours=hours)
        return shifted.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return iso_str


# ─────────────────────────── replay (IBTrACS-driven) ───────────────────────────


def replay_summaries() -> list[LiveStormSummary]:
    """The curated set of demo storms — always available even when the Atlantic
    is quiet. Each entry's metadata comes from IBTrACS."""
    storms_by_id = {s.storm_id: s for s in fetch_storms()}
    out: list[LiveStormSummary] = []
    for atcf, display, year in REPLAY_CANDIDATES:
        s = storms_by_id.get(atcf)
        if s is None:
            continue
        peak = max((p.wind_kt for p in s.track), default=0)
        cat = category_for_wind(peak)
        cat_label = f"Cat {cat}" if cat >= 1 else "—"
        peak_pt = max(s.track, key=lambda p: p.wind_kt)
        out.append(
            LiveStormSummary(
                storm_id=s.storm_id,
                name=display,
                year=year,
                classification="HU",
                intensity_kt=peak,
                pressure_mb=peak_pt.pressure_mb,
                lat=peak_pt.lat,
                lon=peak_pt.lon,
                is_live=False,
                label=f"{display} ({year}) — replay, {cat_label}",
            )
        )
    return out


def _get_replay_storm(atcf_id: str) -> Storm | None:
    for s in fetch_storms():
        if s.storm_id.upper() == atcf_id.upper():
            return s
    return None


# ─────────────────────────── storm + forecast assembly ───────────────────────────


# NHC's forecast-track KMZ/shapefile has the true cone points, but pyshp is a
# dev-only dep (see CLAUDE.md: no pandas/pyshp in prod). We project a
# straight-line track from the current advisory's motion vector at the standard
# NHC lead-time anchors. Good enough for the demo cone; when NHC's real
# GeoJSON feed lands we can swap this out.
FORECAST_HOUR_ANCHORS: tuple[int, ...] = (0, 12, 24, 36, 48, 72, 96, 120)


def _live_storm_and_forecasts(
    entry: dict,
) -> tuple[Storm, list[ForecastTrack]] | None:
    """Build (observed_storm, [current_advisory]) from a live NHC
    CurrentStorms.json entry. Observed track = current fix plus two
    back-projected trailing fixes (visual only); forecast track = motion-vector
    projection at the standard NHC lead-time anchors."""
    storm_id = (entry.get("id") or entry.get("binNumber") or "").upper()
    if not storm_id:
        return None
    lat = _coerce_float(entry.get("latitudeNumeric") or entry.get("latitude"))
    lon = _coerce_float(entry.get("longitudeNumeric") or entry.get("longitude"))
    if lat is None or lon is None:
        return None
    intensity = _coerce_int(entry.get("intensity")) or 30
    pressure = _coerce_int(entry.get("pressure"))
    move_dir = _coerce_float(entry.get("movementDir"))
    move_speed = _coerce_float(entry.get("movementSpeed"))
    classification = (
        entry.get("classification")
        or entry.get("intensityClassification")
        or "TC"
    )
    name = entry.get("name") or "UNNAMED"
    last_update = entry.get("lastUpdate") or ""
    year = _year_from_atcf(storm_id)

    observed: list[TrackPoint] = []
    # Back-projected trailing points — purely visual, so the map shows a
    # short past track instead of a lone dot. Only meaningful when a motion
    # vector is available.
    if move_dir is not None and move_speed is not None and move_speed > 0:
        for hours_back in (12, 6):
            back_lat, back_lon = _project_point(
                lat, lon, move_dir + 180.0, move_speed * hours_back,
            )
            observed.append(
                TrackPoint(
                    datetime_utc=_shift_iso_hours(last_update, -hours_back),
                    record_id="",
                    status=classification,
                    lat=back_lat,
                    lon=back_lon,
                    wind_kt=intensity,
                    pressure_mb=pressure,
                )
            )
    observed.append(
        TrackPoint(
            datetime_utc=last_update,
            record_id="",
            status=classification,
            lat=lat,
            lon=lon,
            wind_kt=intensity,
            pressure_mb=pressure,
        )
    )

    live_storm = Storm(
        storm_id=storm_id,
        name=name,
        year=year,
        track=observed,
    )

    forecast_points: list[ForecastPoint] = []
    # Prefer NHC's actual forecast track KMZ (real forecaster-issued lat/lon
    # + intensity at 12/24/36/48/72/96/120 hr anchors). Fall back to a motion
    # -vector extrapolation only if the KMZ is missing or fails to parse.
    forecast_kmz = (entry.get("forecastTrack") or {}).get("kmzFile")
    if forecast_kmz:
        for fix in fetch_forecast_track(forecast_kmz):
            forecast_points.append(
                ForecastPoint(
                    lat=fix.lat,
                    lon=fix.lon,
                    wind_kt=fix.wind_kt or intensity,
                    hours_out=fix.hours_out,
                    valid_time=fix.valid_time
                    or _shift_iso_hours(last_update, fix.hours_out),
                )
            )

    if not forecast_points:
        if move_dir is not None and move_speed is not None and move_speed > 0:
            for h in FORECAST_HOUR_ANCHORS:
                f_lat, f_lon = _project_point(lat, lon, move_dir, move_speed * h)
                forecast_points.append(
                    ForecastPoint(
                        lat=f_lat,
                        lon=f_lon,
                        wind_kt=intensity,
                        hours_out=h,
                        valid_time=_shift_iso_hours(last_update, h),
                    )
                )
        else:
            # Stationary or unknown motion — one point at T+0 so the frontend
            # has something to render.
            forecast_points.append(
                ForecastPoint(
                    lat=lat,
                    lon=lon,
                    wind_kt=intensity,
                    hours_out=0,
                    valid_time=last_update,
                )
            )

    advisories = [
        ForecastTrack(
            advisory_number=1,
            issued_at=last_update,
            points=forecast_points,
            # Marked False: this is the current NHC forecast advisory (real
            # data when the KMZ is available, motion-vector extrapolation as
            # a last-resort fallback), not a historical ghost line.
            synthetic=False,
        )
    ]
    return live_storm, advisories


def storm_and_forecasts(
    atcf_id: str,
    *,
    as_of_index: int | None = None,
    n_prior_advisories: int = 5,
) -> tuple[Storm, list[ForecastTrack], bool] | None:
    """Return (observed_storm_so_far, [latest_forecast, prior_forecasts...],
    is_live).

    Live path (``is_live=True``): a storm currently in NHC's CurrentStorms
    feed. Observed track = current fix; forecast = motion-vector projection at
    the standard NHC lead-time anchors.

    Replay path (``is_live=False``): a retired storm from IBTrACS.
    ``as_of_index`` chooses which track point is "now" — defaults to
    two-thirds of the way through the hurricane phase so the forecast tail is
    meaningful. Earlier "advisories" are synthesized by truncating the track
    at earlier points and laterally perturbing the forecast tail.
    """
    live_entry = _get_live_entry(atcf_id)
    if live_entry is not None:
        live_result = _live_storm_and_forecasts(live_entry)
        if live_result is not None:
            live_storm, live_advisories = live_result
            return live_storm, live_advisories, True

    storm = _get_replay_storm(atcf_id)
    if storm is None:
        return None
    track = storm.track
    if not track:
        return None

    # Pick "now": ~two-thirds through the hurricane-strength portion if there
    # is one, else two-thirds through the whole track.
    hu_indexes = [i for i, p in enumerate(track) if p.wind_kt >= 64]
    if hu_indexes:
        default_idx = hu_indexes[len(hu_indexes) * 2 // 3]
    else:
        default_idx = len(track) * 2 // 3
    idx_now = as_of_index if as_of_index is not None else default_idx
    idx_now = max(1, min(idx_now, len(track) - 1))

    observed = Storm(
        storm_id=storm.storm_id,
        name=storm.name,
        year=storm.year,
        track=track[: idx_now + 1],
    )

    advisories: list[ForecastTrack] = []
    # Forecast hours-out anchors we sample.
    hour_anchors = (0, 12, 24, 36, 48, 72, 96, 120)
    for back in range(n_prior_advisories + 1):
        anchor_idx = max(1, idx_now - back * 2)  # ~6h between advisories at 3h fix cadence
        anchor = track[anchor_idx]
        # Build the forecast tail by sampling track points at 3h cadence ahead.
        future = track[anchor_idx:]
        if not future:
            continue
        # Map each anchor offset (hours) onto a future point. IBTrACS fixes are
        # mostly 3h apart; treat one offset step = 3h.
        points: list[ForecastPoint] = []
        # Apply a small synthetic lateral perturbation that gets larger the
        # farther back the advisory is — earlier forecasts shifted, then
        # later ones converged onto truth. Shift direction alternates so the
        # ghost lines visibly wobble around the truth.
        shift_nm = -10 * back if back % 2 == 0 else 10 * back
        for h in hour_anchors:
            # 1 hour ≈ 1/3 of a future step. Floor to nearest fix.
            step = h // 3
            if step >= len(future):
                break
            fp = future[step]
            # Lateral shift: convert nm to degrees and apply perpendicular
            # to the storm's heading.
            if step < len(future) - 1:
                nxt = future[step + 1]
                bearing_rad = math.atan2(nxt.lon - fp.lon, nxt.lat - fp.lat)
                # +90° perpendicular
                perp_lat = math.cos(bearing_rad) * 0  # placeholder
                perp_lon = -math.sin(bearing_rad) * (shift_nm / 60.0) / max(
                    math.cos(math.radians(fp.lat)), 0.01
                )
                perp_lat = math.cos(bearing_rad + math.pi / 2) * (shift_nm / 60.0)
            else:
                perp_lat = perp_lon = 0.0
            points.append(
                ForecastPoint(
                    lat=fp.lat + perp_lat,
                    lon=fp.lon + perp_lon,
                    wind_kt=fp.wind_kt,
                    hours_out=h,
                    valid_time=fp.datetime_utc,
                )
            )
        advisories.append(
            ForecastTrack(
                advisory_number=len(REPLAY_CANDIDATES) * 10 - back,  # decreasing
                issued_at=anchor.datetime_utc,
                points=points,
                synthetic=True,
            )
        )

    # Latest advisory = first one (back=0). Reverse so callers see latest-first.
    return observed, advisories, False
