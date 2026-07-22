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


MAX_AGE_HOURS = 4.0
LOCAL_KILL_MEDIAN_KT = 5.0
LAND_STATION_SAMPLE = 60         # subsampled; IDW smooths the density down
IDW_POWER = 2.0
IDW_RADIUS_DEG = 3.0             # ~330 km at mid-latitudes
NEIGHBOR_RADIUS_DEG = 1.5        # for the dead-sensor check
CONFIDENT_SOURCE_COUNT = 5       # ≥ this many contributors ⇒ full confidence


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
    """Bbox-span → grid cell size in degrees. Smaller bbox = finer grid so
    the fill polygons don't look chunky on a zoomed-in map."""
    if span < 6:
        return 0.15
    if span < 12:
        return 0.25
    if span < 25:
        return 0.4
    return 0.6


def _fetch_land_obs(
    west: float, south: float, east: float, north: float,
) -> list[tuple[float, float, float, float | None, str]]:
    """Spatially-uniform subsample of NWS land stations + parallel latest-obs
    fetch. Uses fewer stations than the discrete-marker view since the IDW
    interpolation already smooths.

    Returns tuples of (lat, lon, wind_kt, wind_dir_deg, observed_at).
    ``wind_dir_deg`` is None when the station reports speed but not direction.
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

    out: list[tuple[float, float, float, float | None, str]] = []
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
                rec.observed_at,
            ))
    return out


def _clean_obs(
    obs: list[tuple[float, float, float, float | None, str]],
    now: datetime,
) -> list[tuple[float, float, float, float | None]]:
    """Apply freshness + dead-sensor filters. Returns (lat, lon, kt, dir)."""
    fresh: list[tuple[float, float, float, float | None]] = []
    for lat, lon, kt, dir_deg, iso in obs:
        dt = _parse_iso(iso)
        if dt is not None:
            age_h = (now - dt).total_seconds() / 3600.0
            if age_h > MAX_AGE_HOURS:
                continue
        fresh.append((lat, lon, kt, dir_deg))

    cleaned: list[tuple[float, float, float, float | None]] = []
    for lat, lon, kt, dir_deg in fresh:
        if kt > 0:
            cleaned.append((lat, lon, kt, dir_deg))
            continue
        neighbor_kts = [
            k for (la, lo, k, _d) in fresh
            if k > 0
            and abs(la - lat) < NEIGHBOR_RADIUS_DEG
            and abs(lo - lon) < NEIGHBOR_RADIUS_DEG
        ]
        if not neighbor_kts:
            # No signal nearby to compare against — keep the zero so calm
            # regions aren't erased.
            cleaned.append((lat, lon, kt, dir_deg))
            continue
        neighbor_kts.sort()
        median = neighbor_kts[len(neighbor_kts) // 2]
        if median <= LOCAL_KILL_MEDIAN_KT:
            cleaned.append((lat, lon, kt, dir_deg))
        # else: dead sensor / stuck-at-zero — drop.
    return cleaned


def _cell_confidence(count: int, weight_sum: float) -> float:
    """Heuristic 0..1 confidence for one cell. Combines source density with
    the IDW weight_sum (which encodes distance to nearest obs — high when
    the cell sits close to real observations, low when it's near the fringe
    of the influence radius). Simple product form keeps both signals
    meaningful without introducing arbitrary tunable weights."""
    if count <= 0:
        return 0.0
    density = min(1.0, count / CONFIDENT_SOURCE_COUNT)
    # weight_sum ≈ Σ 1/d² with the +0.01 epsilon. Cap at 5 (well above what
    # a single on-station obs contributes ~ 1/0.01 = 100 while multi-obs
    # cells often sit in the 2-10 range). This yields a smooth 0..1.
    proximity = min(1.0, weight_sum / 5.0)
    return round(density * proximity, 3)


def wind_field_grid(
    west: float, south: float, east: float, north: float,
    *, now: datetime | None = None,
) -> tuple[list[WindGridCell], float]:
    """Return (grid_cells, cell_step_deg). Cells with no obs in range are
    omitted — the renderer paints those as gaps rather than fake data.

    Direction is derived from a parallel IDW on the u/v vector components
    (rather than a scalar mean on the angle). Averaging angles directly
    breaks at the 0/360 wraparound; vector-mean handles convergent and
    divergent flow correctly."""
    if now is None:
        now = datetime.now(timezone.utc)

    obs: list[tuple[float, float, float, float | None, str]] = []
    for b in buoys_in_bbox(west, south, east, north):
        if b.wind_kt is None:
            continue
        obs.append((
            b.lat, b.lon, float(b.wind_kt),
            float(b.wind_dir_deg) if b.wind_dir_deg is not None else None,
            b.observed_at,
        ))
    obs.extend(_fetch_land_obs(west, south, east, north))

    step = _adaptive_step(max(east - west, north - south))
    cleaned = _clean_obs(obs, now)
    if not cleaned:
        return [], step

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

            cells.append(
                WindGridCell(
                    lat=round(lat, 3),
                    lon=round(lon, 3),
                    wind_kt=wind_kt,
                    wind_dir_deg=wind_dir_deg,
                    sources=count,
                    confidence=_cell_confidence(count, weight_sum),
                )
            )
            lon += step
        lat += step
    return cells, step


__all__ = ["WindGridCell", "wind_field_grid"]
