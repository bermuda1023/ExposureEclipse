"""Portfolio math for the fund-analysis page — pure Python (no numpy).

Implements:
- Empirical annualised stats (mean, std) from a monthly return series.
- Pearson correlation matrix over the *overlapping* period of each pair
  (so a fund with a short track record can still contribute — its stats
  vs. a longer-history fund are computed on their common months).
- Mean-variance efficient frontier via random Dirichlet sampling +
  refinement pass. Constraints supported:
    * long-only (weights ≥ 0)
    * weights sum to 1
    * per-asset lower bound `min_weight` (drives the minimum-investment
      constraint from the UI: `min_weight = min_investment / capital`)
- Analytical portfolios:
    * min-variance
    * max-Sharpe (tangency) portfolio at a given risk-free rate

Assumption overrides — for assets with a short track record (e.g. the
Primary Commodity Fund's 18-month history) callers can pass
`assumption_overrides` with a per-asset `{annualised_return, annualised_vol,
correlation_cap}` and the solver blends those into the empirical estimates.
That's the "adjustable priors" surface the user asked for on Primary.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Sequence


# ─────────────────────── data structures ───────────────────────


@dataclass
class ReturnSeries:
    """One asset's monthly return series, indexed by 'YYYY-MM' string."""
    asset_id: str
    returns: dict[str, float]     # month → decimal return


@dataclass
class AssetStat:
    asset_id: str
    n_months: int
    monthly_mean: float
    monthly_std: float
    annualised_return: float      # (1 + monthly_mean)^12 - 1
    annualised_vol: float         # monthly_std * sqrt(12)
    min_month: str
    max_month: str


@dataclass
class AssumptionOverride:
    """User-supplied override for an asset's stats. `None` = use empirical."""
    annualised_return: float | None = None
    annualised_vol: float | None = None
    correlation_cap: float | None = None   # |ρ| capped at this vs any other asset


@dataclass
class PortfolioPoint:
    weights: dict[str, float]
    annualised_return: float
    annualised_vol: float
    sharpe: float
    sortino: float = 0.0
    max_drawdown: float = 0.0
    violates_min_investment: list[str] = field(default_factory=list)


# ─────────────────────── stats ───────────────────────


def _monthly_stats(returns: Sequence[float]) -> tuple[float, float]:
    n = len(returns)
    if n == 0:
        return 0.0, 0.0
    mean = sum(returns) / n
    if n < 2:
        return mean, 0.0
    var = sum((r - mean) ** 2 for r in returns) / (n - 1)
    return mean, math.sqrt(var)


def _cagr(returns: Sequence[float]) -> float:
    """Compound annual growth rate — the industry-standard "annualised
    return" quoted on fund factsheets. Differs from arithmetic-mean-based
    annualisation whenever volatility > 0 (Jensen's inequality / volatility
    drag). Matches the numbers on the Bireme / Upslope / Cedar Creek / CAS
    / Alluvial letters."""
    n = len(returns)
    if n == 0:
        return 0.0
    cumulative = 1.0
    for r in returns:
        cumulative *= 1 + r
    if cumulative <= 0:
        return -1.0
    return cumulative ** (12 / n) - 1


def compute_asset_stats(series: ReturnSeries) -> AssetStat:
    if not series.returns:
        return AssetStat(series.asset_id, 0, 0.0, 0.0, 0.0, 0.0, "", "")
    months = sorted(series.returns)
    vals = [series.returns[m] for m in months]
    m_mean, m_std = _monthly_stats(vals)
    # CAGR (geometric) — the industry standard. Volatility drag on CAS
    # Sosin is ~10 pts vs arithmetic (34% arith → 24.6% CAGR), so this
    # matters a lot for high-vol funds.
    annualised_return = _cagr(vals)
    annualised_vol = m_std * math.sqrt(12)
    return AssetStat(
        asset_id=series.asset_id,
        n_months=len(vals),
        monthly_mean=m_mean,
        monthly_std=m_std,
        annualised_return=annualised_return,
        annualised_vol=annualised_vol,
        min_month=months[0],
        max_month=months[-1],
    )


