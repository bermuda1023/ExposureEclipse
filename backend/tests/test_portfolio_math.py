"""Fund-analysis portfolio math — regressions for personal-optimizer fixes."""

from __future__ import annotations

from app.services.portfolio_math import (
    AssumptionOverride,
    ReturnSeries,
    compute_asset_stats,
    compute_frontier,
    correlation_matrix,
    enforce_min_investments,
    pairwise_correlation,
    parse_mgmt_fee_drag,
    portfolio_expected_return,
    portfolio_monthly_series,
)


def _series(aid: str, months: dict[str, float]) -> ReturnSeries:
    return ReturnSeries(asset_id=aid, returns=months)


def test_arithmetic_expected_return_not_cagr() -> None:
    # High vol series: CAGR < arithmetic annual mean (vol drag)
    rets = {f"2020-{i:02d}": (0.20 if i % 2 == 0 else -0.15) for i in range(1, 13)}
    rets.update({f"2021-{i:02d}": (0.20 if i % 2 == 0 else -0.15) for i in range(1, 13)})
    s = compute_asset_stats(_series("x", rets))
    assert s.expected_return == s.monthly_mean * 12
    assert s.expected_return > s.annualised_return  # vol drag


def test_correlation_never_zero_on_tiny_overlap() -> None:
    a = _series("a", {"2020-01": 0.01, "2020-02": -0.01})
    b = _series("b", {"2020-01": 0.02, "2020-02": 0.00})
    r, n = pairwise_correlation(a, b)
    assert n < 3
    assert abs(r - 0.55) < 1e-9  # conservative FoF prior, not 0


def test_correlation_shrinks_toward_prior() -> None:
    # Build moderate overlap with mild empirical corr
    months = {f"2020-{i:02d}": 0.01 * ((-1) ** i) for i in range(1, 13)}
    months2 = {f"2020-{i:02d}": 0.01 * ((-1) ** (i + 1)) for i in range(1, 13)}  # inverse
    r, n = pairwise_correlation(_series("a", months), _series("b", months2), full_n=36)
    assert n == 12
    # Empirical ~ -1, shrunk: w=12/36=0.33 → r ≈ 0.33*(-1)+0.67*0.55
    assert r > -0.9
    assert abs(r - (12 / 36 * -1 + 24 / 36 * 0.55)) < 0.05


def test_fee_parse() -> None:
    assert abs(parse_mgmt_fee_drag("2% mgmt / 20% perf") - 0.02) < 1e-9
    assert abs(parse_mgmt_fee_drag("0.09% expense ratio") - 0.0009) < 1e-9


def test_enforce_min_investment_drops_subticket() -> None:
    w = {"a": 0.1, "b": 0.9}
    out, dropped = enforce_min_investments(w, total_capital=1_000_000, min_investment={"a": 250_000, "b": 0})
    assert "a" in dropped
    assert out["a"] == 0.0
    assert abs(out["b"] - 1.0) < 1e-9


def test_new_cash_mode_respects_fixed_floor() -> None:
    # Two assets, equal stats, free sleeve 50% with hard floor 50% on a
    months = {f"2018-{i:02d}": 0.01 for i in range(1, 13)}
    months.update({f"2019-{i:02d}": 0.005 for i in range(1, 13)})
    months.update({f"2020-{i:02d}": -0.01 for i in range(1, 13)})
    months.update({f"2021-{i:02d}": 0.02 for i in range(1, 13)})
    sa = _series("a", months)
    sb = _series("b", {m: r * 0.8 for m, r in months.items()})
    stats = {
        "a": compute_asset_stats(sa),
        "b": compute_asset_stats(sb),
    }
    rho, _ = correlation_matrix({"a": sa, "b": sb})
    _f, max_s, *_rest = compute_frontier(
        stats=stats,
        rho=rho,
        series_by_id={"a": sa, "b": sb},
        risk_free_rate=0.02,
        hard_min_weights={"a": 0.5},
        fixed_weights={"a": 0.5},
        free_weight=0.5,
        total_capital=1_000_000,
        min_investment_dollars={"a": 100_000, "b": 100_000},
        samples=2000,
        seed=1,
    )
    assert max_s.weights["a"] >= 0.5 - 1e-6


def test_portfolio_monthly_intersection() -> None:
    a = _series("a", {"2020-01": 0.01, "2020-02": 0.02, "2020-03": 0.0})
    b = _series("b", {"2020-02": 0.01, "2020-03": 0.01, "2020-04": 0.01})
    series = portfolio_monthly_series({"a": 0.5, "b": 0.5}, {"a": a, "b": b})
    months = [m for m, _ in series]
    assert months == ["2020-02", "2020-03"]


def test_short_track_mu_shrinks_toward_prior() -> None:
    from app.services.portfolio_math import shrink_expected_return, MU_PRIOR

    assert abs(shrink_expected_return(0.40, 0) - MU_PRIOR) < 1e-9
    # 18 months → 18/60 = 0.3 weight on empirical
    got = shrink_expected_return(0.40, 18)
    assert abs(got - (0.3 * 0.40 + 0.7 * MU_PRIOR)) < 1e-9
    # 60+ months → empirical
    assert abs(shrink_expected_return(0.40, 60) - 0.40) < 1e-9


def test_illiquid_lockup_parser() -> None:
    from app.services.portfolio_math import is_illiquid_lockup

    assert is_illiquid_lockup("None") is False
    assert is_illiquid_lockup("Daily liquidity") is False
    assert is_illiquid_lockup("12mo / 25% fund-level gate") is True
    assert is_illiquid_lockup("1yr") is True


def test_max_names_caps_holdings() -> None:
    months = {f"2020-{i:02d}": 0.01 for i in range(1, 13)}
    months.update({f"2021-{i:02d}": 0.008 for i in range(1, 13)})
    ids = ["a", "b", "c", "d"]
    series = {i: _series(i, {m: r + 0.001 * n for m, r in months.items()}) for n, i in enumerate(ids)}
    stats = {i: compute_asset_stats(series[i]) for i in ids}
    rho, _ = correlation_matrix(series)
    _f, max_s, *_ = compute_frontier(
        stats=stats,
        rho=rho,
        series_by_id=series,
        samples=1500,
        seed=2,
        max_names=2,
        min_investment_dollars={i: 0.0 for i in ids},
        total_capital=1_000_000,
    )
    held = [i for i, w in max_s.weights.items() if w > 1e-6]
    assert len(held) <= 2
