"""Interpolated surface-wind field for a live-storm bbox.

Blends NDBC buoy + a spatially-uniform sample of NWS land-station reports into
a smoothed inverse-distance-weighted (IDW) wind-speed grid.

The point of doing this in-house instead of just plotting the raw obs is that
NOAA's networks are wildly non-uniform (Texas has ~10× the mesonet density of
Louisiana), individual stations go dead or return stuck-at-zero readings, and
observation times drift. Rendering the raw markers implies precision the data
doesn't have. Smoothing + cleaning produces a fair "current wind footprint"
map the underwriter can actually read.

Cleaning rules, in order:
1. Drop obs older than ``MAX_AGE_HOURS``.
2. Drop obs whose wind_kt is None.
3. Kill suspicious zeros: 0 kt readings whose local (~1.5°) neighborhood
   median is above ``LOCAL_KILL_MEDIAN_KT`` are treated as dead sensors and
   removed rather than dragging the IDW mean toward zero.

Interpolation:
- Adaptive grid step by bbox span (see ``_adaptive_step``).
- IDW power = 2.0, soft influence radius ``IDW_RADIUS_DEG`` in degrees.
- Cells with no obs inside the radius are omitted — the renderer paints
  "no data" as a gap instead of extrapolating.
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone

from .marine_obs import (
    _fetch_latest_obs,
    _nws_all_stations,
    _spatial_subsample,
    buoys_in_bbox,
)


@dataclass(slots=True, frozen=True)
class WindGridCell:
    lat: float
    lon: float
    wind_kt: float
    wind_dir_deg: float | None   # meteorological convention: FROM direction
    sources: int                 # obs contributing to this cell
    confidence: float            # 0..1 heuristic — see _cell_confidence
    nearest_obs_km: float | None # closest contributing observation


@dataclass(slots=True, frozen=True)
class WindObs:
    """One cleaned surface observation used to build the wind heatmap.
    Shipped alongside the grid so the frontend can highlight which stations
    contributed to any given cell when the user clicks "N sources"."""
    lat: float
    lon: float
    wind_kt: float
    wind_dir_deg: float | None
    source: str          # "buoy" | "land"
    station_id: str
    observed_at: str     # ISO


MAX_AGE_HOURS = 4.0
LOCAL_KILL_MEDIAN_KT = 5.0
LAND_STATION_SAMPLE = 60         # subsampled; IDW smooths the density down
IDW_POWER = 2.0
IDW_RADIUS_DEG = 3.0             # ~330 km at mid-latitudes
NEIGHBOR_RADIUS_DEG = 1.5        # for the dead-sensor check
OUTLIER_MAX_DEV_KT = 25.0        # |obs - local_median| above this ⇒ drop
ABS_MAX_WIND_KT = 200.0          # world-record verifiable sustained ~= 220 kt
FIXED_STEP_DEG = 0.5             # aligned with the model grid so diffs are cell-to-cell
# Confidence thresholds (in output space) are set on the frontend. Below are
# the raw-signal knobs the confidence composite uses.
NEAR_OBS_DIST_DEG = 1.5           # nearest obs within this ⇒ full distance score


def _parse_iso(s: str) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _adaptive_step(span: float) -> float:
    """Kept for backwards compat but no longer called from the main
    interpolator — see FIXED_STEP_DEG. We standardized on 0.5° so that the
    observed heatmap is cell-aligned with the GFS/ECMWF model grids, which
    lets the frontend compute obs-vs-model diffs cell-by-cell without
    resampling. Small enough to look continuous, large enough to keep
    Open-Meteo bulk requests manageable."""
    if span < 6:
        return 0.15
    if span < 12:
        return 0.25
    if span < 25:
        return 0.4
    return 0.6


def _fetch_land_obs_with_meta(
    west: float, south: float, east: float, north: float,
) -> list[tuple[float, float, float, float | None, str, str]]:
    """Spatially-uniform subsample of NWS land stations + parallel latest-obs
    fetch. Uses fewer stations than the discrete-marker view since the IDW
    interpolation already smooths.

    Returns tuples of (lat, lon, wind_kt, wind_dir_deg, observed_at,
    station_id). ``wind_dir_deg`` is None when the station reports speed
    but not direction.
    """
    all_in_bbox: list[tuple[str, str, float, float]] = []
    for f in _nws_all_stations():
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None]
        lon, lat = coords[0], coords[1]
        if lat is None or lon is None:
            continue
        if not (south <= lat <= north and west <= lon <= east):
            continue
        props = f.get("properties") or {}
        sid = props.get("stationIdentifier") or ""
        if not sid:
            continue
        all_in_bbox.append((sid, props.get("name") or sid, lat, lon))
    candidates = _spatial_subsample(
        all_in_bbox, west, south, east, north, LAND_STATION_SAMPLE,
    )

    out: list[tuple[float, float, float, float | None, str, str]] = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = [
            pool.submit(_fetch_latest_obs, sid, name, lat, lon)
            for sid, name, lat, lon in candidates
        ]
        for fut in as_completed(futures, timeout=30):
            try:
                rec = fut.result()
            except Exception:  # noqa: BLE001
                continue
            if rec is None or rec.wind_kt is None:
                continue
            out.append((
                rec.lat, rec.lon, float(rec.wind_kt),
                float(rec.wind_dir_deg) if rec.wind_dir_deg is not None else None,
                rec.observed_at, rec.station_id,
            ))
    return out


def _clean_obs(
    obs: list[tuple[float, float, float, float | None, str]],
    now: datetime,
) -> list[tuple[float, float, float, float | None]]:
    """Multi-stage cleaning pipeline for the raw NDBC + NWS obs pool.

    1. Age: drop obs whose ``observed_at`` is older than ``MAX_AGE_HOURS``.
    2. Absurdity: drop obs with wind_kt above ``ABS_MAX_WIND_KT`` (world
       -record sustained wind ≈ 220 kt — anything higher is anemometer
       error or corrupt data).
    3. Dead-sensor zero: 0 kt reading whose local (1.5°) neighborhood
       median is above ``LOCAL_KILL_MEDIAN_KT`` is dropped as a stuck-at
       -zero sensor rather than pulling the IDW mean toward zero.
    4. Outlier: obs whose wind_kt deviates from the local median by more
       than ``OUTLIER_MAX_DEV_KT`` are dropped. Catches lightning-strike
       anemometer spikes and single-station spurious readings without
       needing per-station quality flags.
    """
    fresh: list[tuple[float, float, float, float | None]] = []
    for lat, lon, kt, dir_deg, iso in obs:
        # Stage 1: age
        dt = _parse_iso(iso)
        if dt is not None:
            age_h = (now - dt).total_seconds() / 3600.0
            if age_h > MAX_AGE_HOURS:
                continue
        # Stage 2: absurdity
        if kt > ABS_MAX_WIND_KT:
            continue
        fresh.append((lat, lon, kt, dir_deg))

    # Precompute local median for each fresh obs (used by stages 3 and 4).
    def _local_median(lat: float, lon: float, exclude_self_kt: float) -> float | None:
        vals = [
            k for (la, lo, k, _d) in fresh
            if abs(la - lat) < NEIGHBOR_RADIUS_DEG
            and abs(lo - lon) < NEIGHBOR_RADIUS_DEG
            and (la, lo, k) != (lat, lon, exclude_self_kt)
        ]
        if not vals:
            return None
        vals.sort()
        return vals[len(vals) // 2]

    cleaned: list[tuple[float, float, float, float | None]] = []
    for lat, lon, kt, dir_deg in fresh:
        local_med = _local_median(lat, lon, kt)

        # Stage 3: dead-sensor zero
        if kt == 0 and local_med is not None and local_med > LOCAL_KILL_MEDIAN_KT:
            continue

        # Stage 4: outlier vs neighborhood
        if (
            local_med is not None
            and abs(kt - local_med) > OUTLIER_MAX_DEV_KT
        ):
            continue

        cleaned.append((lat, lon, kt, dir_deg))
    return cleaned


def _cell_confidence(
    nearest_dist_deg: float | None,
    count: int,
    speeds: list[float],
) -> float:
    """Composite 0..1 confidence for a grid cell. Three independent signals
    multiplied, so any weak component drags the whole score down.

    * **Distance**: how close the nearest contributing obs is. Full score
      when the nearest obs is within one grid-cell-width (i.e. we're
      basically on top of a real measurement), fading linearly to zero at
      the IDW radius edge (3°). The old 1.5° threshold rated most land
      cells LOW because the median land-station spacing is ~50–100 km
      (~0.5–1°) — well within the cell but outside the "on-station" band.
    * **Count**: 2+ contributors saturates. Below that the value hinges on
      a single station potentially being wrong.
    * **Agreement**: standard deviation of contributor speeds. Tight
      agreement (< 5 kt spread) = full score, loose agreement (>= 20 kt
      spread) = zero. High disagreement usually means the cell straddles a
      real gradient (e.g. eye-wall vs eye) so the IDW mean is misleading.

    Multiplicative composition intentionally means "even one dead signal
    kills confidence" — better to say LOW than pretend certainty."""
    if count <= 0 or nearest_dist_deg is None:
        return 0.0

    # Distance score — on top of an obs (< 0.7°, roughly one grid cell) is
    # full trust, fades to zero at the radius edge.
    if nearest_dist_deg <= 0.7:
        dist_score = 1.0
    elif nearest_dist_deg >= IDW_RADIUS_DEG:
        dist_score = 0.0
    else:
        span = IDW_RADIUS_DEG - 0.7
        dist_score = max(0.0, 1.0 - (nearest_dist_deg - 0.7) / span)

    # Count score — 2+ contributors = full trust. Solo obs are usable but
    # rated at 0.7 so a single lucky station doesn't max out the score.
    if count <= 0:
        count_score = 0.0
    elif count == 1:
        count_score = 0.7
    else:
        count_score = 1.0

    # Agreement score based on σ of contributor speeds.
    if len(speeds) < 2:
        agreement_score = 1.0
    else:
        mean_s = sum(speeds) / len(speeds)
        var = sum((s - mean_s) ** 2 for s in speeds) / len(speeds)
        std = var ** 0.5
        if std <= 5.0:
            agreement_score = 1.0
        elif std >= 20.0:
            agreement_score = 0.0
        else:
            agreement_score = max(0.0, 1.0 - (std - 5.0) / 15.0)

    return round(dist_score * count_score * agreement_score, 3)