def _apply_overrides(
    stat: AssetStat,
    override: AssumptionOverride | None,
) -> AssetStat:
    """Return a new AssetStat with overrides applied where provided.
    User-supplied `annualised_return` is treated as CAGR (industry
    convention). Monthly mean is back-solved as the CAGR-equivalent
    monthly compounding rate."""
    if override is None:
        return stat
    ann_ret = override.annualised_return if override.annualised_return is not None else stat.annualised_return
    ann_vol = override.annualised_vol if override.annualised_vol is not None else stat.annualised_vol
    monthly_mean = (1.0 + ann_ret) ** (1 / 12) - 1.0
    monthly_std = ann_vol / math.sqrt(12) if ann_vol > 0 else 0.0
    return AssetStat(
        asset_id=stat.asset_id,
        n_months=stat.n_months,
        monthly_mean=monthly_mean,
        monthly_std=monthly_std,
        annualised_return=ann_ret,
        annualised_vol=ann_vol,
        min_month=stat.min_month,
        max_month=stat.max_month,
    )


def pairwise_correlation(a: ReturnSeries, b: ReturnSeries) -> tuple[float, int]:
    """Pearson correlation over the overlap of a and b. Returns (rho, n)."""
    common = sorted(set(a.returns) & set(b.returns))
    if len(common) < 3:
        return 0.0, len(common)
    xs = [a.returns[m] for m in common]
    ys = [b.returns[m] for m in common]
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(len(common)))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    denom = math.sqrt(vx * vy)
    if denom == 0:
        return 0.0, len(common)
    return cov / denom, len(common)


def correlation_matrix(
    series_by_id: dict[str, ReturnSeries],
    overrides: dict[str, AssumptionOverride] | None = None,
) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, int]]]:
    """Full correlation matrix + per-pair overlap counts.

    If `overrides[a].correlation_cap` is set, |ρ| between a and any other
    asset is capped at that value (sign preserved). Applied symmetrically
    — if either side of a pair has a cap, the tighter one wins.
    """
    ids = list(series_by_id)
    rho: dict[str, dict[str, float]] = {i: {} for i in ids}
    nn: dict[str, dict[str, int]] = {i: {} for i in ids}
    overrides = overrides or {}
    for i in ids:
        for j in ids:
            if i == j:
                rho[i][j] = 1.0
                nn[i][j] = series_by_id[i].returns.__len__()
                continue
            if j in rho[i]:
                continue
            r, n = pairwise_correlation(series_by_id[i], series_by_id[j])
            cap = None
            for side in (i, j):
                c = overrides.get(side)
                if c and c.correlation_cap is not None:
                    cap = c.correlation_cap if cap is None else min(cap, c.correlation_cap)
            if cap is not None:
                r = max(-cap, min(cap, r))
            rho[i][j] = r
            rho[j][i] = r
            nn[i][j] = n
            nn[j][i] = n
    return rho, nn


# ─────────────────────── portfolio math ───────────────────────


def portfolio_return(weights: dict[str, float], stats: dict[str, AssetStat]) -> float:
    return sum(weights[a] * stats[a].annualised_return for a in weights)


def portfolio_monthly_series(
    weights: dict[str, float],
    series_by_id: dict[str, ReturnSeries],
) -> list[tuple[str, float]]:
    """Build the portfolio's monthly-return series over the union of months
    that ALL selected (weight > 0) assets share. Returns [(month, ret), ...]
    sorted by month. Used for portfolio Sortino, drawdown, and the growth-of-$1
    chart on the frontend."""
    active = [a for a, w in weights.items() if w > 1e-6]
    if not active:
        return []
    common = set(series_by_id[active[0]].returns)
    for a in active[1:]:
        common &= set(series_by_id[a].returns)
    months = sorted(common)
    out: list[tuple[str, float]] = []
    for m in months:
        r = sum(weights[a] * series_by_id[a].returns[m] for a in active)
        out.append((m, r))
    return out


MIN_MONTHS_FOR_TAIL_METRICS = 24


def sortino_from_monthly(returns: list[float], mar_annual: float = 0.0) -> float:
    """Annualised Sortino using CAGR in the numerator (matches factsheet
    convention) and monthly downside deviation vs the target in the
    denominator. Returns 0.0 if the sample is too short (<24 months) or
    fewer than 3 downside months — otherwise the ratio can spike to
    nonsense values when a lucky sample avoids drawdowns."""
    if len(returns) < MIN_MONTHS_FOR_TAIL_METRICS:
        return 0.0
    mar_m = (1 + mar_annual) ** (1 / 12) - 1
    downside_vals = [(r - mar_m) ** 2 for r in returns if r < mar_m]
    if len(downside_vals) < 3:
        return 0.0
    dd = math.sqrt(sum(downside_vals) / len(returns))
    if dd == 0:
        return 0.0
    ann_ret = _cagr(returns)
    ann_dd = dd * math.sqrt(12)
    return (ann_ret - mar_annual) / ann_dd


