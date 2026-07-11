"""Portfolio math for the fund-analysis page — pure Python (no numpy).

Design rules (personal multi-fund use)
─────────────────────────────────────
* **μ for MVO / Sharpe** = arithmetic expected annual return (E[r]×12),
  optionally net of fee drag. CAGR stays on AssetStat for display only.
* **Covariance** = pairwise ρ over overlap, **shrunk toward a prior** when
  overlap is short; never treat n&lt;3 as ρ=0 (that overstates diversification).
* **Path metrics** (Sortino, max DD, IR, realized Sharpe) use the **common
  monthly intersection** of assets with weight &gt; 0 — same universe.
* **Min investment**: soft participation floors + hard post-pass enforcement
  (zero out sub-ticket weights and renormalize so winners are feasible).
* **New-cash mode**: existing holdings fixed; sample only free-weight on
  new capital (true “where does new money go?”).
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
    returns: dict[str, float]  # month → decimal return

    def since(self, start_month: str) -> "ReturnSeries":
        return ReturnSeries(
            asset_id=self.asset_id,
            returns={m: r for m, r in self.returns.items() if m >= start_month},
        )


@dataclass
class AssetStat:
    asset_id: str
    n_months: int
    monthly_mean: float
    monthly_std: float
    annualised_return: float  # CAGR (display / factsheet)
    expected_return: float  # arithmetic annual E[r] — used in MVO
    annualised_vol: float  # monthly_std * sqrt(12)
    min_month: str
    max_month: str
    fee_drag: float = 0.0  # annual fee haircut already applied to expected_return


@dataclass
class AssumptionOverride:
    """User-supplied override. `None` = use empirical."""

    annualised_return: float | None = None  # treated as expected CAGR-like input for μ
    annualised_vol: float | None = None
    correlation_cap: float | None = None


@dataclass
class PortfolioPoint:
    weights: dict[str, float]
    annualised_return: float  # path CAGR when available, else μ blend
    expected_return: float  # arithmetic portfolio μ used in MVO
    annualised_vol: float
    sharpe: float
    sortino: float = 0.0
    information_ratio: float = 0.0
    tracking_error: float = 0.0
    max_drawdown: float = 0.0
    violates_min_investment: list[str] = field(default_factory=list)
    realized_return: float | None = None  # path CAGR when computed
    realized_vol: float | None = None


# ─────────────────────── stats ───────────────────────

# Correlation: shrink empirical ρ toward this prior when overlap is thin.
CORR_PRIOR = 0.35
CORR_FULL_N = 36  # full weight on empirical at this many overlapping months
CORR_MIN_N = 3


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
    n = len(returns)
    if n == 0:
        return 0.0
    cumulative = 1.0
    for r in returns:
        cumulative *= 1 + r
    if cumulative <= 0:
        return -1.0
    return cumulative ** (12 / n) - 1


def compute_asset_stats(series: ReturnSeries, fee_drag: float = 0.0) -> AssetStat:
    if not series.returns:
        return AssetStat(series.asset_id, 0, 0.0, 0.0, 0.0, 0.0, 0.0, "", "", fee_drag)
    months = sorted(series.returns)
    vals = [series.returns[m] for m in months]
    m_mean, m_std = _monthly_stats(vals)
    cagr = _cagr(vals)
    # Arithmetic annual expected return (MVO μ); haircut by fee drag.
    expected = m_mean * 12.0 - fee_drag
    return AssetStat(
        asset_id=series.asset_id,
        n_months=len(vals),
        monthly_mean=m_mean,
        monthly_std=m_std,
        annualised_return=cagr,
        expected_return=expected,
        annualised_vol=m_std * math.sqrt(12),
        min_month=months[0],
        max_month=months[-1],
        fee_drag=fee_drag,
    )


def _apply_overrides(
    stat: AssetStat,
    override: AssumptionOverride | None,
) -> AssetStat:
    """Apply user μ/σ overrides. User return is interpreted as **expected
    annual return** (arithmetic-style input for MVO), not pure CAGR."""
    if override is None:
        return stat
    # Prefer explicit override as expected μ; also store as annualised_return
    # for UI display of "assumed return".
    if override.annualised_return is not None:
        ann_ret = override.annualised_return
        expected = override.annualised_return  # already net if user says so
        monthly_mean = expected / 12.0
    else:
        ann_ret = stat.annualised_return
        expected = stat.expected_return
        monthly_mean = stat.monthly_mean
    if override.annualised_vol is not None:
        ann_vol = override.annualised_vol
        monthly_std = ann_vol / math.sqrt(12) if ann_vol > 0 else 0.0
    else:
        ann_vol = stat.annualised_vol
        monthly_std = stat.monthly_std
    return AssetStat(
        asset_id=stat.asset_id,
        n_months=stat.n_months,
        monthly_mean=monthly_mean,
        monthly_std=monthly_std,
        annualised_return=ann_ret,
        expected_return=expected,
        annualised_vol=ann_vol,
        min_month=stat.min_month,
        max_month=stat.max_month,
        fee_drag=stat.fee_drag,
    )


def pairwise_correlation(
    a: ReturnSeries,
    b: ReturnSeries,
    *,
    prior: float = CORR_PRIOR,
    full_n: int = CORR_FULL_N,
) -> tuple[float, int]:
    """Pearson ρ over overlap, shrunk toward ``prior`` when n is small.

    Never returns 0.0 solely because n is tiny — that falsely signals
    free diversification. n&lt;CORR_MIN_N → pure prior.
    """
    common = sorted(set(a.returns) & set(b.returns))
    n = len(common)
    if n < CORR_MIN_N:
        return prior, n
    xs = [a.returns[m] for m in common]
    ys = [b.returns[m] for m in common]
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    denom = math.sqrt(vx * vy)
    if denom == 0:
        return prior, n
    r_emp = cov / denom
    # Linear shrink: weight on empirical rises to 1 at full_n months.
    w = min(1.0, n / float(full_n))
    r = w * r_emp + (1.0 - w) * prior
    return max(-1.0, min(1.0, r)), n


def correlation_matrix(
    series_by_id: dict[str, ReturnSeries],
    overrides: dict[str, AssumptionOverride] | None = None,
    *,
    prior: float = CORR_PRIOR,
) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, int]]]:
    ids = list(series_by_id)
    rho: dict[str, dict[str, float]] = {i: {} for i in ids}
    nn: dict[str, dict[str, int]] = {i: {} for i in ids}
    overrides = overrides or {}
    for i in ids:
        for j in ids:
            if i == j:
                rho[i][j] = 1.0
                nn[i][j] = len(series_by_id[i].returns)
                continue
            if j in rho[i]:
                continue
            r, n = pairwise_correlation(series_by_id[i], series_by_id[j], prior=prior)
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


def portfolio_expected_return(weights: dict[str, float], stats: dict[str, AssetStat]) -> float:
    """Arithmetic portfolio μ = Σ w_i μ_i (MVO numerator)."""
    return sum(weights[a] * stats[a].expected_return for a in weights)


def portfolio_return(weights: dict[str, float], stats: dict[str, AssetStat]) -> float:
    """Back-compat alias → expected (arithmetic) return for MVO."""
    return portfolio_expected_return(weights, stats)


def portfolio_display_cagr_blend(weights: dict[str, float], stats: dict[str, AssetStat]) -> float:
    """Weighted average of CAGRs — display only, not used for Sharpe ranking."""
    return sum(weights[a] * stats[a].annualised_return for a in weights)


def portfolio_monthly_series(
    weights: dict[str, float],
    series_by_id: dict[str, ReturnSeries],
) -> list[tuple[str, float]]:
    """Portfolio monthly returns on the **intersection** of active assets."""
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


MIN_MONTHS_FOR_TAIL_METRICS = 12
SORTINO_MAX = 15.0
IR_MAX = 15.0


def sortino_from_monthly(returns: list[float], mar_annual: float = 0.0) -> float:
    if len(returns) < MIN_MONTHS_FOR_TAIL_METRICS:
        return 0.0
    mar_m = (1 + mar_annual) ** (1 / 12) - 1
    downside_vals = [(r - mar_m) ** 2 for r in returns if r < mar_m]
    if len(downside_vals) < 2:
        return 0.0
    # Full-sample downside deviation (classic Sortino): zeros on up months.
    dd = math.sqrt(sum(downside_vals) / len(returns))
    if dd == 0:
        return 0.0
    ann_ret = _cagr(returns)
    ann_dd = dd * math.sqrt(12)
    sortino = (ann_ret - mar_annual) / ann_dd
    return max(-SORTINO_MAX, min(SORTINO_MAX, sortino))


def max_drawdown_from_monthly(returns: list[float]) -> float:
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
    out = []
    equity = 1.0
    for r in returns:
        equity *= 1 + r
        out.append(equity)
    return out


def drawdown_series(returns: list[float]) -> list[float]:
    out = []
    equity = 1.0
    peak = 1.0
    for r in returns:
        equity *= 1 + r
        peak = max(peak, equity)
        out.append(equity / peak - 1)
    return out


def realized_vol_from_monthly(returns: list[float]) -> float:
    if len(returns) < 2:
        return 0.0
    m = sum(returns) / len(returns)
    var = sum((r - m) ** 2 for r in returns) / (len(returns) - 1)
    return math.sqrt(var) * math.sqrt(12)


def information_ratio_and_te(
    monthly_returns: list[tuple[str, float]],
    benchmark: ReturnSeries,
) -> tuple[float, float]:
    if not monthly_returns:
        return 0.0, 0.0
    active: list[float] = []
    for m, port_ret in monthly_returns:
        if m in benchmark.returns:
            active.append(port_ret - benchmark.returns[m])
    n = len(active)
    if n < 12:
        return 0.0, 0.0
    mean_active = sum(active) / n
    var = sum((a - mean_active) ** 2 for a in active) / (n - 1)
    te_monthly = math.sqrt(var)
    if te_monthly == 0:
        return 0.0, 0.0
    ir = (mean_active / te_monthly) * math.sqrt(12)
    te_annual = te_monthly * math.sqrt(12)
    return max(-IR_MAX, min(IR_MAX, ir)), te_annual


def asset_information_ratio(
    asset: ReturnSeries,
    benchmark: ReturnSeries,
) -> tuple[float, float]:
    common = sorted(set(asset.returns) & set(benchmark.returns))
    if len(common) < 12:
        return 0.0, 0.0
    pairs = [(m, asset.returns[m]) for m in common]
    return information_ratio_and_te(pairs, benchmark)


def portfolio_vol(
    weights: dict[str, float],
    stats: dict[str, AssetStat],
    rho: dict[str, dict[str, float]],
) -> float:
    ids = list(weights)
    var = 0.0
    for i in ids:
        for j in ids:
            var += (
                weights[i]
                * weights[j]
                * stats[i].annualised_vol
                * stats[j].annualised_vol
                * rho[i][j]
            )
    return math.sqrt(max(0.0, var))


def _sample_dirichlet(n: int, alpha: float, rng: random.Random) -> list[float]:
    xs = [rng.gammavariate(alpha, 1.0) for _ in range(n)]
    s = sum(xs) or 1.0
    return [x / s for x in xs]


def enforce_min_investments(
    weights: dict[str, float],
    total_capital: float,
    min_investment: dict[str, float],
) -> tuple[dict[str, float], list[str]]:
    """Hard ticket rule: if 0 &lt; $alloc &lt; min, drop fund and renormalize.

    Returns (feasible_weights, dropped_ids). Dropped means "can't hold at
    ticket size given capital" — not left as a soft violation flag.
    """
    if total_capital <= 0:
        return weights, []
    w = dict(weights)
    dropped: list[str] = []
    changed = True
    # Iterate because renormalization can push another line under min.
    for _ in range(len(w) + 2):
        if not changed:
            break
        changed = False
        for a, wt in list(w.items()):
            mi = min_investment.get(a, 0.0)
            if mi <= 0 or wt <= 1e-9:
                continue
            if wt * total_capital + 0.5 < mi:
                w[a] = 0.0
                dropped.append(a)
                changed = True
        s = sum(w.values())
        if s <= 0:
            return {a: 0.0 for a in weights}, dropped
        if changed:
            w = {a: v / s for a, v in w.items()}
    return w, dropped


def project_max_weights(
    weights: dict[str, float],
    max_weights: dict[str, float],
) -> dict[str, float] | None:
    """Iteratively clip weights to max and redistribute excess. None if infeasible."""
    if not max_weights:
        return weights
    w = dict(weights)
    for _ in range(20):
        over = {a: w[a] - max_weights[a] for a in w if w[a] > max_weights.get(a, 1.0) + 1e-12}
        if not over:
            return w
        excess = sum(over.values())
        for a in over:
            w[a] = max_weights[a]
        free = [a for a in w if a not in over and w[a] < max_weights.get(a, 1.0) - 1e-12]
        if not free:
            return None
        room = {a: max_weights.get(a, 1.0) - w[a] for a in free}
        room_sum = sum(room.values())
        if room_sum <= 1e-12:
            return None
        for a in free:
            w[a] += excess * (room[a] / room_sum)
    s = sum(w.values())
    if s <= 0:
        return None
    return {a: v / s for a, v in w.items()}


def compute_frontier(
    stats: dict[str, AssetStat],
    rho: dict[str, dict[str, float]],
    series_by_id: dict[str, ReturnSeries] | None = None,
    benchmark_series: ReturnSeries | None = None,
    risk_free_rate: float = 0.04,
    min_weights: dict[str, float] | None = None,
    hard_min_weights: dict[str, float] | None = None,
    max_weights: dict[str, float] | None = None,
    min_investment_dollars: dict[str, float] | None = None,
    total_capital: float = 0.0,
    free_weight: float = 1.0,
    fixed_weights: dict[str, float] | None = None,
    samples: int = 40_000,
    seed: int = 42,
) -> tuple[
    list[PortfolioPoint],
    PortfolioPoint,
    PortfolioPoint,
    PortfolioPoint | None,
    PortfolioPoint,
    PortfolioPoint | None,
]:
    """Trace efficient frontier via Dirichlet sampling.

    ``fixed_weights`` + ``free_weight``: new-cash mode. Sample only the free
    sleeve (sum free_weight), then final w = fixed + free_sample.
    """
    ids = list(stats)
    n = len(ids)
    empty = PortfolioPoint({}, 0.0, 0.0, 0.0, 0.0)
    if n == 0:
        return [], empty, empty, None, empty, None

    fixed_weights = fixed_weights or {}
    min_weights = min_weights or {}
    hard_min_weights = hard_min_weights or {}
    max_weights = max_weights or {}
    min_investment_dollars = min_investment_dollars or {}

    hard_floor_sum = sum(hard_min_weights.values())
    if hard_floor_sum > 1.0 + 1e-9:
        scale = 1.0 / hard_floor_sum
        hard_min_weights = {a: w * scale for a, w in hard_min_weights.items()}

    if n == 1:
        one = ids[0]
        w = {one: 1.0}
        mu = portfolio_expected_return(w, stats)
        vol = stats[one].annualised_vol
        sharpe = (mu - risk_free_rate) / vol if vol > 0 else 0.0
        p = PortfolioPoint(
            weights=w,
            annualised_return=stats[one].annualised_return,
            expected_return=mu,
            annualised_vol=vol,
            sharpe=sharpe,
        )
        return [p], p, p, p, p, p

    rng = random.Random(seed)
    points: list[PortfolioPoint] = []
    alpha_choices = [0.2, 0.5, 1.0, 2.0, 5.0]

    # Assets we can put free capital into (not locked 100% fixed).
    free_ids = [i for i in ids if free_weight > 1e-12]

    for k in range(samples):
        alpha = alpha_choices[k % len(alpha_choices)]

        # Sample free sleeve
        if free_weight <= 1e-12:
            weights = {i: fixed_weights.get(i, 0.0) for i in ids}
            sfix = sum(weights.values()) or 1.0
            weights = {i: weights[i] / sfix for i in ids}
        else:
            chosen = [
                i
                for i in free_ids
                if i in hard_min_weights or rng.random() < 0.65
            ]
            if not chosen:
                chosen = list(free_ids)
            raw = _sample_dirichlet(len(chosen), alpha, rng)
            free_w = {i: 0.0 for i in ids}
            for c, wv in zip(chosen, raw):
                free_w[c] = wv * free_weight

            # Soft floors apply only to free sleeve participation
            floors: dict[str, float] = {}
            for a in ids:
                f = hard_min_weights.get(a, 0.0)
                if free_w[a] > 0:
                    # Soft min is absolute portfolio weight
                    f = max(f, min_weights.get(a, 0.0))
                # Fixed holdings are part of floor for new-cash mode
                f = max(f, fixed_weights.get(a, 0.0))
                floors[a] = f

            floor_total = sum(floors.values())
            if floor_total > 1.0 + 1e-9:
                continue
            headroom = 1.0 - floor_total
            # Combine fixed + free sample as starting point
            base_w = {a: fixed_weights.get(a, 0.0) + free_w[a] for a in ids}
            sbase = sum(base_w.values()) or 1.0
            base_w = {a: base_w[a] / sbase for a in ids}

            non_floor_sum = sum(max(0.0, base_w[a] - floors[a]) for a in ids)
            if non_floor_sum <= 0:
                s = sum(floors.values()) or 1.0
                weights = {a: floors[a] / s for a in ids}
            else:
                weights = {}
                for a in ids:
                    base = floors[a]
                    excess = max(0.0, base_w[a] - base) / non_floor_sum * headroom
                    weights[a] = base + excess

        # Project max weights
        projected = project_max_weights(weights, max_weights)
        if projected is None:
            continue
        weights = projected

        # Hard ticket sizes
        if total_capital > 0 and min_investment_dollars:
            weights, _dropped = enforce_min_investments(
                weights, total_capital, min_investment_dollars
            )
            if sum(weights.values()) <= 0:
                continue
            # Re-apply hard mins after ticket drop if needed
            for a, f in hard_min_weights.items():
                if weights.get(a, 0.0) + 1e-9 < f:
                    # Infeasible after ticket enforcement
                    weights = None  # type: ignore[assignment]
                    break
            if weights is None:
                continue
            s = sum(weights.values())
            weights = {a: v / s for a, v in weights.items()}

        mu = portfolio_expected_return(weights, stats)
        vol_analytical = portfolio_vol(weights, stats, rho)

        sortino = 0.0
        mdd = 0.0
        ir = 0.0
        te = 0.0
        realized_cagr = None
        realized_vol = None
        # Prefer path-based Sharpe when we have enough common history —
        # same universe as Sortino / DD / IR.
        if series_by_id is not None:
            monthly_series = portfolio_monthly_series(weights, series_by_id)
            monthly_rets = [r for _, r in monthly_series]
            if len(monthly_rets) >= MIN_MONTHS_FOR_TAIL_METRICS:
                sortino = sortino_from_monthly(monthly_rets, mar_annual=risk_free_rate)
                mdd = max_drawdown_from_monthly(monthly_rets)
                realized_cagr = _cagr(monthly_rets)
                realized_vol = realized_vol_from_monthly(monthly_rets)
                if benchmark_series is not None:
                    ir, te = information_ratio_and_te(monthly_series, benchmark_series)

        if realized_vol is not None and realized_vol > 0 and realized_cagr is not None:
            # Path Sharpe uses realized CAGR vs path vol (aligned universe).
            sharpe = (realized_cagr - risk_free_rate) / realized_vol
            ann_ret_display = realized_cagr
            vol = realized_vol
        else:
            sharpe = (mu - risk_free_rate) / vol_analytical if vol_analytical > 0 else 0.0
            ann_ret_display = portfolio_display_cagr_blend(weights, stats)
            vol = vol_analytical

        points.append(
            PortfolioPoint(
                weights=weights,
                annualised_return=ann_ret_display,
                expected_return=mu,
                annualised_vol=vol,
                sharpe=sharpe,
                sortino=sortino,
                information_ratio=ir,
                tracking_error=te,
                max_drawdown=mdd,
                realized_return=realized_cagr,
                realized_vol=realized_vol,
            )
        )

    if not points:
        empty = PortfolioPoint({i: 0.0 for i in ids}, 0.0, 0.0, 0.0, 0.0)
        return [], empty, empty, None, empty, None

    points.sort(key=lambda p: p.annualised_vol)
    frontier: list[PortfolioPoint] = []
    vol_max = max(p.annualised_vol for p in points)
    n_bins = 100
    bin_size = vol_max / n_bins if vol_max > 0 else 1.0
    best_per_bin: dict[int, PortfolioPoint] = {}
    for p in points:
        bkt = int(p.annualised_vol / bin_size) if bin_size > 0 else 0
        cur = best_per_bin.get(bkt)
        if cur is None or p.annualised_return > cur.annualised_return:
            best_per_bin[bkt] = p
    best_ret_so_far = -1e18
    for bkt in sorted(best_per_bin):
        p = best_per_bin[bkt]
        if p.annualised_return > best_ret_so_far:
            frontier.append(p)
            best_ret_so_far = p.annualised_return

    max_sharpe = max(points, key=lambda p: p.sharpe)
    min_var = min(points, key=lambda p: p.annualised_vol)
    max_sortino: PortfolioPoint | None = None
    max_ir: PortfolioPoint | None = None
    min_dd = min_var
    if series_by_id is not None:
        max_sortino = max(points, key=lambda p: p.sortino)
        min_dd = max(points, key=lambda p: p.max_drawdown)
    if benchmark_series is not None:
        max_ir = max(points, key=lambda p: p.information_ratio)
    return frontier, max_sharpe, min_var, max_sortino, min_dd, max_ir


def series_from_asset_json(asset: dict) -> ReturnSeries:
    return ReturnSeries(
        asset_id=asset["id"],
        returns={r["month"]: r["ret"] for r in asset["returns"]},
    )


def parse_mgmt_fee_drag(fees: str | None) -> float:
    """Best-effort parse of annual mgmt fee from strings like '2% mgmt / 20% perf'.

    Perf fees are path-dependent — not modeled. Mgmt fee is applied as a
    constant annual haircut to expected return.
    """
    if not fees:
        return 0.0
    import re

    m = re.search(r"(\d+(?:\.\d+)?)\s*%\s*mgmt", fees, re.I)
    if m:
        return float(m.group(1)) / 100.0
    m = re.search(r"expense ratio.*?(\d+(?:\.\d+)?)\s*%", fees, re.I)
    if m:
        return float(m.group(1)) / 100.0
    m = re.search(r"(\d+(?:\.\d+)?)\s*%\s*expense", fees, re.I)
    if m:
        return float(m.group(1)) / 100.0
    # "0.09% expense ratio"
    m = re.search(r"(\d+(?:\.\d+)?)\s*%", fees)
    if m and "expense" in fees.lower():
        return float(m.group(1)) / 100.0
    return 0.0
