"""Point-forecast wind for a lat/lon, sourced from both GFS and ECMWF.

The click-to-inspect feature on the live wind heatmap compares what we're
observing right now (IDW blend of NDBC + NWS obs) against what the two major
global NWP models expect at that spot. It's a quick sanity check for the
underwriter — if obs and both models agree, that's high-confidence; if the
observation is a big outlier vs both models, something is off (dead sensor,
extreme local terrain effect, etc).

Data source: **Open-Meteo** (open-meteo.com) — free, no auth, and it exposes
both the NOAA GFS and the ECMWF IFS through a single JSON endpoint. Cheaper
than parsing GRIB2 files ourselves, and Open-Meteo does its own bilinear
interpolation from the model grid to the requested lat/lon.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from ..brand import USER_AGENT
from .ttl_cache import TtlCache

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
FETCH_TIMEOUT_S = 15

# Open-Meteo model keys → display / wire names.
MODELS: tuple[tuple[str, str], ...] = (
    ("gfs_seamless", "gfs"),
    ("ecmwf_ifs025", "ecmwf"),
)


@dataclass(slots=True, frozen=True)
class ModelForecast:
    model: str            # "gfs" | "ecmwf"
    valid_time_utc: str   # ISO
    wind_kt: float
    wind_dir_deg: float | None
    wind_gust_kt: float | None


@dataclass(slots=True, frozen=True)
class PointForecast:
    lat: float
    lon: float
    fetched_at_utc: str
    forecasts: list[ModelForecast]     # one row per model, latest hour


def _mps_to_kt(v: float | None) -> float | None:
    return v * 1.94384 if v is not None else None


# Same "don't cache failures" pattern as _fetch_bulk_chunk. A single 429
# used to poison the popup for the whole session; now failures re-attempt
# on the next click while successful responses stay cached.
_POINT_CACHE_MAX = 256
_point_cache: OrderedDict[tuple[float, float, str], dict] = OrderedDict()


def _fetch_open_meteo_hourly(lat: float, lon: float, model_key: str) -> dict | None:
    """One HTTP GET to Open-Meteo for a single model's hourly wind block.

    Uses the ``hourly`` endpoint rather than ``current`` because ECMWF's IFS
    is only published on hourly cadence, so ``current`` returns nulls for it.
    Cached (successful responses only) by (lat, lon, model) so rapid re
    -clicks near the same spot don't hammer the API."""
    key = (lat, lon, model_key)
    hit = _point_cache.get(key)
    if hit is not None:
        _point_cache.move_to_end(key)
        return hit

    params = {
        "latitude": f"{lat:.3f}",
        "longitude": f"{lon:.3f}",
        "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        "wind_speed_unit": "ms",
        "timezone": "UTC",
        "forecast_days": 1,
        "models": model_key,
    }
    url = f"{OPEN_METEO_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None

    _point_cache[key] = data
    while len(_point_cache) > _POINT_CACHE_MAX:
        _point_cache.popitem(last=False)
    return data


def _nearest_hour_index(times: list[str], now: datetime) -> int | None:
    """Pick the index in ``times`` closest to ``now`` UTC. Open-Meteo hourly
    times are ISO-8601 in the requested timezone (we ask for UTC)."""
    best_i: int | None = None
    best_delta: float | None = None
    for i, t in enumerate(times):
        try:
            dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = abs((dt - now).total_seconds())
        if best_delta is None or delta < best_delta:
            best_delta = delta
            best_i = i
    return best_i


