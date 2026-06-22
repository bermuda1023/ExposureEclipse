"""Parametric wind-damage curve — sustained wind (kt) → damage ratio in [0, 1].

Used by the hurricane-impact engine to attach a projected ground-up loss to
each county after the wind field has been computed:

    projected_loss = TIV × damage_ratio(max_wind_kt)

v1 ships ONE curve, calibrated to a "residential mixed construction" shape
that matches the headline behaviour of public engineering models (Pinelli,
Vickery, Hazus-MH): trivial at TS strength, ~10% at Cat 3, ~40% at Cat 5.
Per-occupancy / per-construction curves are a future refinement (the same
engineering models differentiate by structure type, year built, terrain
roughness, etc.).

Anchors below are deliberately broad and conservative; users can swap in a
calibrated curve later by editing the ``_CURVE`` constant or making the
caller hand in a different ``DamageCurve`` instance.
"""

from __future__ import annotations

# (wind_kt, damage_ratio) anchors; linear interp between adjacent points.
_CURVE: tuple[tuple[float, float], ...] = (
    (0.0,    0.000),
    (40.0,   0.000),
    (50.0,   0.005),   # below TS: trivial
    (64.0,   0.015),   # Cat 1 threshold
    (83.0,   0.045),   # Cat 2
    (96.0,   0.105),   # Cat 3
    (113.0,  0.215),   # Cat 4
    (137.0,  0.400),   # Cat 5
    (160.0,  0.600),
    (180.0,  0.800),
    (250.0,  1.000),   # capped at total loss
)


def damage_ratio(wind_kt: float | int) -> float:
    """Damage ratio in [0, 1] for sustained wind ``wind_kt``.

    Linear interpolation between curve anchors; flat below the lowest anchor
    and at the upper cap.
    """
    if wind_kt is None or wind_kt <= _CURVE[0][0]:
        return 0.0
    if wind_kt >= _CURVE[-1][0]:
        return _CURVE[-1][1]
    for i in range(len(_CURVE) - 1):
        v1, d1 = _CURVE[i]
        v2, d2 = _CURVE[i + 1]
        if v1 <= wind_kt <= v2:
            if v2 == v1:
                return d2
            t = (wind_kt - v1) / (v2 - v1)
            return d1 + t * (d2 - d1)
    return 0.0


def projected_loss(tiv: float, wind_kt: float | int) -> tuple[float, float]:
    """Return ``(damage_ratio, projected_loss)`` for a TIV and sustained wind."""
    dr = damage_ratio(wind_kt)
    return dr, tiv * dr
