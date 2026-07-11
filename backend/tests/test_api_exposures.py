"""Tests for `/api/exposures/map`, `/detail`, and `/pivot`."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.enums import (
    AggregationLevel,
    Measure,
    MetricKey,
    WarningCode,
)


client = TestClient(app)


# ───────────────────────── /map ─────────────────────────


def test_map_state_returns_features_with_metric_value_mirror() -> None:
    resp = client.post(
        "/api/exposures/map",
        json={
            "datasetId": "ds-farmers-bda-2027",
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.TIV.value,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["aggregationLevel"] == AggregationLevel.STATE.value
    assert body["currency"] == "USD"
    assert len(body["features"]) > 0
    fl = next((f for f in body["features"] if f["geographyId"] == "US-FL"), None)
    assert fl is not None
    # metricValue mirrors the requested metric (here = TIV)
    assert fl["metricValue"] == fl["tiv"]
    assert fl["tiv"] > 0


def test_map_multi_peril_programme_uses_max_across_perils_not_sum() -> None:
    """CLAUDE.md rule 3 — never sum TIV across distinct perils.

    `ds-farmers-bda-2027` (programme `prog-farmers-bda-2027`) carries WS+EQ+CS
    rows of $19,920,890,039.30 EACH in US-FL. The map must show the
    max-across-perils value (~$19.92B), never the 3-peril sum (~$59.76B).
    """
    resp = client.post(
        "/api/exposures/map",
        json={
            "programmeId": "prog-farmers-bda-2027",
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.TIV.value,
        },
    )
    assert resp.status_code == 200, resp.text
    fl = next(f for f in resp.json()["features"] if f["geographyId"] == "US-FL")
    assert fl["tiv"] == pytest.approx(19_920_890_039.30, rel=1e-9)
    assert fl["metricValue"] == pytest.approx(19_920_890_039.30, rel=1e-9)


def test_map_portfolio_share_of_itself_is_one() -> None:
    """Numerator and denominator must combine perils the same way: the
    in-force portfolio viewed against itself gives share ≈ 1.0 everywhere."""
    resp = client.post(
        "/api/exposures/map",
        json={
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY.value,
        },
    )
    assert resp.status_code == 200, resp.text
    features = resp.json()["features"]
    assert len(features) > 0
    for f in features:
        assert f["dealShareOfPortfolioInGeography"] == pytest.approx(1.0), (
            f["geographyId"]
        )


def test_detail_portfolio_share_of_itself_is_one() -> None:
    resp = client.post(
        "/api/exposures/detail",
        json={
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.TIV.value,
            "geographyId": "US-FL",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["summary"]["dealShareOfPortfolioInGeography"] == pytest.approx(1.0)
    assert body["dealVsPortfolio"]["dealTiv"] == pytest.approx(
        body["dealVsPortfolio"]["portfolioTiv"]
    )


def test_map_county_with_ied_gap_emits_market_share_warning() -> None:
    """`US-FL-12086` is intentionally omitted from `mockdata/ied_industry.csv`."""
    resp = client.post(
        "/api/exposures/map",
        json={
            "datasetId": "ds-farmers-bda-2027",
            "aggregationLevel": AggregationLevel.COUNTY.value,
            "metric": MetricKey.CLIENT_MARKET_SHARE.value,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    gap = next((f for f in body["features"] if f["geographyId"] == "US-FL-12086"), None)
    assert gap is not None
    assert gap["clientMarketShare"] is None
    codes = {w["code"] for w in gap["warnings"]}
    assert WarningCode.WARN_IED_DENOMINATOR_MISSING.value in codes


def test_map_over_filtering_returns_no_rows_warning() -> None:
    resp = client.post(
        "/api/exposures/map",
        json={
            "datasetId": "ds-farmers-bda-2027",
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.TIV.value,
            "filters": {
                "peril": "ALL",
                "occupancy": ["NO_SUCH_OCCUPANCY"],
                "distanceToCoast": [],
                "geocoding": [],
                "construction": [],
                "numberOfStories": [],
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["features"] == []
    codes = {w["code"] for w in body["warnings"]}
    assert WarningCode.WARN_FILTERS_RETURN_NO_ROWS.value in codes


def test_map_without_comparison_emits_prior_not_selected_warning() -> None:
    resp = client.post(
        "/api/exposures/map",
        json={
            "datasetId": "ds-farmers-bda-2027",
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.TIV.value,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    codes = {w["code"] for w in body["warnings"]}
    assert WarningCode.WARN_PRIOR_DATASET_NOT_SELECTED.value in codes


def test_map_allows_zero_targets_returns_portfolio() -> None:
    """No selection target → portfolio mode (union of all in-force programmes)."""
    resp = client.post(
        "/api/exposures/map",
        json={
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.TIV.value,
        },
    )
    assert resp.status_code == 200
    assert len(resp.json()["features"]) > 0


def test_map_rejects_multiple_targets() -> None:
    """Two targets are still ambiguous and must 422."""
    resp = client.post(
        "/api/exposures/map",
        json={
            "datasetId": "ds-farmers-bda-2027",
            "cedentId": "ced-farmers",
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.TIV.value,
        },
    )
    assert resp.status_code == 422


# ───────────────────────── /detail ─────────────────────────


def test_detail_returns_summary_and_breakdowns() -> None:
    resp = client.post(
        "/api/exposures/detail",
        json={
            "datasetId": "ds-farmers-bda-2027",
            "aggregationLevel": AggregationLevel.STATE.value,
            "metric": MetricKey.TIV.value,
            "geographyId": "US-FL",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["geographyId"] == "US-FL"
    assert body["summary"]["tiv"] > 0
    assert body["summary"]["locationCount"] > 0
    assert body["dealVsPortfolio"]["portfolioTiv"] >= body["dealVsPortfolio"]["dealTiv"]
    assert "peril" in body["breakdowns"]


# ───────────────────────── /pivot ─────────────────────────


def test_pivot_returns_at_least_one_cell() -> None:
    resp = client.post(
        "/api/exposures/pivot",
        json={
            "datasetId": "ds-farmers-bda-2027",
            "rows": ["STATE"],
            "columns": ["PERIL"],
            "measures": [Measure.TIV.value, Measure.LOCATION_COUNT.value],
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["currency"] == "USD"
    assert len(body["cells"]) >= 1
    sample = body["cells"][0]
    assert "rowKey" in sample
    assert "colKey" in sample
    assert Measure.TIV.value in sample["values"]