def _extract_hourly_row(
    data: dict, wire_name: str, now: datetime,
) -> ModelForecast | None:
    hourly = (data or {}).get("hourly") or {}
    times = hourly.get("time") or []
    speeds = hourly.get("wind_speed_10m") or []
    dirs = hourly.get("wind_direction_10m") or []
    gusts = hourly.get("wind_gusts_10m") or []
    if not times or not speeds:
        return None
    idx = _nearest_hour_index(times, now)
    if idx is None or idx >= len(speeds):
        return None
    speed_ms = speeds[idx]
    if speed_ms is None:
        return None
    dir_deg = dirs[idx] if idx < len(dirs) else None
    gust_ms = gusts[idx] if idx < len(gusts) else None
    valid_time = times[idx]
    if valid_time and not valid_time.endswith("Z"):
        valid_time = valid_time + "Z"
    return ModelForecast(
        model=wire_name,
        valid_time_utc=valid_time,
        wind_kt=round(float(_mps_to_kt(float(speed_ms)) or 0.0), 1),
        wind_dir_deg=float(dir_deg) if dir_deg is not None else None,
        wind_gust_kt=(
            round(float(_mps_to_kt(float(gust_ms)) or 0.0), 1)
            if gust_ms is not None else None
        ),
    )


def point_forecast(lat: float, lon: float) -> PointForecast:
    """Return latest-hour GFS + ECMWF wind at (lat, lon). Empty ``forecasts``
    when Open-Meteo is unreachable; caller shows that as 'model data
    unavailable' rather than 5xx'ing the click interaction."""
    now = datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    # Round to 0.05° so lru_cache reuses across sub-cell precision clicks.
    lat_q = round(lat * 20) / 20
    lon_q = round(lon * 20) / 20

    # Fire both model requests in parallel — sequential would double click
    # latency to ~2 s.
    forecasts: list[ModelForecast] = []
    with ThreadPoolExecutor(max_workers=len(MODELS)) as pool:
        futures = {
            pool.submit(_fetch_open_meteo_hourly, lat_q, lon_q, key): wire
            for key, wire in MODELS
        }
        for fut, wire in futures.items():
            try:
                data = fut.result()
            except Exception:  # noqa: BLE001
                data = None
            if data is None:
                continue
            row = _extract_hourly_row(data, wire, now)
            if row is not None:
                forecasts.append(row)

    # Preserve the (gfs, ecmwf) display order.
    order = {wire: i for i, (_k, wire) in enumerate(MODELS)}
    forecasts.sort(key=lambda f: order.get(f.model, 999))
    return PointForecast(
        lat=lat, lon=lon, fetched_at_utc=now_iso, forecasts=forecasts,
    )


@dataclass(slots=True, frozen=True)
class WindCoord:
    lat: float
    lon: float


@dataclass(slots=True, frozen=True)
class ModelWindFrame:
    """One forecast time-step for a whole cell grid. ``wind_kt`` and
    ``wind_dir_deg`` are parallel-array to the outer ``ModelWindGrid.cells``
    list so the wire payload doesn't repeat lat/lon at every frame."""
    hour: int              # forecast hours from "now" (0, 6, 12, …)
    valid_time_utc: str
    wind_kt: list[float]
    wind_dir_deg: list[float | None]


@dataclass(slots=True, frozen=True)
class ModelWindGrid:
    model: str
    step_deg: float
    cells: list[WindCoord]
    frames: list[ModelWindFrame]

    @property
    def valid_time_utc(self) -> str:
        """First-frame valid time — kept for backward compat with callers
        that still expect a single-time grid."""
        return self.frames[0].valid_time_utc if self.frames else ""


# Open-Meteo's docs allow up to 5000 coords per request. 400 keeps each URL
# well under any edge-side limit while dramatically reducing the total number
# of parallel requests (a Fausto-sized Pacific bbox went from 15 chunks to 4).
# Sending too many parallel small requests caused visible "empty streaks"
# on the wind heatmap when Open-Meteo rate-limited a handful of the chunks.
# 80 locations is the size that returns promptly. A 400-location URL is
# what made a basin-sized click die at the proxy.
_CHUNK_SIZE = 80
# Aggressive retry policy — the model-grid fetch is chunked in row-major
# order, so a permanent failure on any single chunk drops a horizontal
# band from the response. Better to hammer the retry for a few extra
# seconds than serve a heatmap with gaps.
_RETRY_ATTEMPTS = 2
_RETRY_BACKOFF_S = 0.6

