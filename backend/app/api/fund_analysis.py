"""Fund-analysis endpoints — the portfolio-optimization workbench.

Serves:
- GET  /api/fund-analysis/assets    → catalog of the 6 hedge funds + SPY + AGG
- POST /api/fund-analysis/optimize  → run MVO on the selected subset and
                                       return efficient frontier + max-Sharpe
                                       + min-variance portfolios, along with
                                       per-asset stats + correlation matrix.

The optimizer takes a `totalCapital`, per-asset `overrides` (assumed μ / σ /
correlation cap — the "priors" for short-track-record funds like Primary
Commodity), and a `respectMinInvestment` toggle. When `True`, each selected
asset's floor weight = `minInvestment / totalCapital` — a portfolio that
allocates less to a fund than its ticket-size minimum gets flagged as
infeasible.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import Field

from ..models.common import CamelModel
from ..services.portfolio_math import (
    AssumptionOverride,
    asset_information_ratio,
    compute_asset_stats,
    compute_frontier,
    correlation_matrix,
    cumulative_curve,
    drawdown_series,
    information_ratio_and_te,
    max_drawdown_from_monthly,
    portfolio_monthly_series,
    portfolio_return,
    portfolio_vol,
    series_from_asset_json,
    sortino_from_monthly,
    _apply_overrides,
)

router = APIRouter(prefix="/fund-analysis", tags=["fund-analysis"])


# ─────────────────────── wire types ───────────────────────


class AssetOut(CamelModel):
    id: str
    name: str
    kind: str                       # 'hedge_fund' | 'reference'
    strategy: str
    manager: str
    min_investment: int
    aum_millions: float | None = None
    fees: str
    lockup: str
    inception: str
    n_months: int
    annualised_return: float
    annualised_vol: float
    source: str
    warning: str | None = None


class AssetsResponse(CamelModel):
    as_of: str
    note: str
    assets: list[AssetOut]


class AssumptionOverrideIn(CamelModel):
    asset_id: str
    annualised_return: float | None = None
    annualised_vol: float | None = None
    correlation_cap: float | None = None


class MaxWeightIn(CamelModel):
    asset_id: str
    max_weight: float          # 0..1


class MinInvestmentOverrideIn(CamelModel):
    asset_id: str
    min_investment: float      # dollars; 0 = no minimum


class CurrentInvestmentIn(CamelModel):
    asset_id: str
    amount: float              # dollars currently held in this fund


class OptimizeRequest(CamelModel):
    asset_ids: list[str] = Field(..., description="Subset of catalog IDs")
    new_capital: float = Field(1_000_000, ge=0, description="New $ to deploy on top of current holdings")
    current_investments: list[CurrentInvestmentIn] = Field(default_factory=list)
    no_sell: bool = Field(False, description="If True, current holdings are minimum weights (can only add)")
    history_window_start: str | None = Field(None, description="YYYY-MM inclusive; None = full history")
    benchmark_asset_id: str = Field("spy", description="Asset ID used as IR benchmark")
    risk_free_rate: float = 0.04
    respect_min_investment: bool = True
    overrides: list[AssumptionOverrideIn] = Field(default_factory=list)
    max_weights: list[MaxWeightIn] = Field(default_factory=list)
    min_investment_overrides: list[MinInvestmentOverrideIn] = Field(default_factory=list)
    samples: int = Field(30_000, ge=1_000, le=100_000)


class PortfolioOut(CamelModel):
    weights: dict[str, float]
    annualised_return: float
    annualised_vol: float
    sharpe: float
    sortino: float = 0.0
    information_ratio: float = 0.0
    tracking_error: float = 0.0
    max_drawdown: float = 0.0
    violates_min_investment: list[str] = Field(default_factory=list)


class AssetStatOut(CamelModel):
    asset_id: str
    n_months: int
    annualised_return: float
    annualised_vol: float
    min_month: str
    max_month: str
    empirical_return: float          # pre-override empirical
    empirical_vol: float
    is_overridden: bool
    information_ratio: float = 0.0   # vs benchmark
    tracking_error: float = 0.0


class AssetSeriesOut(CamelModel):
    """Per-asset monthly returns + compounded equity + drawdown, aligned by
    month. Feeds the growth-of-$1 and drawdown charts."""
    asset_id: str
    months: list[str]
    returns: list[float]
    equity: list[float]
    drawdown: list[float]
    max_drawdown: float


class OptimizeResponse(CamelModel):
    stats: list[AssetStatOut]
    correlation: dict[str, dict[str, float]]
    overlap_months: dict[str, dict[str, int]]
    frontier: list[PortfolioPoint_wire]
    max_sharpe: PortfolioOut
    max_sortino: PortfolioOut
    max_information_ratio: PortfolioOut
    min_variance: PortfolioOut
    min_drawdown: PortfolioOut
    total_capital: float
    new_capital: float
    current_total: float
    current_investments: dict[str, float]
    risk_free_rate: float
    benchmark_asset_id: str
    benchmark_name: str
    asset_series: list[AssetSeriesOut]
    history_window_start: str | None
    effective_window_months: int


class PortfolioPoint_wire(CamelModel):
    weights: dict[str, float]
    annualised_return: float
    annualised_vol: float
    sharpe: float
    sortino: float = 0.0
    information_ratio: float = 0.0
    tracking_error: float = 0.0
    max_drawdown: float = 0.0
    violates_min_investment: list[str] = Field(default_factory=list)


class CustomPortfolioRequest(CamelModel):
    """Live-slider endpoint — user supplies weights, we return full stats
    including a portfolio equity curve."""
    weights: dict[str, float]
    risk_free_rate: float = 0.04
    total_capital: float = 1_000_000
    respect_min_investment: bool = True
    history_window_start: str | None = None
    overrides: list[AssumptionOverrideIn] = Field(default_factory=list)
    min_investment_overrides: list[MinInvestmentOverrideIn] = Field(default_factory=list)


class CustomPortfolioResponse(CamelModel):
    portfolio: PortfolioOut
    equity_months: list[str]
    equity: list[float]
    drawdown: list[float]


# ─────────────────────── data cache ───────────────────────


@lru_cache(maxsize=1)
def _load_catalog() -> dict:
    path = Path(__file__).resolve().parents[3] / "mockdata" / "fund_returns.json"
    if not path.exists():
        raise HTTPException(
            status_code=500,
            detail={
                "code": "INTERNAL_ERROR",
                "message": "fund_returns.json missing — run scripts/build_fund_returns.py",
            },
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _asset_by_id(catalog: dict) -> dict[str, dict]:
    return {a["id"]: a for a in catalog["assets"]}


# ─────────────────────── endpoints ───────────────────────


@router.get("/assets", response_model=AssetsResponse)
def list_assets() -> AssetsResponse:
    catalog = _load_catalog()
    out: list[AssetOut] = []
    for a in catalog["assets"]:
        series = series_from_asset_json(a)
        stat = compute_asset_stats(series)
        out.append(
            AssetOut(
                id=a["id"],
                name=a["name"],
                kind=a["kind"],
                strategy=a["strategy"],
                manager=a["manager"],
                min_investment=a["minInvestment"],
                aum_millions=a.get("aumMillions"),
                fees=a["fees"],
                lockup=a["lockup"],
                inception=a["inception"],
                n_months=stat.n_months,
                annualised_return=stat.annualised_return,
                annualised_vol=stat.annualised_vol,
                source=a["source"],
                warning=a.get("warning"),
            )
        )
    return AssetsResponse(
        as_of=catalog["asOf"],
        note=catalog["note"],
        assets=out,
    )


@router.post("/optimize", response_model=OptimizeResponse)
def optimize(req: OptimizeRequest) -> OptimizeResponse:
    catalog = _load_catalog()
    idx = _asset_by_id(catalog)

    missing = [a for a in req.asset_ids if a not in idx]
    if missing:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR", "message": f"Unknown asset(s): {missing}"},
        )
    if len(req.asset_ids) < 2:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR", "message": "Pick at least 2 assets."},
        )

    # Build series (with optional history window) + empirical stats.
    full_series = {a: series_from_asset_json(idx[a]) for a in req.asset_ids}
    if req.history_window_start:
        series_by_id = {a: full_series[a].since(req.history_window_start) for a in req.asset_ids}
    else:
        series_by_id = full_series
    empirical = {a: compute_asset_stats(series_by_id[a]) for a in req.asset_ids}
    effective_window_months = max(
        (len(series_by_id[a].returns) for a in req.asset_ids), default=0
    )

    # Benchmark series (for IR) — always loaded regardless of whether
    # user selected it as an investable asset. Windowed the same way.
    benchmark_id = req.benchmark_asset_id
    if benchmark_id not in idx:
        benchmark_id = "spy"
    benchmark_series = series_from_asset_json(idx[benchmark_id])
    if req.history_window_start:
        benchmark_series = benchmark_series.since(req.history_window_start)
    benchmark_name = idx[benchmark_id]["name"]

    # Overrides
    ov_by_id: dict[str, AssumptionOverride] = {}
    for o in req.overrides:
        if o.asset_id not in req.asset_ids:
            continue
        ov_by_id[o.asset_id] = AssumptionOverride(
            annualised_return=o.annualised_return,
            annualised_vol=o.annualised_vol,
            correlation_cap=o.correlation_cap,
        )

    stats = {a: _apply_overrides(empirical[a], ov_by_id.get(a)) for a in req.asset_ids}
    rho, nn = correlation_matrix(series_by_id, ov_by_id)

    # Current holdings + total capital
    current_by_id: dict[str, float] = {c.asset_id: c.amount for c in req.current_investments if c.amount > 0}
    current_total = sum(current_by_id.values())
    total_capital = current_total + req.new_capital
    if total_capital <= 0:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR", "message": "Total capital (current + new) must be > 0."},
        )

    # Effective min investments: catalog default, overridden by user.
    min_inv_override = {m.asset_id: m.min_investment for m in req.min_investment_overrides}
    effective_min_inv: dict[str, float] = {}
    for a in req.asset_ids:
        effective_min_inv[a] = min_inv_override.get(a, idx[a]["minInvestment"])

    # Soft floors: apply only if the sampler picks the asset. Right for
    # min-investment ("if you invest in this fund, invest ≥ X"). A fund
    # can still be skipped entirely.
    min_weights: dict[str, float] = {}
    if req.respect_min_investment:
        for a in req.asset_ids:
            if effective_min_inv[a] > 0:
                min_weights[a] = min(1.0, effective_min_inv[a] / total_capital)

    # Hard floors: apply to every sample. Right for no-sell / existing-
    # position constraint — the fund MUST remain in the portfolio at ≥
    # its current weight.
    hard_min_weights: dict[str, float] = {}
    if req.no_sell:
        for a in req.asset_ids:
            cur = current_by_id.get(a, 0.0)
            if cur > 0:
                hard_min_weights[a] = min(1.0, cur / total_capital)

    max_weights: dict[str, float] = {mw.asset_id: mw.max_weight for mw in req.max_weights if mw.asset_id in req.asset_ids}

    frontier, max_sharpe, min_var, max_sortino, min_dd, max_ir = compute_frontier(
        stats=stats,
        rho=rho,
        series_by_id=series_by_id,
        benchmark_series=benchmark_series,
        risk_free_rate=req.risk_free_rate,
        min_weights=min_weights,
        hard_min_weights=hard_min_weights,
        max_weights=max_weights,
        samples=req.samples,
    )

    def _flag_violations(weights: dict[str, float]) -> list[str]:
        out = []
        for a, w in weights.items():
            allocation = w * total_capital
            mi = effective_min_inv.get(a, idx[a]["minInvestment"])
            if w > 1e-6 and mi > 0 and allocation + 0.5 < mi:
                out.append(a)
        return out

    def _to_wire(p) -> PortfolioPoint_wire:
        return PortfolioPoint_wire(
            weights={k: round(v, 6) for k, v in p.weights.items()},
            annualised_return=round(p.annualised_return, 6),
            annualised_vol=round(p.annualised_vol, 6),
            sharpe=round(p.sharpe, 6),
            sortino=round(p.sortino, 6),
            information_ratio=round(p.information_ratio, 6),
            tracking_error=round(p.tracking_error, 6),
            max_drawdown=round(p.max_drawdown, 6),
            violates_min_investment=_flag_violations(p.weights),
        )

    def _to_out(p) -> PortfolioOut:
        return PortfolioOut(
            weights={k: round(v, 6) for k, v in p.weights.items()},
            annualised_return=round(p.annualised_return, 6),
            annualised_vol=round(p.annualised_vol, 6),
            sharpe=round(p.sharpe, 6),
            sortino=round(p.sortino, 6),
            information_ratio=round(p.information_ratio, 6),
            tracking_error=round(p.tracking_error, 6),
            max_drawdown=round(p.max_drawdown, 6),
            violates_min_investment=_flag_violations(p.weights),
        )

    stats_out = []
    for a in req.asset_ids:
        s = stats[a]
        e = empirical[a]
        # Per-asset IR + TE vs benchmark (skip if asset IS the benchmark)
        if a == benchmark_id:
            asset_ir, asset_te = 0.0, 0.0
        else:
            asset_ir, asset_te = asset_information_ratio(series_by_id[a], benchmark_series)
        stats_out.append(
            AssetStatOut(
                asset_id=a,
                n_months=s.n_months,
                annualised_return=round(s.annualised_return, 6),
                annualised_vol=round(s.annualised_vol, 6),
                min_month=s.min_month,
                max_month=s.max_month,
                empirical_return=round(e.annualised_return, 6),
                empirical_vol=round(e.annualised_vol, 6),
                is_overridden=a in ov_by_id
                and (
                    ov_by_id[a].annualised_return is not None
                    or ov_by_id[a].annualised_vol is not None
                ),
                information_ratio=round(asset_ir, 6),
                tracking_error=round(asset_te, 6),
            )
        )

    # Per-asset equity + drawdown curves — feeds the growth-of-$1 chart.
    # Downsample to ~150 points if longer to keep the payload small.
    asset_series: list[AssetSeriesOut] = []
    for a in req.asset_ids:
        s = series_by_id[a]
        months = sorted(s.returns)
        rets = [s.returns[m] for m in months]
        eq = cumulative_curve(rets)
        dd = drawdown_series(rets)
        mdd = max_drawdown_from_monthly(rets)
        # Downsample
        stride = max(1, len(months) // 200)
        idx_keep = list(range(0, len(months), stride))
        if idx_keep and idx_keep[-1] != len(months) - 1:
            idx_keep.append(len(months) - 1)
        asset_series.append(
            AssetSeriesOut(
                asset_id=a,
                months=[months[i] for i in idx_keep],
                returns=[round(rets[i], 6) for i in idx_keep],
                equity=[round(eq[i], 6) for i in idx_keep],
                drawdown=[round(dd[i], 6) for i in idx_keep],
                max_drawdown=round(mdd, 6),
            )
        )

    return OptimizeResponse(
        stats=stats_out,
        correlation={a: {b: round(rho[a][b], 4) for b in req.asset_ids} for a in req.asset_ids},
        overlap_months={a: {b: nn[a][b] for b in req.asset_ids} for a in req.asset_ids},
        frontier=[_to_wire(p) for p in frontier],
        max_sharpe=_to_out(max_sharpe),
        max_sortino=_to_out(max_sortino if max_sortino is not None else max_sharpe),
        max_information_ratio=_to_out(max_ir if max_ir is not None else max_sharpe),
        min_variance=_to_out(min_var),
        min_drawdown=_to_out(min_dd),
        total_capital=total_capital,
        new_capital=req.new_capital,
        current_total=current_total,
        current_investments={a: current_by_id.get(a, 0.0) for a in req.asset_ids},
        risk_free_rate=req.risk_free_rate,
        benchmark_asset_id=benchmark_id,
        benchmark_name=benchmark_name,
        asset_series=asset_series,
        history_window_start=req.history_window_start,
        effective_window_months=effective_window_months,
    )


@router.post("/custom", response_model=CustomPortfolioResponse)
def custom_portfolio(req: CustomPortfolioRequest) -> CustomPortfolioResponse:
    """Score an arbitrary user-supplied weight vector. Powers the
    interactive-slider panel: user drags weights, we return live stats +
    the compounded equity + drawdown curves for that portfolio."""
    catalog = _load_catalog()
    idx = _asset_by_id(catalog)

    weights = {k: v for k, v in req.weights.items() if v > 0}
    missing = [a for a in weights if a not in idx]
    if missing:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR", "message": f"Unknown asset(s): {missing}"},
        )
    total = sum(weights.values())
    if total <= 0:
        raise HTTPException(
            status_code=422,
            detail={"code": "VALIDATION_ERROR", "message": "All weights are zero."},
        )
    weights = {k: v / total for k, v in weights.items()}

    asset_ids = list(weights)
    full_series = {a: series_from_asset_json(idx[a]) for a in asset_ids}
    if req.history_window_start:
        series_by_id = {a: full_series[a].since(req.history_window_start) for a in asset_ids}
    else:
        series_by_id = full_series
    empirical = {a: compute_asset_stats(series_by_id[a]) for a in asset_ids}
    ov_by_id: dict[str, AssumptionOverride] = {}
    for o in req.overrides:
        if o.asset_id not in asset_ids:
            continue
        ov_by_id[o.asset_id] = AssumptionOverride(
            annualised_return=o.annualised_return,
            annualised_vol=o.annualised_vol,
            correlation_cap=o.correlation_cap,
        )
    stats = {a: _apply_overrides(empirical[a], ov_by_id.get(a)) for a in asset_ids}
    rho, _ = correlation_matrix(series_by_id, ov_by_id)

    ret = portfolio_return(weights, stats)
    vol = portfolio_vol(weights, stats, rho)
    sharpe = (ret - req.risk_free_rate) / vol if vol > 0 else 0.0
    monthly = portfolio_monthly_series(weights, series_by_id)
    monthly_rets = [r for _, r in monthly]
    sortino = sortino_from_monthly(monthly_rets, mar_annual=req.risk_free_rate) if monthly_rets else 0.0
    mdd = max_drawdown_from_monthly(monthly_rets) if monthly_rets else 0.0

    # IR vs SPY (default). Always uses full history of SPY through the
    # same window filter as the portfolio.
    bench_id = "spy" if "spy" in idx else next(iter(idx))
    bench = series_from_asset_json(idx[bench_id])
    if req.history_window_start:
        bench = bench.since(req.history_window_start)
    ir, te = information_ratio_and_te(monthly, bench) if monthly else (0.0, 0.0)

    equity_months = [m for m, _ in monthly]
    equity = cumulative_curve(monthly_rets)
    dd = drawdown_series(monthly_rets)
    # Downsample for wire
    stride = max(1, len(equity_months) // 200)
    keep = list(range(0, len(equity_months), stride))
    if keep and keep[-1] != len(equity_months) - 1:
        keep.append(len(equity_months) - 1)

    min_inv_override = {m.asset_id: m.min_investment for m in req.min_investment_overrides}
    violations: list[str] = []
    if req.respect_min_investment:
        for a, w in weights.items():
            alloc = w * req.total_capital
            mi = min_inv_override.get(a, idx[a]["minInvestment"])
            if w > 1e-6 and mi > 0 and alloc + 0.5 < mi:
                violations.append(a)

    return CustomPortfolioResponse(
        portfolio=PortfolioOut(
            weights={k: round(v, 6) for k, v in weights.items()},
            annualised_return=round(ret, 6),
            annualised_vol=round(vol, 6),
            sharpe=round(sharpe, 6),
            sortino=round(sortino, 6),
            information_ratio=round(ir, 6),
            tracking_error=round(te, 6),
            max_drawdown=round(mdd, 6),
            violates_min_investment=violations,
        ),
        equity_months=[equity_months[i] for i in keep],
        equity=[round(equity[i], 6) for i in keep],
        drawdown=[round(dd[i], 6) for i in keep],
    )


__all__ = ["router"]
