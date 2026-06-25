"""County-level hazard overlays — hail, tornado, wildfire.

Each peril returns a per-county score normalised to [0, 1] for the
frontend choropleth, plus the raw count / index for the tooltip. v1
ships **synthetic patterns anchored on the real geographic
distributions** that the cited data sources publish, so the maps look
right for demos without bundling 100+ MB of CSV. Swapping to real data
is a single function change per peril — the calling code only sees
``HazardScore`` dataclasses.

Data sources we'd swap in for production:

- **Tornado**: NOAA Storm Prediction Center "SVRGIS" CSV, 1950-present
  tornado tracks. Aggregate count per county, optionally weight by
  EF-scale or path length.
  https://www.spc.noaa.gov/gis/svrgis/

- **Hail**: NOAA SPC severe weather event database, ≥1 inch hail
  reports per county, 1955-present. Same aggregation pattern.
  https://www.spc.noaa.gov/wcm/#data

- **Wildfire**: USFS Wildfire Hazard Potential (WHP), a 1-5 integer
  index per ~270m raster cell from the LANDFIRE program. County
  aggregation = area-weighted mean.
  https://www.firelab.org/project/wildfire-hazard-potential
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

HazardType = Literal["tornado", "hail", "wildfire"]


@dataclass(slots=True, frozen=True)
class HazardGridPoint:
    lat: float
    lon: float
    raw: float        # native units (count or index)
    normalised: float # 0..1 for colour ramp


@dataclass(slots=True, frozen=True)
class HazardLegend:
    title: str
    unit: str         # "tornadoes since 1950" / "≥1″ hail reports since 1955" / "WHP index (1-5)"
    source: str       # human-readable attribution
    source_url: str
    raw_min: float
    raw_max: float
    palette: list[str]
    stops: list[float]  # raw-value thresholds aligned with palette colours
    note: str | None = None


# ─────────────────────────── per-peril scoring ───────────────────────────


def _dist_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    # Small-distance flat-earth approximation; fine for ranking inside CONUS.
    dlat = (lat1 - lat2) * 111.0
    dlon = (lon1 - lon2) * 111.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.sqrt(dlat * dlat + dlon * dlon)


def _tornado_raw(lat: float, lon: float) -> float:
    """Synthetic 1950-2023 tornado count per county, anchored on:
       - Tornado Alley centroid ~35°N, -98°W (OK / KS / TX panhandle)
       - Dixie Alley centroid  ~33°N, -88°W (MS / AL / LA / W. TN)
       - Florida + SE coast secondary peak (mostly weak EF0-1)
    The headline 1950-2023 counts published by SPC peak around 250-400
    per county in TX/OK/KS, 40-150 in Dixie, 50-120 in central FL, and
    <20 across the Mountain West / NE.
    """
    if not (24.0 <= lat <= 49.5 and -125.0 <= lon <= -66.0):
        return 0.0
    d_alley = _dist_km(lat, lon, 35.0, -98.0)
    d_dixie = _dist_km(lat, lon, 33.0, -88.0)
    d_fl    = _dist_km(lat, lon, 28.5, -81.5)
    score = (
        320 * math.exp(-(d_alley / 380) ** 2) +
        140 * math.exp(-(d_dixie / 320) ** 2) +
         95 * math.exp(-(d_fl    / 220) ** 2)
    )
    # Eastern seaboard + Ohio Valley baseline
    if -90.0 <= lon <= -75.0 and 36.0 <= lat <= 43.0:
        score += 15
    # Mountain West suppression
    if -120.0 <= lon <= -103.0 and lat >= 35.0:
        score *= 0.20
    return max(0.0, score)


def _hail_raw(lat: float, lon: float) -> float:
    """Synthetic ≥1″ hail report count per county, 1955-2023, anchored on:
       - Hail Alley centroid ~38°N, -101°W (E. CO / W. KS / NE / W. TX)
       - Secondary peak central Plains ~40°N, -97°W (NE / IA / MO)
    SPC publishes peaks of 700-1200 per county in Hail Alley, 200-500
    Midwest, 50-200 Southeast, <50 in West Coast / NE.
    """
    if not (24.0 <= lat <= 49.5 and -125.0 <= lon <= -66.0):
        return 0.0
    d_main = _dist_km(lat, lon, 38.0, -101.0)
    d_mid  = _dist_km(lat, lon, 40.0, -97.0)
    d_se   = _dist_km(lat, lon, 33.0, -85.0)
    score = (
        900 * math.exp(-(d_main / 350) ** 2) +
        450 * math.exp(-(d_mid  / 320) ** 2) +
        180 * math.exp(-(d_se   / 450) ** 2)
    )
    # West coast suppression
    if lon < -115.0:
        score *= 0.15
    return max(0.0, score)


def _wildfire_raw(lat: float, lon: float) -> float:
    """USFS Wildfire Hazard Potential — 1-5 index per county. Anchored on:
       - California chaparral + Sierra: 4-5
       - Mountain West (OR/WA east, ID, NV, AZ, NM, CO, UT, WY): 4-5
       - Florida pine flatwoods: 3-4 (hot pockets)
       - Eastern seaboard / Midwest: 1-2
       - Pacific NW coast: 3-4
    """
    if not (24.0 <= lat <= 49.5 and -125.0 <= lon <= -66.0):
        return 1.0
    score = 1.0  # baseline
    # California chaparral / Sierra
    d_ca = _dist_km(lat, lon, 36.5, -119.5)
    score += 4.0 * math.exp(-(d_ca / 350) ** 2)
    # Mountain west
    if -120.0 <= lon <= -104.0 and 32.0 <= lat <= 49.0:
        score += 2.5
    # Pacific NW
    if -125.0 <= lon <= -120.0 and 42.0 <= lat <= 49.0:
        score += 1.5
    # Texas hill country + west TX
    if -106.0 <= lon <= -98.0 and 28.0 <= lat <= 35.0:
        score += 1.2
    # Florida pine flatwoods — small bumps
    if -83.0 <= lon <= -80.0 and 27.0 <= lat <= 30.5:
        score += 1.0
    # Eastern seaboard suppression handled by baseline + lack of bonus
    if lon > -85.0 and lat > 32.0:
        score = min(score, 2.5)
    return max(1.0, min(5.0, score))


# ─────────────────────────── public API ───────────────────────────


def _us_land_filter(lat: float, lon: float, county_grid: dict) -> bool:
    """Return True if (lat, lon) is on US land — proxy via county centroid
    proximity. Same heuristic used by the SST mask, INVERTED purpose: we
    KEEP land here (hail/tornado/wildfire are land phenomena)."""
    if not (24.0 <= lat <= 49.5 and -125.0 <= lon <= -66.0):
        return False
    radius_nm = 25.0
    deg = radius_nm / 50.0
    lat_lo, lat_hi = lat - deg, lat + deg
    lon_lo, lon_hi = lon - deg, lon + deg
    for c in county_grid.values():
        if not (lat_lo <= c.centroid_lat <= lat_hi and lon_lo <= c.centroid_lon <= lon_hi):
            continue
        dlat = lat - c.centroid_lat
        dlon = lon - c.centroid_lon
        if (dlat * dlat + dlon * dlon) ** 0.5 * 60 <= radius_nm:
            return True
    return False


@lru_cache(maxsize=8)
def build_grid(
    hazard: HazardType,
    step_deg: float = 0.4,
) -> tuple[list[HazardGridPoint], HazardLegend, float]:
    """Sample the hazard scoring function on a regular lat/lon grid covering
    CONUS, clipped to US land. Returned cells tile contiguously when the
    frontend draws each as a step_deg square fill — gives a smooth heatmap
    that ignores county / state lines.

    Cached per peril (the synthetic scoring is deterministic).
    """
    from .hurricane_impact import county_centroids

    raw_fn = {
        "tornado": _tornado_raw,
        "hail": _hail_raw,
        "wildfire": _wildfire_raw,
    }[hazard]

    county_grid = county_centroids()
    south, north = 24.0, 49.5
    west, east = -125.0, -66.0

    points: list[HazardGridPoint] = []
    raws: list[float] = []
    lat = south
    while lat <= north + 1e-9:
        lon = west
        while lon <= east + 1e-9:
            if _us_land_filter(lat, lon, county_grid):
                r = raw_fn(lat, lon)
                points.append(HazardGridPoint(lat=round(lat, 3), lon=round(lon, 3), raw=r, normalised=0.0))
                raws.append(r)
            lon += step_deg
        lat += step_deg

    raw_min = min(raws) if raws else 0.0
    raw_max = max(raws) if raws else 1.0
    span = max(raw_max - raw_min, 1e-9)
    # Re-pack with normalised scores (frozen dataclass → new instances).
    out = [
        HazardGridPoint(
            lat=p.lat,
            lon=p.lon,
            raw=round(p.raw, 2),
            normalised=round((p.raw - raw_min) / span, 4),
        )
        for p in points
    ]
    legend = _legend_for(hazard, raw_min, raw_max)
    return out, legend, step_deg


def _legend_for(hazard: HazardType, raw_min: float, raw_max: float) -> HazardLegend:
    if hazard == "tornado":
        # Cool→warm palette; stops chosen so colour reads at intuitive count breaks
        palette = ["#f1f5f9", "#fde68a", "#fdba74", "#f97316", "#dc2626", "#7f1d1d"]
        stops = [0, 25, 75, 150, 250, 400]
        return HazardLegend(
            title="Tornado frequency",
            unit="tornadoes 1950–2023",
            source="NOAA SPC SVRGIS — pattern (production: raw SPC counts)",
            source_url="https://www.spc.noaa.gov/gis/svrgis/",
            raw_min=raw_min,
            raw_max=raw_max,
            palette=palette,
            stops=stops,
            note="Synthetic pattern calibrated to SPC tornado-database peaks in Tornado Alley + Dixie Alley + FL.",
        )
    if hazard == "hail":
        palette = ["#f1f5f9", "#e0f2fe", "#bae6fd", "#93c5fd", "#6366f1", "#3730a3"]
        stops = [0, 50, 150, 350, 600, 900]
        return HazardLegend(
            title="Severe hail frequency",
            unit="≥1″ hail reports 1955–2023",
            source="NOAA SPC severe-event DB — pattern (production: raw SPC counts)",
            source_url="https://www.spc.noaa.gov/wcm/#data",
            raw_min=raw_min,
            raw_max=raw_max,
            palette=palette,
            stops=stops,
            note="Synthetic pattern calibrated to Hail Alley (E. CO / W. KS / NE) + central Plains secondary peak.",
        )
    # wildfire
    palette = ["#f1f5f9", "#fef08a", "#fdba74", "#f97316", "#b91c1c", "#7f1d1d"]
    stops = [1, 1.8, 2.5, 3.2, 4.0, 4.7]
    return HazardLegend(
        title="Wildfire hazard potential",
        unit="WHP index (1 low … 5 very high)",
        source="USFS Wildfire Hazard Potential — pattern (production: LANDFIRE raster aggregated to county)",
        source_url="https://www.firelab.org/project/wildfire-hazard-potential",
        raw_min=raw_min,
        raw_max=raw_max,
        palette=palette,
        stops=stops,
        note="Synthetic pattern calibrated to USFS WHP peaks in California chaparral + Mountain West.",
    )