# Forecast horizon for the timeline slider. NHC issues 5-day forecasts;
# we sample every 6 hours through the same window.
_FORECAST_HOURS: tuple[int, ...] = (0, 6, 12, 18, 24, 30, 36, 42, 48, 60, 72, 96, 120)
# A 0.25° grid over a 5-day cone is several thousand points. Open-Meteo
# then 429s or the whole request outlives the proxy, and the panel shows
# "failed" on every retry. Cap the cell count and coarsen the step.
_MAX_MODEL_CELLS = 1000
# Stop waiting and return whatever chunks finished. Unfinished cells are
# left as gaps, not painted as calm.
_GRID_DEADLINE_S = 18.0
_GRID_CACHE: TtlCache[tuple, "ModelWindGrid"] = TtlCache(ttl_s=180, maxsize=12)


def choose_model_step(
    west: float, south: float, east: float, north: float,
    preferred: float = 0.5,
) -> float:
    """Step that keeps the Open-Meteo request inside ``_MAX_MODEL_CELLS``."""
    span_lat = max(north - south, 0.5)
    span_lon = max(east - west, 0.5)
    step = max(preferred, 0.5)
    while step < 2.0:
        nlat = int(span_lat / step) + 1
        nlon = int(span_lon / step) + 1
        if nlat * nlon <= _MAX_MODEL_CELLS:
            return round(step, 2)
        step = round(step + 0.25, 2)
    return 2.0


def _extract_bulk_frames(
    requested_coords: list[tuple[float, float]],
    items: list[dict],
    now: datetime,
) -> tuple[list[WindCoord], dict[int, tuple[list[float], list[float | None], str]]]:
    """Parse Open-Meteo's multi-location response into (coords, frames).

    ``frames`` is keyed by forecast-hour offset (from ``now``) matching
    ``_FORECAST_HOURS``; each value is a tuple of parallel arrays
    (wind_kt_per_coord, wind_dir_deg_per_coord, valid_time_utc).

    Coordinates emit at the *requested* lat/lon (not Open-Meteo's returned
    lat/lon — that would snap to the model's native grid and break cell
    -alignment with the observed grid on the frontend).

    A cell with no wind speed is omitted, not written as 0 kt. A missing
    Open-Meteo item used to paint a calm stripe. Arrays stay parallel
    because a coord and its winds are appended together. A real 0 m/s
    is kept — that is calm wind, not a missing field."""
    coords: list[WindCoord] = []
    frame_kts: dict[int, list[float]] = {h: [] for h in _FORECAST_HOURS}
    frame_dirs: dict[int, list[float | None]] = {h: [] for h in _FORECAST_HOURS}
    frame_vt: dict[int, str] = {h: "" for h in _FORECAST_HOURS}

    for i, req in enumerate(requested_coords):
        item = items[i] if i < len(items) else {}
        hourly = (item or {}).get("hourly") or {}
        times = hourly.get("time") or []
        speeds = hourly.get("wind_speed_10m") or []
        dirs = hourly.get("wind_direction_10m") or []
        if not any(s is not None for s in speeds):
            continue
        req_lat, req_lon = req
        coords.append(WindCoord(
            lat=round(float(req_lat), 3),
            lon=round(float(req_lon), 3),
        ))

        base_idx = _nearest_hour_index(times, now) if times else None

        for h in _FORECAST_HOURS:
            kt: float = 0.0
            dir_deg_out: float | None = None
            if base_idx is not None and times:
                idx = base_idx + h  # 1-hour steps in Open-Meteo's array
                if idx < len(times):
                    speed_ms = speeds[idx] if idx < len(speeds) else None
                    if speed_ms is not None:
                        kt = round(
                            float(_mps_to_kt(float(speed_ms)) or 0.0), 1,
                        )
                        dir_raw = dirs[idx] if idx < len(dirs) else None
                        dir_deg_out = (
                            round(float(dir_raw), 1)
                            if dir_raw is not None else None
                        )
                        if not frame_vt[h]:
                            t = times[idx]
                            frame_vt[h] = t if t.endswith("Z") else (t + "Z")
            frame_kts[h].append(kt)
            frame_dirs[h].append(dir_deg_out)

    frames_per_hour = {
        h: (frame_kts[h], frame_dirs[h], frame_vt[h])
        for h in _FORECAST_HOURS
    }
    return coords, frames_per_hour


