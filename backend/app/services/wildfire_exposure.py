"""Exposed TIV inside a fire polygon, rolled up by client.

The real answer needs location-level exposure (lat/lon per insured location).
The v1 data plane is county-aggregated, so we SYNTHESIZE plausible locations:
each in-portfolio county's TIV is scattered as K deterministic points within
that county, tagged by client (cedent). Point-in-polygon then rolls TIV up by
client for any fire polygon — official WFIGS perimeter or our heat-derived
shape.

This is clearly flagged ``synthetic`` on the wire. When real individual-
location data is loaded, replace ``_load_locations()`` with that source and the
point-in-polygon rollup below is unchanged.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from ..config import get_settings
from .hurricane_impact import county_centroids

_BACKEND_DIR = Path(__file__).resolve().parents[2]

# Deterministic synthetic locations per county fact; TIV split evenly across.
_POINTS_PER_COUNTY = 4
_JITTER_DEG = 0.10          # scatter radius around the county centroid
_GRID_DEG = 0.5            # spatial index cell size
_MAX_POLYGONS = 50


@dataclass(slots=True, frozen=True)
class Location:
    lon: float
    lat: float
    tiv: float
    client: str
    programme: str


def _mock_dir() -> Path:
    raw = get_settings().mock_data_dir  # e.g. "../mockdata" relative to backend/
    p = Path(raw)
    return p if p.is_absolute() else (_BACKEND_DIR / p).resolve()


def _jitter(seed: str) -> tuple[float, float]:
    """Deterministic (dx, dy) in [-_JITTER_DEG, _JITTER_DEG]."""
    h = hashlib.sha1(seed.encode()).digest()
    fx = int.from_bytes(h[0:4], "big") / 0xFFFFFFFF
    fy = int.from_bytes(h[4:8], "big") / 0xFFFFFFFF
    return (fx * 2 - 1) * _JITTER_DEG, (fy * 2 - 1) * _JITTER_DEG


@lru_cache(maxsize=1)
def _load_locations() -> tuple[list[Location], dict[tuple[int, int], list[int]], str]:
    """Build synthetic locations from in-portfolio county facts + a grid index.
    Returns (locations, cell->indices, currency)."""
    md = _mock_dir()
    try:
        datasets = json.loads((md / "datasets.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return [], {}, "USD"

    centroids = county_centroids()
    locs: list[Location] = []
    currency = "USD"
    for ds in datasets:
        if not ds.get("isIncludedInPortfolio"):
            continue
        currency = ds.get("currency") or currency
        client = ds.get("cedentName") or ds.get("datasetId") or "Unknown"
        programme = ds.get("programmeName") or ""
        fpath = md / "exposure_facts" / f"{ds['datasetId']}.json"
        try:
            rows = json.loads(fpath.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        for r in rows:
            if r.get("aggregation") != "COUNTY":
                continue
            tiv = r.get("tiv")
            gid = r.get("geographyId") or ""
            if not tiv or not gid:
                continue
            geoid = gid.split("-")[-1]
            meta = centroids.get(geoid)
            if meta is None:
                continue
            per = float(tiv) / _POINTS_PER_COUNTY
            for i in range(_POINTS_PER_COUNTY):
                dx, dy = _jitter(f"{ds['datasetId']}:{geoid}:{i}")
                locs.append(Location(
                    lon=meta.centroid_lon + dx,
                    lat=meta.centroid_lat + dy,
                    tiv=per,
                    client=client,
                    programme=programme,
                ))

    index: dict[tuple[int, int], list[int]] = {}
    for idx, loc in enumerate(locs):
        cell = (int(loc.lon // _GRID_DEG), int(loc.lat // _GRID_DEG))
        index.setdefault(cell, []).append(idx)
    return locs, index, currency


# ─────────────────────────── geometry ───────────────────────────


def _ring_contains(lon: float, lat: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi
        ):
            inside = not inside
        j = i
    return inside


def _polygon_contains(lon: float, lat: float, rings: list) -> bool:
    if not rings or not _ring_contains(lon, lat, rings[0]):
        return False
    return not any(_ring_contains(lon, lat, hole) for hole in rings[1:])


def point_in_geometry(lon: float, lat: float, geom: dict) -> bool:
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "Polygon":
        return _polygon_contains(lon, lat, c)
    if t == "MultiPolygon":
        return any(_polygon_contains(lon, lat, poly) for poly in c)
    return False


def _bbox(geom: dict) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []

    def walk(c) -> None:
        if c and isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for x in c:
                walk(x)

    walk(geom.get("coordinates"))
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


# ─────────────────────────── rollup ───────────────────────────


def exposure_in_polygon(geom: dict) -> tuple[float, int, dict[str, tuple[float, int]]]:
    """Return (total_tiv, location_count, {client: (tiv, count)}) for locations
    inside ``geom``. Uses the grid index so only nearby candidates are tested."""
    locs, index, _ = _load_locations()
    bb = _bbox(geom)
    if bb is None or not locs:
        return 0.0, 0, {}
    west, south, east, north = bb
    cx0, cx1 = int(west // _GRID_DEG), int(east // _GRID_DEG)
    cy0, cy1 = int(south // _GRID_DEG), int(north // _GRID_DEG)

    total = 0.0
    count = 0
    by_client: dict[str, list] = {}
    for cx in range(cx0, cx1 + 1):
        for cy in range(cy0, cy1 + 1):
            for idx in index.get((cx, cy), ()):
                loc = locs[idx]
                if not (west <= loc.lon <= east and south <= loc.lat <= north):
                    continue
                if not point_in_geometry(loc.lon, loc.lat, geom):
                    continue
                total += loc.tiv
                count += 1
                cur = by_client.setdefault(loc.client, [0.0, 0])
                cur[0] += loc.tiv
                cur[1] += 1
    return total, count, {k: (v[0], v[1]) for k, v in by_client.items()}


def currency() -> str:
    return _load_locations()[2]


__all__ = ["exposure_in_polygon", "point_in_geometry", "currency", "Location"]
