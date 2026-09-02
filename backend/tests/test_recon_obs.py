"""HDOB / VDM parsers — fixture-only, no network."""

from __future__ import annotations

from datetime import datetime, timezone

from app.services.recon_obs import (
    FL_TO_SURFACE,
    parse_hdob_text,
    parse_vdm_text,
    recon_for_idw,
)


# Live Edouard bulletin: SFMR is /// (over-land / flagged). QC 03/05.
EDOUARD_HDOB = """
URNT15 KNHC 011345
AF303 0305A EDOUARD            HDOB 22 20260901
133530 2854N 09152W 6224 04169 0133 +047 +010 180019 020 /// /// 03
133600 2855N 09150W 6225 04169 0137 +045 +027 183021 021 /// /// 03
133700 2858N 09144W 6225 04166 0161 +027 //// 196023 023 /// /// 05
134500 2914N 09102W 6228 04177 0156 +043 +002 156015 016 /// /// 03
$$
"""

# Classic NHOP sample — SFMR present (KKK=080), FL 83 kt.
KATRINA_HDOB = """
URNT15 KNHC 281426
AF302 1712A KATRINA            HDOB 41 20050928
142230 2612N 08752W 7010 03057 9282 +102 +102 141153 166 148 999 00
142300 2612N 08751W 7042 03010 9293 +088 +083 133159 164 147 999 00
$$
"""

# Position-questionable QC (first flag 1) must be dropped.
BAD_POS_HDOB = """
URNT15 KNHC 281426
AF302 1712A KATRINA            HDOB 41 20050928
142230 2612N 08752W 7010 03057 9282 +102 +102 141153 166 148 999 10
$$
"""

EDOUARD_VDM = """
URNT12 KNHC 011338
VORTEX DATA MESSAGE   AL052026
A. 01/13:04:20Z
B. 29.23 deg N 093.19 deg W
C. 850 mb 1449 m
D. 1000 mb
E. 205 deg 1 kt
F. Open N
G. C25
H. NA
I. NA
J. 183 deg 41 kt
K. 085 deg 23 nm 12:57:00Z
L. NA
M. NA
N. 299 deg 51 kt
O. 206 deg 3 nm 13:05:30Z
P. 16 C / 1519 m
Q. 20 C / 1533 m
R. 19 C / NA
S. 12345 / 08
T. 0.02 / 0.5 nm
U. AF303 0305A EDOUARD    OB 16
MAX FL WIND 51 KT 206 / 3 NM 12:57:00Z
$$
"""


def test_hdob_sfmr_preferred_when_qc_ok() -> None:
    fixes = parse_hdob_text(KATRINA_HDOB)
    assert len(fixes) == 2
    a = fixes[0]
    assert a.storm_name == "KATRINA"
    assert a.aircraft == "AF302"
    assert a.surface_source == "sfmr"
    assert a.sfmr_kt == 148
    assert a.fl_wind_kt == 153
    assert a.fl_dir_deg == 141
    assert abs(a.lat - (26 + 12 / 60)) < 1e-3
    assert abs(a.lon - -(87 + 52 / 60)) < 1e-3


def test_hdob_falls_back_to_flight_level_when_sfmr_missing() -> None:
    fixes = parse_hdob_text(EDOUARD_HDOB)
    assert len(fixes) == 4
    a = fixes[0]
    assert a.storm_name == "EDOUARD"
    assert a.sfmr_kt is None
    assert a.surface_source == "fl80"
    assert a.fl_wind_kt == 19
    assert a.surface_kt == round(19 * FL_TO_SURFACE, 1)
    # QC 05 = T/TD + SFMR questionable — still keep FL (flag 5 is not a FL-wind flag).
    flagged = [f for f in fixes if f.observed_at.endswith("13:37:00Z")]
    assert flagged and flagged[0].surface_source == "fl80"


def test_hdob_drops_questionable_position() -> None:
    assert parse_hdob_text(BAD_POS_HDOB) == []


def test_vdm_modern_usaf() -> None:
    fx = parse_vdm_text(EDOUARD_VDM, year=2026)
    assert fx is not None
    assert fx.storm_id == "AL052026"
    assert fx.storm_name == "EDOUARD"
    assert fx.aircraft == "AF303"
    assert abs(fx.lat - 29.23) < 1e-6
    assert abs(fx.lon - (-93.19)) < 1e-6
    assert fx.pressure_mb == 1000
    assert fx.max_fl_wind_kt == 51
    assert fx.observed_at.startswith("2026-09-01T13:04:20Z") or fx.observed_at.startswith("2026-")


def test_idw_thin_keeps_track_but_drops_30s_duplicates() -> None:
    # Fabricate a tight 30-second transect (~0.02° steps) and confirm the
    # IDW subset is sparser than the map overlay set.
    from app.services.recon_obs import ReconFix

    dense = [
        ReconFix(
            lat=29.0 + i * 0.02,
            lon=-91.0 - i * 0.02,
            observed_at=f"2026-09-01T13:{i:02d}:00Z",
            surface_kt=40,
            surface_source="sfmr",
            fl_wind_kt=50,
            fl_dir_deg=180,
            sfmr_kt=40,
            rain_mm_hr=0,
            aircraft="AF303",
            storm_name="EDOUARD",
            mission_id="0305A",
        )
        for i in range(20)
    ]
    thinned = recon_for_idw(dense)
    assert 2 <= len(thinned) < len(dense)


def test_html_wrapped_bulletin_still_parses() -> None:
    html = (
        "<html><body><pre>"
        + KATRINA_HDOB
        + "</pre></body></html>"
    )
    fixes = parse_hdob_text(html)
    assert len(fixes) == 2
