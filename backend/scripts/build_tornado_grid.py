"""Build the tornado-frequency grid from the NOAA SPC SVRGIS shapefile.

Reads `1950-2025-torn-initpoint.shp` (point geometry = the initial
touchdown of each tornado segment) and aggregates to a regular lat/lon
grid via a Gaussian-kernel density estimate, with a recency weight that
upweights post-1980 tornadoes ~3× (Tornado Alley shifting east) plus a
population-bias deflator that tames the urban reporting spike (OKC /
DFW / Atlanta — see _pop_bias.py for the rationale).

Output: ``mockdata/hazard_tornado_grid.json`` as ``{stepDeg, cells}``.

Usage (one-off, after dropping a new shapefile in Downloads):

    cd backend
    .venv/Scripts/python.exe scripts/build_tornado_grid.py

(pyshp is a build-time dep only; the runtime never reads .shp files.)
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))  # for _pop_bias

try:
    import shapefile  # type: ignore[import-not-found]  # pyshp
except ImportError:
    sys.exit("pyshp is required: pip install pyshp")

from _pop_bias import deflator  # noqa: E402


# ─────────────────────────── config ───────────────────────────

SPC_SHP = Path(
    r"C:\Users\James\Downloads\1950-2025-torn-initpoint\1950-2025-torn-initpoint\1950-2025-torn-initpoint.shp"
)
OUT_PATH = (
    Path(__file__).resolve().parents[2] / "mockdata" / "hazard_tornado_grid.json"
)

STEP_DEG = 0.2          # ~14 mi cells — granular enough to resolve county-scale hot spots
SIGMA_DEG = 0.3         # KDE bandwidth — wider than step for smoothness, narrower than v1 for detail
KERNEL_RADIUS_DEG = 1.0 # truncate the kernel at this radius (≈3·sigma)

SOUTH, NORTH = 24.0, 49.5
WEST, EAST = -125.0, -66.0


def _recency_weight(year: int) -> float:
    """Tornado climatology has shifted slightly east since ~1980 (Tippett et
    al. and follow-ups). Weight recent tornadoes more so the heatmap
    reflects current climatology rather than the 75-year average."""
    t = max(0.0, min(1.0, (year - 1950) / 75))
    return 0.5 + 1.5 * t  # 1950 = 0.5x, 1985 = ~1.2x, 2025 = 2.0x


def _mag_weight(mag) -> float:
    """All tornadoes count, but EF3+ get a small boost since they carry
    most of the damage signal underwriters care about."""
    try:
        m = int(mag)
    except (TypeError, ValueError):
        return 1.0
    if m < 0:  # unknown
        return 1.0
    return 1.0 + 0.5 * max(0, m - 2)  # EF2 = 1.0, EF3 = 1.5, EF4 = 2.0, EF5 = 2.5


def main() -> None:
    if not SPC_SHP.exists():
        sys.exit(f"shapefile not found: {SPC_SHP}")
    sf = shapefile.Reader(str(SPC_SHP))
    field_names = [f[0] for f in sf.fields[1:]]
    yr_i = field_names.index("yr")
    mag_i = field_names.index("mag")
    print(f"loaded {len(sf):,} tornado records")

    # Build grid
    nlat = int(round((NORTH - SOUTH) / STEP_DEG)) + 1
    nlon = int(round((EAST - WEST) / STEP_DEG)) + 1
    grid = [[0.0] * nlon for _ in range(nlat)]

    sigma2 = SIGMA_DEG * SIGMA_DEG
    cell_radius = int(KERNEL_RADIUS_DEG / STEP_DEG) + 1

    used = 0
    skipped = 0
    yr_min, yr_max = 9999, -9999
    for sr in sf.iterShapeRecords():
        rec = sr.record
        try:
            year = int(rec[yr_i])
        except (TypeError, ValueError):
            skipped += 1
            continue
        if year < 1950 or year > 2025:
            skipped += 1
            continue
        pts = sr.shape.points
        if not pts:
            skipped += 1
            continue
        lon, lat = pts[0]
        if not (SOUTH <= lat <= NORTH and WEST <= lon <= EAST):
            skipped += 1
            continue
        mag = rec[mag_i] if mag_i >= 0 else None
        w = _recency_weight(year) * _mag_weight(mag)

        # KDE — spread the tornado's weight to nearby cells with a Gaussian.
        ci = int(round((lat - SOUTH) / STEP_DEG))
        cj = int(round((lon - WEST) / STEP_DEG))
        for di in range(-cell_radius, cell_radius + 1):
            i = ci + di
            if i < 0 or i >= nlat:
                continue
            g_lat = SOUTH + i * STEP_DEG
            dlat = g_lat - lat
            for dj in range(-cell_radius, cell_radius + 1):
                j = cj + dj
                if j < 0 or j >= nlon:
                    continue
                g_lon = WEST + j * STEP_DEG
                dlon = g_lon - lon
                d2 = dlat * dlat + dlon * dlon
                if d2 > KERNEL_RADIUS_DEG * KERNEL_RADIUS_DEG:
                    continue
                grid[i][j] += w * math.exp(-d2 / sigma2)
        used += 1
        if year < yr_min:
            yr_min = year
        if year > yr_max:
            yr_max = year

    # Population-bias deflation — pre-compute deflator per cell once.
    print("applying population-bias deflation...")
    deflators: list[list[float]] = [[1.0] * nlon for _ in range(nlat)]
    for i in range(nlat):
        g_lat = SOUTH + i * STEP_DEG
        for j in range(nlon):
            g_lon = WEST + j * STEP_DEG
            deflators[i][j] = deflator(g_lat, g_lon)

    # Emit cells over a small threshold so the JSON stays compact.
    # Threshold scales with cell area — smaller cells, smaller threshold.
    cells: list[dict] = []
    threshold = 0.2
    for i in range(nlat):
        for j in range(nlon):
            v = grid[i][j] / deflators[i][j]
            if v < threshold:
                continue
            cells.append(
                {
                    "lat": round(SOUTH + i * STEP_DEG, 3),
                    "lon": round(WEST + j * STEP_DEG, 3),
                    "raw": round(v, 2),
                }
            )

    payload = {"stepDeg": STEP_DEG, "cells": cells}
    OUT_PATH.write_text(json.dumps(payload), encoding="utf-8")
    print(
        f"used {used:,} tornadoes ({yr_min}-{yr_max}), skipped {skipped:,}.\n"
        f"emitted {len(cells):,} grid cells -> {OUT_PATH}"
    )
    if cells:
        top = sorted(cells, key=lambda d: -d["raw"])[:8]
        print("top cells:")
        for t in top:
            print(f"  ({t['lat']:.2f},{t['lon']:.2f}) raw={t['raw']}")
        # Distribution check — helps tune color stops in hazard_overlay.py
        raws = sorted(c["raw"] for c in cells)
        def pct(p: float) -> float:
            return raws[int(len(raws) * p)]
        print(
            f"distribution: p50={pct(0.5):.1f} p75={pct(0.75):.1f} "
            f"p90={pct(0.9):.1f} p95={pct(0.95):.1f} p98={pct(0.98):.1f} "
            f"p99={pct(0.99):.1f} max={raws[-1]:.1f}"
        )


if __name__ == "__main__":
    main()