def max_drawdown_from_monthly(returns: list[float]) -> float:
    """Max drawdown over the compounded equity curve. Returns a NEGATIVE
    number (e.g. -0.32 = 32% peak-to-trough drawdown). Returns 0 if the
    sample is too short to be meaningful."""
    if len(returns) < MIN_MONTHS_FOR_TAIL_METRICS:
        return 0.0
    equity = 1.0
    peak = 1.0
    worst = 0.0
    for r in returns:
        equity *= 1 + r
        peak = max(peak, equity)
        dd = equity / peak - 1
        worst = min(worst, dd)
    return worst


def cumulative_curve(returns: list[float]) -> list[float]:
    """Compounded equity curve starting at 1.0."""
    out = []
    equity = 1.0
    for r in returns:
        equity *= 1 + r
        out.append(equity)
    return out


def drawdown_series(returns: list[float]) -> list[float]:
    """Per-month drawdown from running peak."""
    out = []
    equity = 1.0
    peak = 1.0
    for r in returns:
        equity *= 1 + r
        peak = max(peak, equity)
        out.append(equity / peak - 1)
    return out


def portfolio_vol(
    weights: dict[str, float],
    stats: dict[str, AssetStat],
    rho: dict[str, dict[str, float]],
) -> float:
    """σ_p = sqrt( Σ_i Σ_j w_i w_j σ_i σ_j ρ_ij )"""
    ids = list(weights)
    var = 0.0
    for i in ids:
        for j in ids:
            var += weights[i] * weights[j] * stats[i].annualised_vol * stats[j].annualised_vol * rho[i][j]
    return math.sqrt(max(0.0, var))


def _sample_dirichlet(n: int, alpha: float, rng: random.Random) -> list[float]:
    xs = [rng.gammavariate(alpha, 1.0) for _ in range(n)]
    s = sum(xs) or 1.0
    return [x / s for x in xs]


