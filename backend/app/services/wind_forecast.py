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
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache

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


@lru_cache(maxsize=256)
def _fetch_open_meteo_hourly(lat: float, lon: float, model_key: str) -> dict | None:
    """One HTTP GET to Open-Meteo for a single model's hourly wind block.

    Uses the ``hourly`` endpoint rather than ``current`` because ECMWF's IFS
    is only published on hourly cadence, so ``current`` returns nulls for it.
    Cached by (lat, lon, model) so rapid re-clicks near the same spot don't
    hammer the API."""
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
        url, headers={"User-Agent": "exposure-eclipse-forecast/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


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
class ModelWindCell:
    lat: float
    lon: float
    wind_kt: float
    wind_dir_deg: float | None


@dataclass(slots=True, frozen=True)
class ModelWindGrid:
    model: str
    step_deg: float
    cells: list[ModelWindCell]
    valid_time_utc: str


# Open-Meteo multi-location responses can be large; keep each URL under ~4 KB
# so we don't run into query-length limits at either their edge or in browsers
# (this endpoint is proxied, but the URL is still generated by the SDK).
_CHUNK_SIZE = 100


def _extract_bulk_cells(
    items: list[dict], wire_name: str, now: datetime,
) -> tuple[list[ModelWindCell], str]:
    """Flatten Open-Meteo's per-location responses into ModelWindCells at the
    nearest hour. Returns (cells, valid_time_utc)."""
    out: list[ModelWindCell] = []
    valid_time = ""
    for item in items:
        hourly = item.get("hourly") or {}
        times = hourly.get("time") or []
        speeds = hourly.get("wind_speed_10m") or []
        dirs = hourly.get("wind_direction_10m") or []
        if not times or not speeds:
            continue
        idx = _nearest_hour_index(times, now)
        if idx is None or idx >= len(speeds):
            continue
        speed_ms = speeds[idx]
        if speed_ms is None:
            continue
        dir_deg = dirs[idx] if idx < len(dirs) else None
        lat = item.get("latitude")
        lon = item.get("longitude")
        if lat is None or lon is None:
            continue
        if not valid_time:
            t = times[idx]
            valid_time = t if t.endswith("Z") else (t + "Z")
        out.append(
            ModelWindCell(
                lat=round(float(lat), 3),
                lon=round(float(lon), 3),
                wind_kt=round(float(_mps_to_kt(float(speed_ms)) or 0.0), 1),
                wind_dir_deg=(
                    round(float(dir_deg), 1) if dir_deg is not None else None
                ),
            )
        )
    return out, valid_time


@lru_cache(maxsize=32)
def _fetch_bulk_chunk(
    lat_str: str, lon_str: str, model_key: str,
) -> tuple[dict, ...]:
    """Cache key is the concatenated coord strings so identical bboxes reuse
    the result. Returns a tuple (hashable so lru_cache works) — caller
    converts to list."""
    params = {
        "latitude": lat_str,
        "longitude": lon_str,
        "hourly": "wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "ms",
        "timezone": "UTC",
        "forecast_days": 1,
        "models": model_key,
    }
    url = f"{OPEN_METEO_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url, headers={"User-Agent": "exposure-eclipse-forecast/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return ()
    # Single-loc responses are objects; multi-loc are lists. Normalize.
    items = data if isinstance(data, list) else [data]
    return tuple(items)


def fetch_model_wind_grid(
    west: float, south: float, east: float, north: float,
    model_wire: str, *, step_deg: float = 0.5,
) -> ModelWindGrid:
    """GFS or ECMWF wind grid over the bbox, at ``step_deg`` resolution.

    Uses Open-Meteo's multi-location endpoint (a single URL can hold ~100
    coordinates) with parallel chunked requests. Grid step is deliberately
    the same as the observed heatmap so the frontend can compute obs-vs
    -model diffs cell-by-cell without resampling."""
    model_key = next(
        (k for (k, wire) in MODELS if wire == model_wire), None,
    )
    if model_key is None:
        raise ValueError(f"unknown model wire name: {model_wire!r}")

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
            model=model_wire, step_deg=step_deg, cells=[], valid_time_utc="",
        )

    # Chunk the coords, then dispatch each chunk to Open-Meteo in parallel.
    now = datetime.now(timezone.utc)
    chunks = [
        coords[i : i + _CHUNK_SIZE]
        for i in range(0, len(coords), _CHUNK_SIZE)
    ]
    all_cells: list[ModelWindCell] = []
    valid_time = ""
    with ThreadPoolExecutor(max_workers=min(6, len(chunks))) as pool:
        futures = []
        for ch in chunks:
            lat_str = ",".join(f"{c[0]:.3f}" for c in ch)
            lon_str = ",".join(f"{c[1]:.3f}" for c in ch)
            futures.append(
                pool.submit(_fetch_bulk_chunk, lat_str, lon_str, model_key)
            )
        for fut in futures:
            try:
                items = fut.result()
            except Exception:  # noqa: BLE001
                items = ()
            cells, vt = _extract_bulk_cells(list(items), model_wire, now)
            all_cells.extend(cells)
            if vt and not valid_time:
                valid_time = vt

    return ModelWindGrid(
        model=model_wire, step_deg=step_deg,
        cells=all_cells, valid_time_utc=valid_time,
    )


__all__ = [
    "ModelForecast",
    "ModelWindCell",
    "ModelWindGrid",
    "PointForecast",
    "fetch_model_wind_grid",
    "point_forecast",
]
