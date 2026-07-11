"""Fund-analysis hardening: input bounds, empty-window guard, feature flag.

Covers the operational fixes only — the module's financial methodology is
reviewed separately (see SYSTEM_DESIGN.md PR-04a).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_rolling_stats_window_after_history_is_422_not_500() -> None:
    resp = client.post(
        "/api/fund-analysis/rolling-stats",
        json={"assetId": "spy", "historyWindowStart": "2030-01"},
    )
    assert resp.status_code == 422
    body = resp.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"


def test_optimize_samples_capped() -> None:
    resp = client.post(
        "/api/fund-analysis/optimize",
        json={"assetIds": ["spy", "agg"], "samples": 100_000},
    )
    assert resp.status_code == 422  # over the 10k ceiling


def test_robustness_samples_per_scenario_capped() -> None:
    resp = client.post(
        "/api/fund-analysis/robustness",
        json={"assetIds": ["spy", "agg"], "samplesPerScenario": 30_000},
    )
    assert resp.status_code == 422  # over the 3k ceiling


@pytest.mark.parametrize("bad_rf", ["NaN", "Infinity", "5.0"])
def test_risk_free_rate_rejects_nan_inf_and_absurd_values(bad_rf: str) -> None:
    # NaN/Infinity are accepted by Python's json parser but must not reach
    # the math. Sent as a raw body — TestClient's json= kwarg refuses them.
    resp = client.post(
        "/api/fund-analysis/custom",
        content='{"weights": {"spy": 1.0}, "riskFreeRate": %s}' % bad_rf,
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422


def test_fee_drag_not_applied_to_net_of_fee_series() -> None:
    """Fixture series are already net of fees — the mgmt-fee haircut must not
    be subtracted a second time (fee double-count)."""
    from app.api.fund_analysis import _fee_drag_for, _load_catalog

    idx = {a["id"]: a for a in _load_catalog()["assets"]}
    # Gator advertises "2% mgmt / 20% perf" but its series is net: no drag.
    assert _fee_drag_for(idx, "gator", net_of_fees=True) == 0.0
    # A gross-tagged asset (none in the fixture today) still gets the drag.
    idx["gross-demo"] = {"id": "gross-demo", "fees": "2% mgmt", "returnsGrossOfFees": True}
    assert _fee_drag_for(idx, "gross-demo", net_of_fees=True) == pytest.approx(0.02)
    assert _fee_drag_for(idx, "gross-demo", net_of_fees=False) == 0.0


def test_custom_portfolio_expected_return_matches_series_mu() -> None:
    """End-to-end: single-asset portfolio μ == mean(monthly)*12 straight from
    the fixture, with no fee haircut despite netOfFees=true (the default)."""
    from app.api.fund_analysis import _load_catalog

    gator = next(a for a in _load_catalog()["assets"] if a["id"] == "gator")
    rets = [r["ret"] for r in gator["returns"]]
    mu = sum(rets) / len(rets) * 12.0

    resp = client.post(
        "/api/fund-analysis/custom",
        json={"weights": {"gator": 1.0}, "netOfFees": True},
    )
    assert resp.status_code == 200, resp.text
    # Response rounds to 6 decimals; the double-count would be off by 0.02.
    assert resp.json()["portfolio"]["expectedReturn"] == pytest.approx(mu, abs=1e-6)


def test_fund_analysis_flag_disables_router(monkeypatch: pytest.MonkeyPatch) -> None:
    """FUND_ANALYSIS_ENABLED=false removes the whole surface (PR-04a)."""
    from app.config import get_settings

    monkeypatch.setenv("FUND_ANALYSIS_ENABLED", "false")
    get_settings.cache_clear()
    try:
        # Router inclusion happens at import time, so rebuild the app.
        import importlib

        from app import main as main_module

        flagged_app = importlib.reload(main_module).app
        flagged_client = TestClient(flagged_app)
        assert flagged_client.get("/api/fund-analysis/assets").status_code == 404
    finally:
        monkeypatch.delenv("FUND_ANALYSIS_ENABLED", raising=False)
        get_settings.cache_clear()
        import importlib

        from app import main as main_module

        importlib.reload(main_module)
