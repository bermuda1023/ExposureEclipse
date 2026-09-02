"""Live-storm county impact uses NHC official track + wind radii, not HURDAT."""

from __future__ import annotations

from app.services.hurricane_impact import CountyMeta, compute_impact
from app.services.ibtracs import Storm, TrackPoint
from app.services.live_hurricane import storm_for_impact
from app.services.atcf_adecks import OfficialFix


def test_compute_impact_uses_nhc_quadrants(monkeypatch) -> None:
    import app.services.hurricane_impact as hi

    # County ~20 nm due NE of 25N, 80W — inside 40 nm NE R64, outside 5 nm SW.
    county = CountyMeta(
        geoid="12086",
        geography_id="US-FL-12086",
        name="Miami-Dade",
        state_usps="FL",
        centroid_lat=25.25,
        centroid_lon=-79.75,
    )
    monkeypatch.setattr(hi, "county_centroids", lambda: {"12086": county})

    storm = Storm(
        storm_id="AL012026",
        name="TEST",
        year=2026,
        track=[
            TrackPoint(
                datetime_utc="2026-09-01T12:00:00Z",
                record_id="",
                status="TS",  # would be skipped under the old HU-only IBTrACS filter
                lat=25.0,
                lon=-80.0,
                wind_kt=90,
                pressure_mb=960,
                rmax_nm=18.0,
                r64_quads_nm=(40.0, 10.0, 5.0, 10.0),
                radii_source="nhc",
            )
        ],
    )
    impacts, footprint, _inner, _outer, _rings = compute_impact(storm)
    assert footprint
    assert footprint[0].rmax_source == "nhc"
    assert footprint[0].r64_source == "nhc"
    assert any(i.geoid == "12086" for i in impacts)


def test_storm_for_impact_prefers_official_adecks(monkeypatch) -> None:
    import app.services.live_hurricane as lh
    import app.services.atcf_adecks as ad

    monkeypatch.setattr(
        lh,
        "_get_live_entry",
        lambda atcf: {"id": atcf, "name": "Gabrielle", "forecastTrack": {}},
    )
    monkeypatch.setattr(lh, "fetch_forecast_track", lambda url: [])
    monkeypatch.setattr(
        lh,
        "fetch_official_fixes",
        lambda atcf: [
            OfficialFix(
                hours_out=0,
                lat=24.5,
                lon=-83.0,
                wind_kt=100,
                pressure_mb=950,
                ty="HU",
                rmw_nm=16.0,
                r34_quads=(120, 100, 80, 90),
                r50_quads=(70, 60, 50, 55),
                r64_quads=(40, 30, 25, 35),
                init_cycle="2026090112",
            ),
            OfficialFix(
                hours_out=24,
                lat=26.0,
                lon=-82.0,
                wind_kt=90,
                pressure_mb=960,
                ty="HU",
                rmw_nm=18.0,
                r34_quads=None,
                r50_quads=None,
                r64_quads=(45, 35, 20, 30),
                init_cycle="2026090112",
            ),
        ],
    )
    storm = storm_for_impact("AL072026")
    assert storm is not None
    assert storm.name == "Gabrielle"
    assert [p.radii_source for p in storm.track] == ["nhc", "nhc"]
    assert storm.track[0].rmax_nm == 16.0
    assert storm.track[0].r64_quads_nm == (40.0, 30.0, 25.0, 35.0)
    assert storm.track[1].lat == 26.0
    # Must not require IBTrACS — a 2026 live id would 404 there.
    assert storm.storm_id == "AL072026"
