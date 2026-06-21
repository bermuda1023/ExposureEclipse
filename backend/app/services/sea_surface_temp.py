"""Sea-surface temperature ("ocean energy") layer.

For a v1 demo this returns a deterministic synthetic SST grid around a
bounding box — climatologically plausible for the Atlantic, late-summer
peak: warmer water in the Caribbean/Gulf (~28-30 °C), cooler in the
mid-Atlantic and north (~20-25 °C), with a "warm pool" bias toward the
Loop Current. A real-data hookup (NOAA Coral Reef Watch / ERDDAP MURSST)
can replace ``sst_grid`` later without touching the API shape.

SST is the simplest proxy for "ocean energy" available to a hurricane.
The more rigorous measure is Tropical Cyclone Heat Potential (TCHP) —
integrated heat in the upper 26 °C layer — but that data is harder to
serve in real time. Underwriters mostly want the same intuition (warm
water under the storm = bad) so SST does the job here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class SSTPoint:
    lat: float
    lon: float
    temp_c: float
    favorable_for_intensification: bool  # SST ≥ 26.5 °C, the classic threshold


# Anchors that give a vaguely realistic late-summer Atlantic field. Values
# in °C. Each entry is (lat, lon, sst). We interpolate via inverse-distance
# weighting at query time.
_ANCHORS: tuple[tuple[float, float, float], ...] = (
    # Caribbean / Gulf — the warm pool
    (15.0,  -75.0, 29.5),
    (20.0,  -85.0, 30.0),  # Western Caribbean / Gulf
    (24.0,  -84.0, 29.7),  # Loop Current
    (26.0,  -82.0, 29.5),  # SW Florida shelf
    (25.0,  -78.0, 29.0),  # Bahamas
    # SE US coast
    (30.0,  -80.0, 27.5),
    (32.0,  -78.0, 26.8),
    # Mid-Atlantic
    (36.0,  -73.0, 25.0),
    (40.0,  -70.0, 22.5),
    # Tropical Atlantic (MDR)
    (12.0,  -45.0, 28.5),
    (15.0,  -55.0, 28.7),
    (20.0,  -55.0, 28.0),
    # Subtropical Atlantic
    (28.0,  -60.0, 27.0),
    (32.0,  -55.0, 25.5),
    (38.0,  -50.0, 23.0),
    # Northern
    (44.0,  -55.0, 18.0),
    (47.0,  -45.0, 16.0),
)

INTENSIFICATION_THRESHOLD_C = 26.5


def _interp_sst(lat: float, lon: float) -> float:
    """Inverse-distance-weighted SST from the anchor points (k=2 power)."""
    weights = 0.0
    weighted = 0.0
    for a_lat, a_lon, sst in _ANCHORS:
        d2 = (lat - a_lat) ** 2 + (lon - a_lon) ** 2
        if d2 < 1e-6:
            return sst
        w = 1.0 / (d2 ** 1.0)
        weights += w
        weighted += w * sst
    return weighted / weights if weights else 0.0


def sst_grid(
    *,
    bbox: tuple[float, float, float, float],
    step_deg: float = 1.0,
) -> list[SSTPoint]:
    """Sample SST on a regular lat/lon grid covering ``bbox``."""
    west, south, east, north = bbox
    pts: list[SSTPoint] = []
    lat = south
    while lat <= north + 1e-9:
        lon = west
        while lon <= east + 1e-9:
            t = _interp_sst(lat, lon)
            pts.append(
                SSTPoint(
                    lat=round(lat, 3),
                    lon=round(lon, 3),
                    temp_c=round(t, 1),
                    favorable_for_intensification=t >= INTENSIFICATION_THRESHOLD_C,
                )
            )
            lon += step_deg
        lat += step_deg
    return pts


def sst_at_point(lat: float, lon: float) -> SSTPoint:
    t = _interp_sst(lat, lon)
    return SSTPoint(
        lat=round(lat, 3),
        lon=round(lon, 3),
        temp_c=round(t, 1),
        favorable_for_intensification=t >= INTENSIFICATION_THRESHOLD_C,
    )


# Suppress lint about an unused import — math is intentionally kept available
# for a future real-data swap.
_ = math