# Manual LRU that ONLY caches successful non-empty results. The previous
# @lru_cache implementation also cached failures — once Open-Meteo returned
# 429 for any chunk (transient rate-limit or blip), the empty tuple got
# baked into the cache and every future request in that serverless
# container returned "no data available" until the process recycled. Users
# saw ECMWF flip from "working" to permanently "unavailable" mid-session.
_BULK_CACHE_MAX = 64
_bulk_cache: OrderedDict[tuple[str, str, str], tuple[dict, ...]] = OrderedDict()


def _chunk_has_real_wind(items: tuple[dict, ...]) -> bool:
    """True when Open-Meteo actually returned a wind speed.

    A HTTP 200 whose ``wind_speed_10m`` values are all null is an empty
    model (mid-Pacific ECMWF, or a blip), not a calm grid. Caching it
    made GFS/Euro look permanently unavailable until the process restarted.
    A real 0 m/s is kept — that is calm wind, not a missing field.
    """
    for item in items:
        hourly = (item or {}).get("hourly") or {}
        for speed in hourly.get("wind_speed_10m") or []:
            if speed is not None:
                return True
    return False


def _fetch_bulk_chunk(
    lat_str: str, lon_str: str, model_key: str, *, refresh: bool = False,
) -> tuple[dict, ...]:
    """Fetch one multi-location Open-Meteo chunk with retries on 429.
    Successful responses that contain at least one real wind value are
    cached; failures, empty bodies, and all-null winds are not (so a
    transient rate-limit doesn't permanently poison the bbox).
    ``refresh`` bypasses the cache read."""
    key = (lat_str, lon_str, model_key)
    if not refresh:
        hit = _bulk_cache.get(key)
        if hit is not None:
            _bulk_cache.move_to_end(key)
            return hit

    import time as _t
    params = {
        "latitude": lat_str,
        "longitude": lon_str,
        "hourly": "wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "ms",
        "timezone": "UTC",
        # 6 days covers the full 0..120h forecast horizon we sample for
        # the time slider (NHC ships 5-day forecasts; +1 day of headroom
        # so a T+120 sample never falls off the end).
        "forecast_days": 6,
        "models": model_key,
    }
    url = f"{OPEN_METEO_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT},
    )
    items: tuple[dict, ...] = ()
    for attempt in range(_RETRY_ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            payload = data if isinstance(data, list) else [data]
            items = tuple(payload)
            break
        except urllib.error.HTTPError as e:
            # Retry 429 (rate-limit), 500-series (transient upstream), and
            # 502/503/504 (edge/gateway hiccups). Anything else — 400 for a
            # malformed URL, 404 for an unknown model — is a permanent
            # failure and further retries won't help.
            transient = (
                e.code == 429
                or (500 <= e.code < 600)
            )
            if transient and attempt < _RETRY_ATTEMPTS:
                _t.sleep(_RETRY_BACKOFF_S * (2 ** attempt))
                continue
            break
        except (
            urllib.error.URLError,
            TimeoutError,
            ConnectionError,
            json.JSONDecodeError,
        ):
            # Network-level errors and truncated JSON both retry — they're
            # exactly the class of hiccup that leaves horizontal gaps in
            # the grid when only one chunk hits them.
            if attempt < _RETRY_ATTEMPTS:
                _t.sleep(_RETRY_BACKOFF_S * (2 ** attempt))
                continue
            break
        except Exception:  # noqa: BLE001
            break

    if items and _chunk_has_real_wind(items):
        _bulk_cache[key] = items
        while len(_bulk_cache) > _BULK_CACHE_MAX:
            _bulk_cache.popitem(last=False)
    return items


def fetch_model_wind_grid(
    west: float, south: float, east: float, north: float,
    model_wire: str, *, step_deg: float | None = None, refresh: bool = False,
) -> ModelWindGrid:
    """GFS or ECMWF wind grid over the bbox, returned as forecast frames.

    The step coarsens on a large cone so the click finishes inside
    ``_GRID_DEADLINE_S`` instead of dying at the proxy. A finished grid
    with real wind is cached for a few minutes; an empty result is not,
    so Retry can ask Open-Meteo again. ``refresh`` skips the cache read.
    """
    model_key = next(
        (k for (k, wire) in MODELS if wire == model_wire), None,
    )
    if model_key is None:
        raise ValueError(f"unknown model wire name: {model_wire!r}")

    step_deg = choose_model_step(
        west, south, east, north, preferred=step_deg or 0.5,
    )
    cache_key = (
        round(west, 2), round(south, 2), round(east, 2), round(north, 2),
        model_wire, step_deg,
    )
    if not refresh:
        hit = _GRID_CACHE.get(cache_key)
        if hit is not None:
            return hit

    # Build the full coord list.
    coords: list[tuple[float, float]] = []
    lat = south
    while lat <= north + 1e-9:
        lon = west
        while lon <= east + 1e-9:
            coords.append((round(lat, 3), round(lon, 3)))
            lon += step_deg
        lat += step_deg

    if not coords:
        return ModelWindGrid(
            model=model_wire, step_deg=step_deg, cells=[], frames=[],
        )

    now = datetime.now(timezone.utc)
    chunks = [
        coords[i : i + _CHUNK_SIZE]
        for i in range(0, len(coords), _CHUNK_SIZE)
    ]

    # Chunks finish out of order. Each cell's wind is appended with its
    # own coord, so the parallel arrays stay aligned without row-major order.
    all_coords: list[WindCoord] = []
    all_kts: dict[int, list[float]] = {h: [] for h in _FORECAST_HOURS}
    all_dirs: dict[int, list[float | None]] = {h: [] for h in _FORECAST_HOURS}
    frame_valid_times: dict[int, str] = {h: "" for h in _FORECAST_HOURS}

    pool = ThreadPoolExecutor(max_workers=min(4, len(chunks)))
    fut_to_chunk: dict = {}
    try:
        for ch in chunks:
            lat_str = ",".join(f"{c[0]:.3f}" for c in ch)
            lon_str = ",".join(f"{c[1]:.3f}" for c in ch)
            fut = pool.submit(
                _fetch_bulk_chunk, lat_str, lon_str, model_key, refresh=refresh,
            )
            fut_to_chunk[fut] = ch
        done, _pending = wait(set(fut_to_chunk), timeout=_GRID_DEADLINE_S)
        for fut in done:
            ch = fut_to_chunk[fut]
            try:
                items = fut.result()
            except Exception:  # noqa: BLE001
                items = ()
            # A chunk that never came back is a gap, not a calm stripe.
            if not items or not _chunk_has_real_wind(tuple(items)):
                continue
            chunk_coords, chunk_frames = _extract_bulk_frames(ch, list(items), now)
            all_coords.extend(chunk_coords)
            for h in _FORECAST_HOURS:
                kts, dirs, vt = chunk_frames.get(h, ([], [], ""))
                all_kts[h].extend(kts)
                all_dirs[h].extend(dirs)
                if vt and not frame_valid_times[h]:
                    frame_valid_times[h] = vt
    finally:
        # Don't block the response on a chunk that is still inside urlopen.
        pool.shutdown(wait=False, cancel_futures=True)

    frames: list[ModelWindFrame] = []
    for h in _FORECAST_HOURS:
        vt = frame_valid_times[h]
        if not vt:
            # Frame has no data (past the model's forecast horizon).
            continue
        frames.append(ModelWindFrame(
            hour=h,
            valid_time_utc=vt,
            wind_kt=all_kts[h],
            wind_dir_deg=all_dirs[h],
        ))

    grid = ModelWindGrid(
        model=model_wire, step_deg=step_deg,
        cells=all_coords, frames=frames,
    )
    if any(any(kt > 0 for kt in f.wind_kt) for f in frames):
        _GRID_CACHE.set(cache_key, grid)
    return grid


__all__ = [
    "ModelForecast",
    "ModelWindFrame",
    "ModelWindGrid",
    "PointForecast",
    "WindCoord",
    "choose_model_step",
    "fetch_model_wind_grid",
    "point_forecast",
]