def wind_field_grid(
    west: float, south: float, east: float, north: float,
    *, now: datetime | None = None,
) -> tuple[list[WindGridCell], float, list[WindObs]]:
    """Return (grid_cells, cell_step_deg, cleaned_obs_pool). Cells with no
    obs in range are omitted — the renderer paints those as gaps rather
    than fake data. The cleaned obs pool is shipped alongside so the
    frontend can highlight which stations contributed to any given cell.

    Direction is derived from a parallel IDW on the u/v vector components
    (rather than a scalar mean on the angle). Averaging angles directly
    breaks at the 0/360 wraparound; vector-mean handles convergent and
    divergent flow correctly."""
    if now is None:
        now = datetime.now(timezone.utc)

    # Keep the raw obs metadata (station id + source label) so the shipped
    # obs pool can be attributed on the frontend.
    obs_with_meta: list[
        tuple[float, float, float, float | None, str, str, str]
    ] = []  # lat, lon, kt, dir, iso, source, station_id
    for b in buoys_in_bbox(west, south, east, north):
        if b.wind_kt is None:
            continue
        obs_with_meta.append((
            b.lat, b.lon, float(b.wind_kt),
            float(b.wind_dir_deg) if b.wind_dir_deg is not None else None,
            b.observed_at, "buoy", b.station_id,
        ))
    obs_with_meta.extend(
        (lat, lon, kt, d, iso, "land", sid)
        for (lat, lon, kt, d, iso, sid) in _fetch_land_obs_with_meta(
            west, south, east, north,
        )
    )

    obs = [(la, lo, kt, d, iso) for (la, lo, kt, d, iso, _s, _sid) in obs_with_meta]
    step = FIXED_STEP_DEG
    cleaned = _clean_obs(obs, now)
    if not cleaned:
        return [], step, []

    # Attribute each cleaned tuple back to its source station. Cleaning
    # preserves (lat, lon, kt) — dir may be dropped/kept unchanged. Match on
    # (lat, lon, kt) which is unique enough for our purposes.
    meta_by_key: dict[tuple[float, float, float], tuple[str, str, str]] = {}
    for lat, lon, kt, _d, iso, source, sid in obs_with_meta:
        meta_by_key[(lat, lon, kt)] = (source, sid, iso)
    obs_pool: list[WindObs] = []
    for lat, lon, kt, d in cleaned:
        meta = meta_by_key.get((lat, lon, kt))
        source, sid, iso = meta if meta else ("unknown", "", "")
        obs_pool.append(
            WindObs(
                lat=round(lat, 4),
                lon=round(lon, 4),
                wind_kt=round(kt, 1),
                wind_dir_deg=d,
                source=source,
                station_id=sid,
                observed_at=iso,
            )
        )

    # Pre-compute vector components once — u = -kt·sin(dir), v = -kt·cos(dir)
    # in meteorological "wind from" convention.
    precomputed: list[tuple[float, float, float, float | None, float | None]] = []
    for lat, lon, kt, dir_deg in cleaned:
        u: float | None = None
        v: float | None = None
        if dir_deg is not None and kt > 0:
            r = math.radians(dir_deg)
            u = -kt * math.sin(r)
            v = -kt * math.cos(r)
        precomputed.append((lat, lon, kt, u, v))

    r_sq = IDW_RADIUS_DEG ** 2
    cells: list[WindGridCell] = []
    lat = south
    while lat <= north + 1e-9:
        cos_lat = max(math.cos(math.radians(lat)), 0.05)
        lon = west
        while lon <= east + 1e-9:
            weight_sum = 0.0
            speed_sum = 0.0
            u_sum = 0.0
            v_sum = 0.0
            uv_weight_sum = 0.0
            count = 0
            nearest_d2: float | None = None
            contributor_speeds: list[float] = []
            for (la, lo, kt, u, v) in precomputed:
                dlat = la - lat
                dlon = (lo - lon) * cos_lat
                d2 = dlat * dlat + dlon * dlon
                if d2 > r_sq:
                    continue
                # +ε keeps the on-station weight finite.
                w = 1.0 / ((d2 + 0.01) ** (IDW_POWER / 2))
                weight_sum += w
                speed_sum += w * kt
                if u is not None and v is not None:
                    u_sum += w * u
                    v_sum += w * v
                    uv_weight_sum += w
                count += 1
                contributor_speeds.append(kt)
                if nearest_d2 is None or d2 < nearest_d2:
                    nearest_d2 = d2
            if count == 0:
                lon += step
                continue

            wind_kt = round(speed_sum / weight_sum, 1)
            wind_dir_deg: float | None = None
            if uv_weight_sum > 0:
                u_mean = u_sum / uv_weight_sum
                v_mean = v_sum / uv_weight_sum
                # atan2 returns the "wind blowing toward" direction; invert
                # to recover meteorological FROM direction.
                to_deg = math.degrees(math.atan2(u_mean, v_mean))
                wind_dir_deg = round((to_deg + 180.0) % 360.0, 1)

            nearest_dist = (nearest_d2 ** 0.5) if nearest_d2 is not None else None
            # 1° latitude ≈ 111 km — good enough at typical mid-lat.
            nearest_km = (
                round(nearest_dist * 111.0, 0) if nearest_dist is not None else None
            )
            cells.append(
                WindGridCell(
                    lat=round(lat, 3),
                    lon=round(lon, 3),
                    wind_kt=wind_kt,
                    wind_dir_deg=wind_dir_deg,
                    sources=count,
                    confidence=_cell_confidence(
                        nearest_dist, count, contributor_speeds,
                    ),
                    nearest_obs_km=nearest_km,
                )
            )
            lon += step
        lat += step
    return cells, step, obs_pool


__all__ = ["WindGridCell", "wind_field_grid"]
