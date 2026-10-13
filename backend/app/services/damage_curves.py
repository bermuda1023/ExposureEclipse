"""Damage-ratio curve sets by segment and 10 mph wind band.

A curve set maps ``segment -> [DR per band]`` on the Florida Form V-1 bands
(41-50 mph … 161-170 mph), as decimals. Built-in sets come from the Form
V-1 Part A tables. Calibrated sets are JSON files written by
``backend/scripts/calibrate_damage_curves.py`` into ``mockdata/damage_curves/``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .industry_losses import LOSS_SEGMENTS, data_dir

BAND_MPH_LO: tuple[int, ...] = (41, 51, 61, 71, 81, 91, 101, 111, 121, 131, 141, 151, 161)

# Florida Commission Form V-1 Part A, building damage / building exposure (%).
# Same table as frontend/src/state/damageAssumptions.ts.
_FORM_V1_PCT: dict[str, tuple[float, ...]] = {
    "air": (0.05, 0.12, 0.46, 0.96, 1.89, 3.55, 7.34, 20.6, 32.8, 42.1, 54.2, 61.8, 71.7),
    "kcc": (0.11, 0.26, 0.73, 1.68, 3.79, 7.66, 14.6, 26.1, 32.6, 43.5, 52.4, 60.8, 72.1),
    "rms": (0.13, 0.33, 1.43, 3.22, 6.97, 14.7, 25.4, 44.6, 57.5, 76.6, 85.5, 90.0, 93.9),
}
_VENDOR_LABEL = {"air": "AIR (Form V-1)", "kcc": "KCC (Form V-1)", "rms": "RMS (Form V-1)"}

# ASSUMPTION: Form V-1 is residential building damage. Until calibrated,
# commercial uses the same curve and auto uses 15% of it (hurricane auto loss
# is mostly flood, which a wind curve does not see).
UNCALIBRATED_SEGMENT_SCALE: dict[str, float] = {"RESIDENTIAL": 1.0, "COMMERCIAL": 1.0, "AUTO": 0.15}

# ASSUMPTION: lognormal spread around the point estimate before any
# calibration exists. Replaced by fitted residual spreads in calibrated sets.
DEFAULT_SIGMA_COUNTY = 0.9
DEFAULT_SIGMA_EVENT = 0.45

CURVES_DIR = "damage_curves"


@dataclass(slots=True)
class CurveSet:
    id: str
    label: str
    kind: str  # "vendor" | "calibrated"
    segments: dict[str, list[float]]  # segment -> DR per BAND_MPH_LO band (0..1)
    sigma_log_county: float = DEFAULT_SIGMA_COUNTY
    sigma_log_event: float = DEFAULT_SIGMA_EVENT
    created_at: str | None = None
    fit: dict = field(default_factory=dict)

    def dr(self, segment: str, mph_lo: int) -> float:
        curve = self.segments.get(segment)
        if not curve or mph_lo < BAND_MPH_LO[0]:
            return 0.0
        if mph_lo >= BAND_MPH_LO[-1]:
            return curve[-1]
        return curve[(mph_lo - BAND_MPH_LO[0]) // 10]

    def to_wire(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "kind": self.kind,
            "bandsMphLo": list(BAND_MPH_LO),
            "segments": {seg: [round(v, 6) for v in vals] for seg, vals in self.segments.items()},
            "sigmaLogCounty": self.sigma_log_county,
            "sigmaLogEvent": self.sigma_log_event,
            "createdAt": self.created_at,
            "fit": self.fit,
        }


def vendor_curve(vendor: str) -> list[float]:
    return [p / 100.0 for p in _FORM_V1_PCT[vendor]]


def _vendor_set(vendor: str) -> CurveSet:
    base = vendor_curve(vendor)
    return CurveSet(
        id=vendor,
        label=_VENDOR_LABEL[vendor],
        kind="vendor",
        segments={seg: [v * UNCALIBRATED_SEGMENT_SCALE[seg] for v in base] for seg in LOSS_SEGMENTS},
    )


def curve_set_from_json(payload: dict) -> CurveSet:
    segments = {
        seg: [float(v) for v in vals]
        for seg, vals in (payload.get("segments") or {}).items()
        if seg in LOSS_SEGMENTS
    }
    for seg, vals in segments.items():
        if len(vals) != len(BAND_MPH_LO):
            raise ValueError(f"curve {payload.get('id')}: {seg} has {len(vals)} bands")
    return CurveSet(
        id=str(payload["id"]),
        label=str(payload.get("label") or payload["id"]),
        kind=str(payload.get("kind") or "calibrated"),
        segments=segments,
        sigma_log_county=float(payload.get("sigmaLogCounty", DEFAULT_SIGMA_COUNTY)),
        sigma_log_event=float(payload.get("sigmaLogEvent", DEFAULT_SIGMA_EVENT)),
        created_at=payload.get("createdAt"),
        fit=payload.get("fit") or {},
    )


def curves_dir() -> Path:
    return data_dir() / CURVES_DIR


@lru_cache(maxsize=1)
def load_curve_sets() -> dict[str, CurveSet]:
    out = {v: _vendor_set(v) for v in ("kcc", "air", "rms")}
    folder = curves_dir()
    if folder.is_dir():
        for path in sorted(folder.glob("*.json")):
            curve = curve_set_from_json(json.loads(path.read_text(encoding="utf-8")))
            # Segments the calibration had no data for keep the KCC shape.
            for seg in LOSS_SEGMENTS:
                curve.segments.setdefault(seg, list(out["kcc"].segments[seg]))
            out[curve.id] = curve
    return out


def default_curve_set_id() -> str:
    """Newest calibrated set, else KCC."""
    calibrated = [c for c in load_curve_sets().values() if c.kind == "calibrated"]
    if not calibrated:
        return "kcc"
    return max(calibrated, key=lambda c: (c.created_at or "", c.id)).id


def get_curve_set(curve_set_id: str | None) -> CurveSet:
    sets = load_curve_sets()
    key = curve_set_id or default_curve_set_id()
    if key not in sets:
        raise KeyError(key)
    return sets[key]
