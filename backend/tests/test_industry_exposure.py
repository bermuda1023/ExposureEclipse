"""Industry cedant: residential and commercial are informational; calcs bundle them.

The book is a selectable WS reference cedant. It is not part of the silent
in-force portfolio. Map TIV, detail summary, and hurricane-impact TIV are the
sum of both segments. The segment amounts stay on the wire for display.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.models.enums import AggregationLevel, OccupancySegment, Peril
from app.models.exposure import ExposureFactNormalized
from app.providers.mock import MockExposureDataProvider
from app.services.hurricane_impact import CountyImpact, join_tiv


client = TestClient(app)

MIAMI = "US-FL-12086"
GLADES = "US-FL-12043"


@pytest.fixture(scope="module")
def provider() -> MockExposureDataProvider:
    return MockExposureDataProvider(get_settings().mock_data_dir)


def _value(raw: object) -> str:
    return raw.value if hasattr(raw, "value") else str(raw)


def _fact(
    *,
    geography_id: str,
    aggregation: AggregationLevel,
    segment: OccupancySegment,
    tiv: float,
) -> ExposureFactNormalized:
    return ExposureFactNormalized(
        dataset_id="ds-industry-ws",
        portname="01012026",
        source_server_name="REFERENCE",
        source_database_name="Industry_US_Property_WS",
        source_table_name="industry_exposure_estimate",
        aggregation=aggregation,
        geography_level=aggregation,
        geography_id=geography_id,
        peril=Peril.WS,
        occupancy="All",
        occupancy_group="All",
        occupancy_segment=segment,
        building=tiv * 0.6,
        contents=tiv * 0.3,
        bi=tiv * 0.1,
        tiv=tiv,
        currency="USD",
    )


def _bare_impact(geography_id: str = MIAMI) -> CountyImpact:
    return CountyImpact(
        geoid=geography_id.rsplit("-", 1)[-1],
        geography_id=geography_id,
        name="Miami-Dade",
        state_usps="FL",
        centroid_lat=25.6,
        centroid_lon=-80.4,
        max_wind_kt=110,
        max_category=3,
        closest_distance_nm=12.0,
        rmax_at_closest_nm=18.0,
        rmax_source="nhc",
        tiv=0.0,
        location_count=0,
        has_data=False,
    )


def test_industry_cedent_is_selectable_and_excluded_from_portfolio(
    provider: MockExposureDataProvider,
) -> None:
    cedents = provider.list_cedents()
    assert "ced-industry" in {c.cedent_id for c in cedents}
    industry = provider.get_cedent("ced-industry")
    assert industry is not None
    assert industry.cedent_name == "Industry"
    assert industry.region == "Reference"
    assert len(industry.chains) == 1
    chain = industry.chains[0]
    assert chain.office == "REF"
    assert chain.chain_id == "chain-industry-us-ws"
    assert len(chain.programmes) == 1
    programme = chain.programmes[0]
    assert programme.dataset_id == "ds-industry-ws"
    assert programme.include_in_portfolio is False
    assert programme.signed_share == 1.0
    assert [_value(p) for p in programme.perils] == ["WS"]
    assert programme.is_in_force(datetime(2026, 10, 8, tzinfo=timezone.utc))

    for other in cedents:
        if other.cedent_id == "ced-industry":
            continue
        assert other.region != "Reference"
        for other_chain in other.chains:
            assert other_chain.office != "REF"

    assert "ds-industry-ws" not in provider.portfolio_dataset_ids(in_force_only=True)
    loaded = {fact.dataset_id for fact in provider.get_portfolio_facts()}
    assert "ds-industry-ws" not in loaded

    datasets_path = Path(get_settings().mock_data_dir) / "datasets.json"
    datasets = json.loads(datasets_path.read_text(encoding="utf-8"))
    assert all(row.get("datasetId") != "ds-industry-ws" for row in datasets)


def test_industry_facts_identity_and_exact_rollups(
    provider: MockExposureDataProvider,
) -> None:
    facts = provider.get_facts_for_dataset("ds-industry-ws")
    assert facts
    summary = json.loads(
        (Path(get_settings().mock_data_dir) / "industry_exposure_summary.json").read_text(
            encoding="utf-8"
        )
    )

    county = [f for f in facts if _value(f.aggregation) == AggregationLevel.COUNTY.value]
    state = [f for f in facts if _value(f.aggregation) == AggregationLevel.STATE.value]
    country = [f for f in facts if _value(f.aggregation) == AggregationLevel.COUNTRY.value]

    by_county: dict[str, set[str]] = {}
    res_total = 0.0
    com_total = 0.0
    for fact in facts:
        assert _value(fact.peril) == Peril.WS.value
        assert fact.occupancy == "All"
        assert fact.occupancy_group == "All"
        assert round(fact.tiv, 2) == round(fact.building + fact.contents + fact.bi, 2)
        assert round(fact.explim_gross, 2) == round(fact.tiv, 2)
        assert round(fact.explim_net, 2) == round(fact.tiv, 2)
        segment = _value(fact.occupancy_segment)
        assert segment in {OccupancySegment.RESIDENTIAL.value, OccupancySegment.COMMERCIAL.value}

    for fact in county:
        by_county.setdefault(fact.geography_id, set()).add(_value(fact.occupancy_segment))
        if _value(fact.occupancy_segment) == OccupancySegment.RESIDENTIAL.value:
            res_total += fact.tiv
        else:
            com_total += fact.tiv

    assert len(by_county) == summary["counties"]
    assert all(
        segments == {OccupancySegment.RESIDENTIAL.value, OccupancySegment.COMMERCIAL.value}
        for segments in by_county.values()
    )
    assert round(res_total, 2) == summary["residentialTiv"]
    assert round(com_total, 2) == summary["commercialTiv"]
    assert round(res_total + com_total, 2) == summary["totalTiv"]
    assert 15e12 <= res_total <= 55e12
    assert 8e12 <= com_total <= 45e12

    county_by_state: dict[str, float] = {}
    for fact in county:
        assert fact.statecode
        county_by_state[fact.statecode] = county_by_state.get(fact.statecode, 0.0) + fact.tiv
    state_by: dict[str, float] = {}
    for fact in state:
        assert fact.statecode
        state_by[fact.statecode] = state_by.get(fact.statecode, 0.0) + fact.tiv
    assert set(state_by) == set(county_by_state)
    for code, tiv in state_by.items():
        assert round(tiv, 2) == round(county_by_state[code], 2), code
    assert {"FL", "CA", "NY", "PR", "AK", "HI"}.issubset(state_by)
    assert round(sum(fact.tiv for fact in country), 2) == round(sum(fact.tiv for fact in county), 2)
    assert len(country) == 2


def test_industry_map_and_detail_bundle_both_segments() -> None:
    mapped = client.post(
        "/api/exposures/map",
        json={
            "cedentId": "ced-industry",
            "aggregationLevel": AggregationLevel.COUNTY.value,
            "metric": "TIV",
        },
    )
    assert mapped.status_code == 200, mapped.text
    features = {row["geographyId"]: row for row in mapped.json()["features"]}
    miami = features[MIAMI]
    glades = features[GLADES]
    assert miami["metricValue"] == miami["tiv"]
    assert miami["tiv"] > glades["tiv"] * 20

    detail = client.post(
        "/api/exposures/detail",
        json={
            "cedentId": "ced-industry",
            "aggregationLevel": AggregationLevel.COUNTY.value,
            "metric": "TIV",
            "geographyId": MIAMI,
        },
    )
    assert detail.status_code == 200, detail.text
    body = detail.json()
    occupancy = {row["key"]: row["tiv"] for row in body["breakdowns"]["occupancy"]}
    assert set(occupancy) == {"RESIDENTIAL", "COMMERCIAL"}
    assert occupancy["RESIDENTIAL"] > 0
    assert occupancy["COMMERCIAL"] > 0
    bundled = occupancy["RESIDENTIAL"] + occupancy["COMMERCIAL"]
    assert round(body["summary"]["tiv"], 2) == round(bundled, 2)
    assert round(miami["tiv"], 2) == round(bundled, 2)

    glades_detail = client.post(
        "/api/exposures/detail",
        json={
            "cedentId": "ced-industry",
            "aggregationLevel": AggregationLevel.COUNTY.value,
            "metric": "TIV",
            "geographyId": GLADES,
        },
    )
    assert glades_detail.status_code == 200, glades_detail.text
    glades_occ = {
        row["key"]: row["tiv"] for row in glades_detail.json()["breakdowns"]["occupancy"]
    }
    assert occupancy["RESIDENTIAL"] > glades_occ["RESIDENTIAL"] * 20

    portfolio = client.post(
        "/api/exposures/map",
        json={
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": "TIV",
        },
    )
    assert portfolio.status_code == 200, portfolio.text
    industry_state = client.post(
        "/api/exposures/map",
        json={
            "cedentId": "ced-industry",
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": "TIV",
        },
    )
    assert industry_state.status_code == 200, industry_state.text
    portfolio_fl = next(
        (row for row in portfolio.json()["features"] if row["geographyId"] == "US-FL"),
        None,
    )
    industry_fl = next(row for row in industry_state.json()["features"] if row["geographyId"] == "US-FL")
    portfolio_fl_tiv = 0.0 if portfolio_fl is None else portfolio_fl["tiv"]
    assert industry_fl["tiv"] > portfolio_fl_tiv * 10


def test_join_tiv_bundles_segments_and_ignores_state_rows() -> None:
    """Impact TIV is one number. Residential and commercial stay informational."""
    residential = 100.0
    commercial = 250.0
    facts = [
        _fact(
            geography_id=MIAMI,
            aggregation=AggregationLevel.COUNTY,
            segment=OccupancySegment.RESIDENTIAL,
            tiv=residential,
        ),
        _fact(
            geography_id=MIAMI,
            aggregation=AggregationLevel.COUNTY,
            segment=OccupancySegment.COMMERCIAL,
            tiv=commercial,
        ),
        _fact(
            geography_id="US-FL",
            aggregation=AggregationLevel.STATE,
            segment=OccupancySegment.RESIDENTIAL,
            tiv=9_999.0,
        ),
    ]
    impact = join_tiv([_bare_impact()], facts)[0]
    assert impact.has_data is True
    assert impact.tiv == residential + commercial
    assert impact.residential_tiv == residential
    assert impact.commercial_tiv == commercial
    # The server does not emit a second loss. Callers multiply this one tiv.
    assert impact.projected_loss == 0.0
    assert impact.location_count == 0
    assert len(impact.by_programme) == 1
    assert impact.by_programme[0].tiv == residential + commercial


def test_join_tiv_on_industry_county_matches_both_segments(
    provider: MockExposureDataProvider,
) -> None:
    facts = [
        fact
        for fact in provider.get_facts_for_dataset("ds-industry-ws")
        if fact.geography_id == MIAMI
    ]
    impact = join_tiv([_bare_impact()], facts)[0]
    assert impact.residential_tiv > 0
    assert impact.commercial_tiv > 0
    assert round(impact.tiv, 2) == round(impact.residential_tiv + impact.commercial_tiv, 2)
    assert impact.projected_loss == 0.0
