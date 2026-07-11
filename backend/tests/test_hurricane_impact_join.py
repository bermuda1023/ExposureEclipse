"""join_tiv — hurricane-impact TIV must combine under max-across-perils.

Same bug class as the map/detail/pivot double-count: a multi-peril
programme's WS/EQ/CS county rows must never stack in the impact panel
(CLAUDE.md rule 3). Uses real fixture facts so the numbers stay pinned to
the mock data plane; no NOAA network access.
"""

from __future__ import annotations

import pytest

from app.config import get_settings
from app.providers.mock import MockExposureDataProvider
from app.services.hurricane_impact import CountyImpact, join_tiv


@pytest.fixture(scope="module")
def county_facts():
    provider = MockExposureDataProvider(get_settings().mock_data_dir)
    facts = provider.get_facts_for_dataset("ds-farmers-bda-2027")
    county = [f for f in facts if f.aggregation == "COUNTY"]
    assert county, "fixture drift: ds-farmers-bda-2027 has no COUNTY rows"
    return county


def _impact_for(geography_id: str) -> CountyImpact:
    return CountyImpact(
        geoid=geography_id.rsplit("-", 1)[-1],
        geography_id=geography_id,
        name="Test County",
        state_usps="FL",
        centroid_lat=25.5,
        centroid_lon=-80.5,
        max_wind_kt=100,
        max_category=3,
        closest_distance_nm=10.0,
        rmax_at_closest_nm=20.0,
        rmax_source="willoughby",
        tiv=0.0,
        location_count=0,
        has_data=False,
    )


def test_join_tiv_takes_max_across_perils_not_sum(county_facts) -> None:
    # Pick a county that carries more than one peril in the fixture.
    by_geo_peril: dict[str, dict[str, float]] = {}
    for f in county_facts:
        by_geo_peril.setdefault(f.geography_id, {}).setdefault(str(f.peril), 0.0)
        by_geo_peril[f.geography_id][str(f.peril)] += float(f.tiv or 0.0)
    gid, per_peril = next(
        (g, pp) for g, pp in by_geo_peril.items() if len(pp) > 1
    )
    expected_max = max(per_peril.values())
    plain_sum = sum(per_peril.values())
    assert plain_sum > expected_max  # the trap must be real for this fixture

    [joined] = join_tiv([_impact_for(gid)], county_facts)
    assert joined.has_data
    assert joined.tiv == pytest.approx(expected_max)
    assert joined.tiv < plain_sum


def test_join_tiv_by_programme_breakdown_uses_max_per_dataset(county_facts) -> None:
    by_geo_peril: dict[str, dict[str, float]] = {}
    for f in county_facts:
        by_geo_peril.setdefault(f.geography_id, {}).setdefault(str(f.peril), 0.0)
        by_geo_peril[f.geography_id][str(f.peril)] += float(f.tiv or 0.0)
    gid, per_peril = next(
        (g, pp) for g, pp in by_geo_peril.items() if len(pp) > 1
    )

    [joined] = join_tiv([_impact_for(gid)], county_facts)
    # Single-dataset fixture: the programme slice must equal the county total
    # (max across perils), not the peril sum.
    assert len(joined.by_programme) == 1
    contrib = joined.by_programme[0]
    assert contrib.dataset_id == "ds-farmers-bda-2027"
    assert contrib.tiv == pytest.approx(max(per_peril.values()))


def test_join_tiv_single_peril_unchanged(county_facts) -> None:
    # For a single-peril county (or peril-filtered facts) max == sum: the fix
    # must not change single-peril behavior.
    ws_only = [f for f in county_facts if str(f.peril) == "WS"]
    gid = ws_only[0].geography_id
    expected = sum(
        float(f.tiv or 0.0) for f in ws_only if f.geography_id == gid
    )
    [joined] = join_tiv([_impact_for(gid)], ws_only)
    assert joined.tiv == pytest.approx(expected)
