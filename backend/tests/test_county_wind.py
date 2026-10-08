"""Local-wind slices. A grazed county is not stamped with the storm peak."""

from __future__ import annotations

from app.services.county_wind import (
    bands_from_winds,
    experienced_wind_kt,
    include_county,
    local_wind_kt,
)
from app.services.hurricane_impact import (
    CountyMeta,
    _impacts_from_paint,
    _paint_fix,
    compute_impact,
)
from app.services.ibtracs import Storm, TrackPoint


def test_profile_pins_eyewall_and_r64_and_drops_the_far_field() -> None:
    # Instantaneous: calm eye, Vmax at the wall, ~64 kt at R64, nothing past the skirt.
    assert local_wind_kt(0.0, 110, 15.0, 40.0) == 0
    assert local_wind_kt(15.0, 110, 15.0, 40.0) == 110
    at_r64 = local_wind_kt(40.0, 110, 15.0, 40.0)
    assert 60 <= at_r64 <= 68
    assert local_wind_kt(250.0, 110, 15.0, 40.0) == 0
    # A quadrant with no hurricane-force radius never reports hurricane wind.
    assert local_wind_kt(20.0, 110, 15.0, 0.0) <= 63


def test_experienced_wind_is_vmax_once_the_eyewall_has_crossed() -> None:
    # The eye is calm at that instant. The point still felt the wall.
    assert experienced_wind_kt(0.0, 110, 15.0, 40.0) == 110
    assert experienced_wind_kt(15.0, 110, 15.0, 40.0) == 110
    # Outside the wall the peak is the profile, not Vmax.
    assert experienced_wind_kt(60.0, 110, 15.0, 40.0) < 64


def test_graze_splits_the_county_instead_of_using_the_storm_peak() -> None:
    """Miami-Dade shape from the screenshot: eye ~60 nm away, Rmax 15, 109 kt.

    One near-edge sample sits in the outer field. The rest of the county is
    farther out. The chip must not read 109, and most of the area is not the
    storm's category.
    """
    # 1 deg lat = 60 nm. Eye due west of the county.
    eye_lat, eye_lon = 25.6, -81.6
    # Centroid ~62 nm east. Near edge ~38 nm east (outer field). Far side ~95 nm.
    near = (eye_lat, eye_lon + 38.0 / 54.4)
    mid = (eye_lat, eye_lon + 62.0 / 54.4)
    far = (eye_lat, eye_lon + 95.0 / 54.4)
    samples = [near] + [mid] * 4 + [far] * 5  # 10% near, 40% mid, 50% far

    county = CountyMeta(
        geoid="12086",
        geography_id="US-FL-12086",
        name="Miami-Dade",
        state_usps="FL",
        centroid_lat=mid[0],
        centroid_lon=mid[1],
    )
    painted: dict = {}
    _paint_fix(
        painted,
        {"12086": county},
        {"12086": samples},
        eye_lat=eye_lat,
        eye_lon=eye_lon,
        vmax_kt=109,
        rmax=15.0,
        rmax_source="ibtracs",
        r64_nm=40.0,
        r64_quads=(40.0, 40.0, 40.0, 40.0),
    )
    impacts = _impacts_from_paint(painted)
    assert len(impacts) == 1
    hit = impacts[0]
    assert hit.max_wind_kt < 96  # not the 109 kt storm peak, and not Cat 3
    assert hit.max_wind_kt < 109
    by_cat = {b.category: b.area_fraction for b in hit.wind_bands}
    # The outer bit is TS or Cat 1. The rest is not the core.
    core = sum(by_cat.get(c, 0.0) for c in (3, 4, 5))
    assert core == 0.0
    assert by_cat.get(-1, 0.0) + by_cat.get(0, 0.0) >= 0.5
    assert include_county(hit.wind_bands, hit.max_wind_kt)


def test_compute_impact_keeps_a_centroid_fallback(monkeypatch) -> None:
    """Tests that stub centroids and forget samples still score that one point."""
    import app.services.hurricane_impact as hi

    county = CountyMeta(
        geoid="12086",
        geography_id="US-FL-12086",
        name="Miami-Dade",
        state_usps="FL",
        centroid_lat=25.25,
        centroid_lon=-79.75,
    )
    monkeypatch.setattr(hi, "county_centroids", lambda: {"12086": county})
    monkeypatch.setattr(hi, "county_area_samples", lambda: {})
    storm = Storm(
        storm_id="AL992026",
        name="GRAZE",
        year=2026,
        track=[
            TrackPoint(
                datetime_utc="2026-10-09T18:00:00Z",
                record_id="",
                status="HU",
                lat=25.0,
                lon=-81.2,
                wind_kt=130,
                pressure_mb=930,
                rmax_nm=15.0,
                r64_quads_nm=(40.0, 40.0, 40.0, 40.0),
                radii_source="nhc",
            )
        ],
    )
    impacts, footprint, *_rest = compute_impact(storm)
    assert footprint and footprint[0].rmax_source == "nhc"
    # Centroid is ~80 nm from the eye. Whole-county fallback, not 130 kt.
    assert impacts
    only = impacts[0]
    assert only.max_wind_kt < 64
    assert only.max_category <= 0
    bands = bands_from_winds([only.max_wind_kt])
    assert bands[0].category <= 0


def test_swath_between_fixes_catches_the_core(monkeypatch) -> None:
    """The eye passes over the county between two fixes. That is the core."""
    import app.services.hurricane_impact as hi

    # Fixes 40 nm north and south of the county. Midpoint is the centroid.
    county = CountyMeta(
        geoid="12071",
        geography_id="US-FL-12071",
        name="Lee",
        state_usps="FL",
        centroid_lat=26.5,
        centroid_lon=-82.0,
    )
    monkeypatch.setattr(hi, "county_centroids", lambda: {"12071": county})
    monkeypatch.setattr(hi, "county_area_samples", lambda: {})
    storm = Storm(
        storm_id="AL982026",
        name="SWATH",
        year=2026,
        track=[
            TrackPoint(
                datetime_utc="2026-10-09T12:00:00Z",
                record_id="",
                status="HU",
                lat=25.8,
                lon=-82.0,
                wind_kt=100,
                pressure_mb=950,
                rmax_nm=15.0,
                r64_quads_nm=(45.0, 45.0, 45.0, 45.0),
                radii_source="nhc",
            ),
            TrackPoint(
                datetime_utc="2026-10-09T18:00:00Z",
                record_id="L",
                status="HU",
                lat=27.2,
                lon=-82.0,
                wind_kt=100,
                pressure_mb=952,
                rmax_nm=15.0,
                r64_quads_nm=(45.0, 45.0, 45.0, 45.0),
                radii_source="nhc",
            ),
        ],
    )
    impacts, *_ = compute_impact(storm)
    assert impacts
    # ~42 nm to either vertex (outside Rmax 15). The filled track crosses the point.
    assert impacts[0].max_wind_kt == 100