def compute_frontier(
    stats: dict[str, AssetStat],
    rho: dict[str, dict[str, float]],
    series_by_id: dict[str, ReturnSeries] | None = None,
    risk_free_rate: float = 0.04,
    min_weights: dict[str, float] | None = None,
    max_weights: dict[str, float] | None = None,
    samples: int = 40_000,
    seed: int = 42,
) -> tuple[list[PortfolioPoint], PortfolioPoint, PortfolioPoint, PortfolioPoint | None, PortfolioPoint]:
    """Trace the efficient frontier by Dirichlet sampling. Returns
    (frontier_hull, max_sharpe, min_variance, max_sortino, min_drawdown).

    `min_weights[asset_id]` (optional) applies a per-asset lower bound
    for any asset the sampler picks (participation floor from the
    minimum-investment constraint). Assets can still be picked out at
    weight 0 — floors only kick in for assets the sample includes.

    `max_weights[asset_id]` (optional) hard-caps each asset at that
    weight; violating samples are skipped. Useful for concentration
    controls on volatile funds like Sosin.

    When `series_by_id` is supplied we also compute per-sample Sortino
    and max drawdown (from the joint monthly series) and return the
    max-Sortino + min-drawdown points.
    """
    ids = list(stats)
    n = len(ids)
    if n == 0:
        empty = PortfolioPoint({}, 0.0, 0.0, 0.0)
        return [], empty, empty, None, empty
    if n == 1:
        one = ids[0]
        p = PortfolioPoint(
            weights={one: 1.0},
            annualised_return=stats[one].annualised_return,
            annualised_vol=stats[one].annualised_vol,
            sharpe=(stats[one].annualised_return - risk_free_rate) / stats[one].annualised_vol if stats[one].annualised_vol > 0 else 0.0,
        )
        return [p], p, p, p, p

    rng = random.Random(seed)
    min_weights = min_weights or {}
    max_weights = max_weights or {}
    points: list[PortfolioPoint] = []

    # Mix Dirichlet with concentration levels to cover both the diffuse
    # (equal-ish weight) and concentrated (single-asset-heavy) parts of
    # the simplex.
    alpha_choices = [0.2, 0.5, 1.0, 2.0, 5.0]

    for k in range(samples):
        alpha = alpha_choices[k % len(alpha_choices)]
        # Choose which assets participate (each independently with prob 0.6)
        # — this lets the sampler find 2-asset and 3-asset portfolios that
        # sit on the frontier.
        chosen = [i for i in ids if rng.random() < 0.65]
        if not chosen:
            chosen = ids
        raw = _sample_dirichlet(len(chosen), alpha, rng)
        weights = {i: 0.0 for i in ids}
        for c, w in zip(chosen, raw):
            weights[c] = w

        # Apply per-asset minimum-weight floors on participating assets,
        # then renormalise. Discard if the floors would over-fill (>1).
        floor_total = sum(min_weights.get(a, 0.0) for a in ids if weights[a] > 0)
        if floor_total > 1.0:
            continue
        headroom = 1.0 - floor_total
        # Rescale non-floor part
        non_floor_sum = sum(max(0.0, weights[a] - min_weights.get(a, 0.0)) for a in ids)
        if non_floor_sum <= 0:
            weights = {a: min_weights.get(a, 0.0) if weights[a] > 0 else 0.0 for a in ids}
            s = sum(weights.values()) or 1.0
            weights = {a: w / s for a, w in weights.items()}
        else:
            for a in ids:
                if weights[a] > 0:
                    base = min_weights.get(a, 0.0)
                    excess = max(0.0, weights[a] - base) / non_floor_sum * headroom
                    weights[a] = base + excess
                else:
                    weights[a] = 0.0

        # Hard max-weight cap: reject if any active asset breaches
        if max_weights:
            over = any(weights[a] > max_weights.get(a, 1.0) + 1e-9 for a in ids)
            if over:
                continue

        ret = portfolio_return(weights, stats)
        vol = portfolio_vol(weights, stats, rho)
        sharpe = (ret - risk_free_rate) / vol if vol > 0 else 0.0
        sortino = 0.0
        mdd = 0.0
        if series_by_id is not None:
            monthly = [r for _, r in portfolio_monthly_series(weights, series_by_id)]
            if monthly:
                sortino = sortino_from_monthly(monthly, mar_annual=risk_free_rate)
                mdd = max_drawdown_from_monthly(monthly)
        points.append(PortfolioPoint(weights, ret, vol, sharpe, sortino, mdd))

    if not points:
        empty = PortfolioPoint({i: 0.0 for i in ids}, 0.0, 0.0, 0.0)
        return [], empty, empty, None, empty

    # Extract the efficient frontier (upper envelope over vol bins).
    points.sort(key=lambda p: p.annualised_vol)
    frontier: list[PortfolioPoint] = []
    # Bin by vol, keep max-return per bin
    vol_max = max(p.annualised_vol for p in points)
    n_bins = 100
    bin_size = vol_max / n_bins if vol_max > 0 else 1.0
    best_per_bin: dict[int, PortfolioPoint] = {}
    for p in points:
        bkt = int(p.annualised_vol / bin_size) if bin_size > 0 else 0
        cur = best_per_bin.get(bkt)
        if cur is None or p.annualised_return > cur.annualised_return:
            best_per_bin[bkt] = p
    # Keep points that are Pareto-improving as vol rises
    best_ret_so_far = -1e18
    for bkt in sorted(best_per_bin):
        p = best_per_bin[bkt]
        if p.annualised_return > best_ret_so_far:
            frontier.append(p)
            best_ret_so_far = p.annualised_return

    max_sharpe = max(points, key=lambda p: p.sharpe)
    min_var = min(points, key=lambda p: p.annualised_vol)
    max_sortino: PortfolioPoint | None = None
    min_dd = min_var
    if series_by_id is not None:
        max_sortino = max(points, key=lambda p: p.sortino)
        min_dd = max(points, key=lambda p: p.max_drawdown)  # least negative
    return frontier, max_sharpe, min_var, max_sortino, min_dd


# ─────────────────────── loader ───────────────────────


def series_from_asset_json(asset: dict) -> ReturnSeries:
    """Build ReturnSeries from one JSON asset entry."""
    return ReturnSeries(
        asset_id=asset["id"],
        returns={r["month"]: r["ret"] for r in asset["returns"]},
    )
