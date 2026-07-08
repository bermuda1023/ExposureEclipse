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
    compute_asset_stats,
    compute_frontier,
    correlation_matrix,
    series_from_asset_json,
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


class OptimizeRequest(CamelModel):
    asset_ids: list[str] = Field(..., description="Subset of catalog IDs")
    total_capital: float = Field(1_000_000, gt=0)
    risk_free_rate: float = 0.04
    respect_min_investment: bool = True
    overrides: list[AssumptionOverrideIn] = Field(default_factory=list)
    samples: int = Field(30_000, ge=1_000, le=100_000)


class PortfolioOut(CamelModel):
    weights: dict[str, float]
    annualised_return: float
    annualised_vol: float
    sharpe: float
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


class OptimizeResponse(CamelModel):
    stats: list[AssetStatOut]
    correlation: dict[str, dict[str, float]]   # id → id → ρ
    overlap_months: dict[str, dict[str, int]]  # id → id → # common months
    frontier: list[PortfolioPoint_wire]
    max_sharpe: PortfolioOut
    min_variance: PortfolioOut
    total_capital: float
    risk_free_rate: float


class PortfolioPoint_wire(CamelModel):
    weights: dict[str, float]
    annualised_return: float
    annualised_vol: float
    sharpe: float
    violates_min_investment: list[str] = Field(default_factory=list)


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

    # Build series + empirical stats
    series_by_id = {a: series_from_asset_json(idx[a]) for a in req.asset_ids}
    empirical = {a: compute_asset_stats(series_by_id[a]) for a in req.asset_ids}

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

    # Apply overrides
    from ..services.portfolio_math import _apply_overrides
    stats = {a: _apply_overrides(empirical[a], ov_by_id.get(a)) for a in req.asset_ids}

    # Correlation matrix
    rho, nn = correlation_matrix(series_by_id, ov_by_id)

    # Min-weight floors from ticket size
    min_weights: dict[str, float] = {}
    if req.respect_min_investment:
        for a in req.asset_ids:
            mi = idx[a]["minInvestment"]
            if mi > 0:
                min_weights[a] = min(1.0, mi / req.total_capital)

    frontier, max_sharpe, min_var = compute_frontier(
        stats=stats,
        rho=rho,
        risk_free_rate=req.risk_free_rate,
        min_weights=min_weights,
        samples=req.samples,
    )

    def _flag_violations(weights: dict[str, float]) -> list[str]:
        out = []
        for a, w in weights.items():
            allocation = w * req.total_capital
            mi = idx[a]["minInvestment"]
            if w > 1e-6 and mi > 0 and allocation + 0.5 < mi:  # 50-cent tolerance
                out.append(a)
        return out

    def _to_wire(p) -> PortfolioPoint_wire:
        return PortfolioPoint_wire(
            weights={k: round(v, 6) for k, v in p.weights.items()},
            annualised_return=round(p.annualised_return, 6),
            annualised_vol=round(p.annualised_vol, 6),
            sharpe=round(p.sharpe, 6),
            violates_min_investment=_flag_violations(p.weights),
        )

    def _to_out(p) -> PortfolioOut:
        return PortfolioOut(
            weights={k: round(v, 6) for k, v in p.weights.items()},
            annualised_return=round(p.annualised_return, 6),
            annualised_vol=round(p.annualised_vol, 6),
            sharpe=round(p.sharpe, 6),
            violates_min_investment=_flag_violations(p.weights),
        )

    stats_out = []
    for a in req.asset_ids:
        s = stats[a]
        e = empirical[a]
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
            )
        )

    return OptimizeResponse(
        stats=stats_out,
        correlation={a: {b: round(rho[a][b], 4) for b in req.asset_ids} for a in req.asset_ids},
        overlap_months={a: {b: nn[a][b] for b in req.asset_ids} for a in req.asset_ids},
        frontier=[_to_wire(p) for p in frontier],
        max_sharpe=_to_out(max_sharpe),
        min_variance=_to_out(min_var),
        total_capital=req.total_capital,
        risk_free_rate=req.risk_free_rate,
    )


__all__ = ["router"]
