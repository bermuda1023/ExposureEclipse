"""Tests for `/api/exposures/map`, `/detail`, and `/pivot`."""

from __future__ import annotations

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
