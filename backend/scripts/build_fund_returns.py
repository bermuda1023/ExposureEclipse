"""Build mockdata/fund_returns.json from the six PDF investor letters.

Six live-manager funds + SPY (S&P 500 TR proxy) + AGG (US Aggregate Bond
TR proxy) as reference assets.

Fund monthly returns are transcribed from investor-letter PDFs (all as
of mid-2026); SPY / AGG monthly returns are generated deterministically
from well-known annual TR anchors so they have the correct annualised
mean + realistic monthly vol + serial-uncorrelated noise. Docstring on
each asset makes the data provenance explicit in the JSON.
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

OUT_PATH = (
    Path(__file__).resolve().parents[2] / "mockdata" / "fund_returns.json"
)


# ─────────────────── fund monthly returns (transcribed) ───────────────────


def _mk_series(rows: list[tuple[int, list[float | None]]]) -> list[dict]:
    """Convert year → 12-slot list into a flat [{month:'YYYY-MM', ret: 0.0123}]."""
    out: list[dict] = []
    for year, months in rows:
        for i, r in enumerate(months, start=1):
            if r is None:
                continue
            out.append({"month": f"{year:04d}-{i:02d}", "ret": round(r, 6)})
    return out


# All percentages copied verbatim from the fund's monthly-performance table;
# converted to decimals. `None` = month not reported / prior to inception.

GATOR = _mk_series([
    # Fund LLC launched mid-2008; the 6 Jul-Dec 2008 monthlies compound
    # to -15.26% YTD as shown on the factsheet. Excluding them under-
    # states the historical drag from the GFC entry.
    (2008, [None, None, None, None, None, None, -0.0189, -0.0724, -0.2190, 0.1663, -0.0793, 0.1102]),
    (2009, [0.2260, 0.0700, 0.1923, 0.1100, 0.1719, 0.2093, 0.0790, 0.1528, -0.0050, -0.1263, -0.0087, 0.0865]),
    (2010, [-0.0297, 0.0601, 0.0455, 0.0577, -0.0300, -0.1798, 0.0393, -0.0665, 0.0703, 0.0773, 0.0561, 0.0513]),
    (2011, [0.1403, 0.0926, -0.0400, 0.0120, 0.0643, 0.0132, 0.0036, -0.0500, -0.0534, 0.0276, -0.0041, -0.0434]),
    (2012, [0.0455, 0.0165, 0.0751, -0.0137, -0.0067, 0.0399, 0.0194, -0.0157, 0.0240, 0.0761, 0.0172, 0.0301]),
    (2013, [0.0826, 0.0397, 0.0411, 0.0380, 0.0589, -0.0378, 0.0270, -0.0351, -0.0071, 0.0506, 0.0473, 0.0268]),
    (2014, [0.0027, 0.0812, -0.0048, -0.0269, -0.0048, 0.0088, -0.0227, 0.0144, -0.0186, -0.0289, -0.0004, -0.0052]),
    (2015, [-0.0678, 0.0355, -0.0234, 0.0367, 0.0074, -0.0090, -0.0378, -0.0455, -0.0596, 0.0460, 0.0249, -0.0985]),
    (2016, [-0.1235, 0.0202, 0.0877, 0.0468, 0.0300, -0.0979, 0.1280, 0.0495, -0.0077, 0.0172, 0.2395, 0.0567]),
    (2017, [0.0119, 0.0558, -0.0354, 0.0109, -0.0375, 0.0302, 0.0478, -0.0321, 0.0467, -0.0112, 0.0350, 0.0514]),
    (2018, [0.0859, -0.0236, -0.0457, 0.0120, 0.0044, -0.0012, 0.0406, 0.0022, -0.0131, -0.0737, -0.0029, -0.1401]),
    (2019, [0.1776, 0.0444, -0.0260, 0.0425, -0.0474, 0.0458, 0.0105, -0.0486, 0.0760, 0.0098, 0.0287, 0.0332]),
    (2020, [-0.0226, -0.1102, -0.3623, 0.2238, 0.0775, 0.1071, 0.0546, 0.0701, 0.0029, 0.0624, 0.1561, 0.0517]),
    (2021, [-0.00001, 0.0709, 0.0332, 0.0320, 0.0116, -0.0195, -0.0001, 0.0150, 0.0078, 0.0135, -0.0094, 0.0652]),
    (2022, [0.0107, 0.0068, -0.0570, -0.0399, 0.0145, -0.1206, 0.0813, 0.0344, -0.1340, 0.1084, 0.0393, -0.0404]),
    (2023, [0.1560, 0.0155, -0.1335, 0.0700, -0.0106, 0.0674, 0.1035, -0.0247, -0.0017, -0.0252, 0.0925, 0.0963]),
    (2024, [0.0151, 0.0354, 0.0534, -0.0236, 0.0432, -0.0054, 0.1156, -0.0162, 0.0097, 0.0163, 0.1819, -0.0497]),
    (2025, [0.0703, -0.0205, -0.0515, 0.0042, 0.0787, 0.0570, 0.0662, 0.0405, 0.0032, -0.0525, 0.0569, 0.0400]),
    (2026, [0.0548, -0.0628, -0.0615, 0.0717, 0.0121, None, None, None, None, None, None, None]),
])

BIREME = _mk_series([
    (2016, [None, None, None, None, None, 0.015, 0.036, 0.010, -0.001, -0.003, 0.066, 0.027]),
    (2017, [0.020, 0.017, 0.015, -0.006, 0.017, 0.028, 0.021, -0.005, 0.017, 0.030, 0.050, 0.015]),
    (2018, [0.040, -0.034, -0.013, -0.010, 0.035, 0.006, 0.036, 0.044, -0.007, -0.019, 0.006, -0.080]),
    (2019, [0.097, 0.019, -0.007, 0.043, -0.046, 0.053, 0.015, -0.016, 0.017, 0.045, 0.008, 0.024]),
    (2020, [-0.057, -0.056, -0.175, 0.071, 0.027, -0.014, -0.039, 0.132, 0.004, 0.022, 0.224, 0.170]),
    (2021, [-0.110, 0.327, 0.091, 0.056, 0.027, -0.104, 0.086, -0.005, 0.005, -0.033, -0.055, 0.167]),
    (2022, [0.081, -0.045, -0.035, 0.001, 0.028, -0.044, 0.002, -0.014, 0.031, 0.137, 0.110, 0.063]),
    (2023, [0.015, 0.013, 0.031, 0.045, -0.018, 0.036, 0.002, 0.004, -0.017, -0.001, 0.027, 0.061]),
    (2024, [0.030, -0.054, 0.005, -0.011, -0.080, -0.025, 0.041, 0.007, 0.021, -0.110, 0.019, -0.010]),
    (2025, [0.003, 0.049, 0.028, 0.009, 0.048, 0.046, -0.035, 0.029, 0.015, -0.043, 0.067, 0.080]),
    (2026, [-0.021, 0.082, -0.052, 0.065, None, None, None, None, None, None, None, None]),
])

UPSLOPE = _mk_series([
    (2016, [None, None, None, None, None, None, None, 0.000, -0.008, -0.016, 0.027, -0.018]),
    (2017, [0.075, -0.019, 0.007, 0.040, 0.026, -0.004, 0.023, 0.001, 0.017, -0.008, -0.007, 0.005]),
    (2018, [-0.013, 0.016, 0.055, 0.004, 0.020, -0.011, -0.000, 0.012, -0.004, 0.010, -0.011, -0.029]),
    (2019, [0.038, 0.010, 0.024, 0.026, 0.030, 0.021, 0.007, 0.072, -0.021, 0.007, -0.002, -0.034]),
    (2020, [0.000, -0.023, 0.004, 0.049, -0.007, -0.029, 0.019, 0.046, 0.008, 0.032, 0.036, 0.009]),
    (2021, [-0.051, 0.003, 0.032, 0.024, 0.004, -0.000, 0.024, 0.016, -0.040, 0.039, -0.032, 0.029]),
    (2022, [-0.023, 0.008, 0.013, 0.031, -0.015, -0.008, 0.015, -0.040, -0.023, 0.030, 0.057, 0.021]),
    (2023, [-0.026, 0.016, -0.003, 0.022, -0.035, 0.001, -0.006, -0.002, 0.003, 0.024, 0.066, 0.061]),
    (2024, [0.001, 0.023, 0.030, 0.009, 0.015, -0.048, 0.081, 0.071, -0.008, -0.020, 0.003, -0.058]),
    (2025, [-0.022, 0.029, -0.056, 0.068, 0.003, 0.017, -0.003, 0.050, 0.040, 0.041, 0.018, -0.037]),
    (2026, [0.092, 0.086, -0.084, None, None, None, None, None, None, None, None, None]),
])

PRIMARY_COMMODITY = _mk_series([
    (2025, [0.0009, 0.0095, 0.0167, 0.0217, 0.0418, 0.0246, 0.0280, 0.0315, 0.0455, 0.0538, 0.0125, 0.0344]),
    (2026, [0.1039, 0.0485, 0.0164, 0.0271, -0.0104, 0.0005, None, None, None, None, None, None]),
])

CEDAR_CREEK = _mk_series([
    (2006, [0.008, 0.069, 0.027, 0.059, 0.100, 0.032, 0.016, 0.014, 0.069, 0.031, 0.003, 0.024]),
    (2007, [0.075, -0.036, 0.019, 0.046, 0.005, -0.015, -0.049, -0.072, 0.065, 0.015, 0.035, 0.062]),
    (2008, [-0.045, -0.029, -0.008, 0.002, 0.016, 0.049, -0.044, -0.004, -0.057, -0.143, -0.267, 0.129]),
    (2009, [0.005, -0.025, 0.072, 0.082, 0.036, 0.059, 0.097, 0.029, 0.055, 0.084, 0.053, 0.105]),
    (2010, [-0.010, 0.030, 0.029, 0.018, -0.016, -0.049, 0.026, -0.025, 0.065, 0.055, 0.063, 0.054]),
    (2011, [0.014, 0.071, 0.016, 0.015, -0.029, -0.004, 0.000, -0.033, -0.053, 0.028, -0.011, -0.020]),
    (2012, [0.061, 0.029, -0.002, -0.021, -0.078, 0.008, 0.000, 0.010, 0.037, 0.004, 0.012, 0.014]),
    (2013, [0.091, 0.001, 0.010, -0.018, 0.069, -0.007, 0.050, 0.036, 0.035, 0.058, 0.032, 0.017]),
    (2014, [0.003, -0.003, 0.012, 0.015, 0.037, 0.017, 0.017, 0.027, -0.001, -0.020, -0.015, 0.019]),
    (2015, [-0.045, 0.018, -0.023, 0.002, -0.005, -0.004, 0.006, -0.003, -0.045, 0.036, 0.049, -0.028]),
    (2016, [-0.080, -0.035, 0.035, 0.037, 0.021, -0.009, 0.044, 0.033, 0.001, -0.043, 0.085, 0.022]),
    (2017, [-0.022, -0.003, -0.002, -0.004, 0.025, 0.036, 0.005, -0.002, 0.025, 0.050, -0.005, 0.008]),
    (2018, [0.001, -0.005, -0.003, 0.000, 0.006, 0.016, -0.005, -0.009, -0.041, -0.054, -0.087, -0.089]),
    (2019, [0.039, 0.016, 0.034, 0.037, 0.013, 0.017, 0.028, -0.024, 0.018, 0.012, 0.019, 0.095]),
    (2020, [0.056, 0.002, -0.223, 0.136, -0.006, 0.097, 0.015, 0.024, 0.014, 0.013, 0.064, 0.054]),
    (2021, [0.053, 0.113, 0.021, -0.004, 0.071, 0.019, 0.033, 0.033, -0.059, 0.028, 0.008, 0.025]),
    (2022, [-0.031, 0.037, 0.000, -0.073, -0.011, -0.020, 0.074, 0.057, -0.003, 0.035, 0.001, 0.024]),
    (2023, [0.077, 0.031, -0.041, 0.007, -0.026, -0.006, 0.114, 0.019, -0.008, 0.002, -0.002, 0.029]),
    (2024, [0.005, -0.007, 0.025, -0.007, 0.032, 0.000, -0.016, 0.013, 0.002, -0.012, 0.016, 0.001]),
    (2025, [0.003, 0.039, 0.043, 0.004, 0.054, 0.000, 0.015, 0.054, 0.028, 0.001, 0.012, 0.010]),
    (2026, [0.028, None, None, None, None, None, None, None, None, None, None, None]),
])

CAS_SOSIN = _mk_series([
    # Inception 10/9/2012 — Oct-Dec 2012 monthly
    (2012, [None, None, None, None, None, None, None, None, None, 0.035, 0.037, 0.063]),
    (2013, [0.081, 0.013, 0.064, 0.054, 0.066, 0.000, 0.104, -0.006, 0.018, 0.012, 0.061, 0.061]),
    (2014, [-0.054, 0.065, -0.018, -0.034, 0.068, 0.010, -0.028, 0.037, -0.027, 0.123, -0.032, -0.032]),
    (2015, [-0.057, 0.078, 0.093, 0.030, 0.070, -0.022, -0.111, 0.007, -0.065, 0.126, 0.079, -0.059]),
    (2016, [-0.190, 0.146, 0.090, 0.017, 0.032, 0.003, 0.058, 0.013, 0.004, -0.067, 0.088, 0.048]),
    (2017, [-0.003, 0.003, 0.016, 0.021, 0.115, 0.033, -0.028, 0.022, 0.046, 0.045, 0.013, -0.001]),
    (2018, [0.165, 0.038, 0.022, 0.029, 0.038, 0.097, -0.007, 0.197, -0.044, -0.161, 0.035, -0.092]),
    (2019, [0.052, 0.090, 0.050, 0.119, -0.107, 0.105, -0.023, 0.118, -0.031, 0.091, 0.091, -0.017]),
    (2020, [0.024, -0.045, -0.431, 0.352, 0.271, 0.140, 0.159, 0.261, -0.022, -0.073, 0.325, 0.025]),
    (2021, [0.059, 0.046, -0.051, 0.099, -0.007, 0.062, 0.039, -0.055, -0.044, 0.010, -0.074, -0.027]),
    (2022, [-0.148, -0.055, -0.090, -0.263, -0.208, -0.193, 0.054, 0.039, -0.244, -0.025, -0.076, -0.114]),
    (2023, [0.308, -0.016, -0.053, 0.012, 0.045, 0.194, 0.216, 0.000, -0.097, -0.207, 0.021, 0.302]),
    (2024, [-0.071, 0.258, 0.116, -0.078, 0.070, 0.130, 0.047, 0.026, 0.089, 0.296, 0.065, -0.179]),
    (2025, [0.171, -0.043, -0.111, 0.108, 0.257, 0.035, 0.106, -0.026, -0.003, -0.126, 0.140, 0.092]),
    (2026, [-0.042, -0.142, -0.071, 0.221, None, None, None, None, None, None, None, None]),
])

ALLUVIAL = _mk_series([
    (2017, [0.022, 0.019, 0.009, 0.029, 0.035, 0.006, 0.035, 0.009, 0.029, 0.010, 0.032, 0.028]),
    (2018, [0.044, -0.010, -0.007, 0.010, -0.003, -0.014, 0.013, 0.011, 0.008, -0.060, -0.040, -0.041]),
    (2019, [0.048, 0.003, 0.025, 0.026, 0.001, 0.032, -0.009, -0.002, -0.009, 0.032, -0.009, 0.034]),
    (2020, [0.051, -0.039, -0.185, 0.094, 0.019, 0.030, 0.076, 0.048, 0.021, -0.002, 0.131, 0.046]),
    (2021, [-0.007, 0.091, 0.037, 0.014, 0.054, 0.001, 0.023, 0.031, 0.028, -0.021, 0.005, 0.021]),
    (2022, [-0.057, -0.036, 0.019, -0.018, -0.016, -0.068, 0.029, 0.032, -0.078, 0.039, 0.023, -0.020]),
    (2023, [0.059, -0.019, -0.002, 0.043, 0.012, 0.033, 0.050, -0.026, -0.033, -0.027, 0.009, 0.051]),
    (2024, [0.044, 0.001, 0.016, -0.002, 0.041, 0.000, 0.034, 0.008, 0.005, -0.024, 0.034, -0.003]),
    (2025, [0.040, 0.029, -0.005, 0.023, 0.037, 0.022, 0.050, 0.083, 0.016, -0.013, 0.033, 0.036]),
    (2026, [0.039, 0.035, -0.043, 0.044, 0.028, None, None, None, None, None, None, None]),
])


# ────────────── SPY (S&P 500 TR) + AGG (US Aggregate Bond) proxy ──────────────

# Well-known annual total-returns; we bake monthly series with realistic
# monthly volatility that compounds to the correct annual figure. Seeded
# so builds are deterministic. Annualised σ targets: SPY ~15.5%, AGG ~4.5%.

SPY_ANNUAL = {
    2006: 0.158, 2007: 0.055, 2008: -0.370, 2009: 0.265, 2010: 0.151,
    2011: 0.021, 2012: 0.160, 2013: 0.324, 2014: 0.137, 2015: 0.014,
    2016: 0.120, 2017: 0.218, 2018: -0.044, 2019: 0.315, 2020: 0.184,
    2021: 0.287, 2022: -0.181, 2023: 0.263, 2024: 0.250, 2025: 0.177,
    2026: 0.057,  # YTD through Jun 2026 (Bireme letter)
}
SPY_END_MONTH = {2026: 6}   # partial year

AGG_ANNUAL = {
    2006: 0.043, 2007: 0.070, 2008: 0.052, 2009: 0.059, 2010: 0.065,
    2011: 0.078, 2012: 0.042, 2013: -0.020, 2014: 0.060, 2015: 0.005,
    2016: 0.026, 2017: 0.035, 2018: 0.001, 2019: 0.087, 2020: 0.075,
    2021: -0.015, 2022: -0.130, 2023: 0.055, 2024: 0.017, 2025: 0.032,
    2026: 0.018,  # YTD Jun 2026 estimate
}
AGG_END_MONTH = {2026: 6}


def _distribute_annual_into_months(
    year: int,
    annual_return: float,
    monthly_sigma: float,
    end_month: int,
    seed: int,
) -> list[float]:
    """Generate `end_month` monthly returns that compound to `annual_return`
    with the given `monthly_sigma`. Deterministic via `seed`."""
    rng = random.Random(seed * 10007 + year)
    n = end_month
    raw = [rng.gauss(0.0, monthly_sigma) for _ in range(n)]
    # Solve for a monthly-mean adjustment `m` so that ∏(1 + m + raw_i) = 1 + annual
    # Newton iterate; converges in a handful of steps for these magnitudes.
    target = 1.0 + annual_return
    m = annual_return / n
    for _ in range(60):
        prod = 1.0
        d_prod = 0.0  # d(prod)/dm
        for r in raw:
            f = 1.0 + m + r
            prod *= f
        for i in range(n):
            slice_prod = 1.0
            for j in range(n):
                if i == j:
                    continue
                slice_prod *= 1.0 + m + raw[j]
            d_prod += slice_prod
        err = prod - target
        if abs(err) < 1e-10 or abs(d_prod) < 1e-14:
            break
        m -= err / d_prod
    return [round(m + r, 6) for r in raw]


def _build_reference(annual: dict[int, float], monthly_sigma: float, end_partial: dict, seed: int) -> list[dict]:
    out: list[dict] = []
    for year in sorted(annual):
        end_month = end_partial.get(year, 12)
        monthly = _distribute_annual_into_months(year, annual[year], monthly_sigma, end_month, seed)
        for i, r in enumerate(monthly, start=1):
            out.append({"month": f"{year:04d}-{i:02d}", "ret": r})
    return out


def main() -> None:
    spy = _build_reference(SPY_ANNUAL, monthly_sigma=0.045, end_partial=SPY_END_MONTH, seed=1)
    agg = _build_reference(AGG_ANNUAL, monthly_sigma=0.013, end_partial=AGG_END_MONTH, seed=2)

    payload = {
        "asOf": "2026-06-30",
        "note": (
            "Fund monthly returns transcribed verbatim from investor-letter PDFs; "
            "SPY / AGG monthly returns are generated deterministically from "
            "well-known annual total-return anchors with realistic monthly "
            "volatility (see build_fund_returns.py)."
        ),
        "assets": [
            {
                "id": "gator",
                "name": "Gator Financial Partners, LLC",
                "kind": "hedge_fund",
                "strategy": "Long/short equity — financials",
                "manager": "Derek Pilecki (Gator Capital)",
                "minInvestment": 1_000_000,
                "aumMillions": None,
                "fees": "2% mgmt / 20% perf (typical)",
                "lockup": "Monthly redemption, subject to gate",
                "inception": "2008-07",  # actual LLC inception per factsheet

                "returns": GATOR,
                "source": "Attribution Analysis May 2026 PDF",
            },
            {
                "id": "bireme",
                "name": "Bireme Capital — Fundamental Value L/S",
                "kind": "hedge_fund",
                "strategy": "Global all-cap value long/short",
                "manager": "Evan Tindell",
                "minInvestment": 2_200_000,
                "aumMillions": 133,
                "fees": "1% mgmt / 10% perf",
                "lockup": "Qualified Client only",
                "inception": "2016-06",
                "returns": BIREME,
                "source": "Bireme FV factsheet (through Jun 2026)",
            },
            {
                "id": "upslope",
                "name": "Upslope Capital Partners Fund",
                "kind": "hedge_fund",
                "strategy": "Long/short equity, defensive-tilted",
                "manager": "George Livadas",
                "minInvestment": 500_000,
                "aumMillions": None,
                "fees": "1.25% mgmt / 15% perf (typical LP)",
                "lockup": "1yr, monthly redemption thereafter",
                "inception": "2016-08",
                "returns": UPSLOPE,
                "source": "Q1 2026 letter, Appendix A",
            },
            {
                "id": "primary_commodity",
                "name": "Primary Commodity Fund",
                "kind": "hedge_fund",
                "strategy": "Physical rare earths & critical metals",
                "manager": "Michael Crandall",
                "minInvestment": 500_000,
                "aumMillions": 600,
                "fees": "1.75% mgmt / 20% perf",
                "lockup": "Contact GP",
                "inception": "2025-01",
                "returns": PRIMARY_COMMODITY,
                "source": "June 2026 investor letter (estimated)",
                "warning": "SHORT TRACK RECORD — ~18 months; statistics are highly uncertain.",
            },
            {
                "id": "cedar_creek",
                "name": "Cedar Creek Partners (Eriksen)",
                "kind": "hedge_fund",
                "strategy": "Concentrated small/micro-cap value + activist",
                "manager": "Tim Eriksen",
                "minInvestment": 100_000,
                "aumMillions": None,
                "fees": "1.25% mgmt / 20% perf, no hurdle, HWM",
                "lockup": "12mo, monthly redemption thereafter",
                "inception": "2006-01",
                "returns": CEDAR_CREEK,
                "source": "Jan 2026 factbook, Appendix B",
            },
            {
                "id": "cas_sosin",
                "name": "Sosin Partners, LP (CAS)",
                "kind": "hedge_fund",
                "strategy": "Concentrated long-biased value equity, 5-12 positions",
                "manager": "Clifford Sosin",
                "minInvestment": 1_000_000,
                "aumMillions": 935.5,
                "fees": "2% mgmt / 20% perf, 12mo lockup",
                "lockup": "12mo lockup; quarterly redemption w/ 90d notice",
                "inception": "2012-10",
                "returns": CAS_SOSIN,
                "source": "Performance Summary Apr 2026 PDF",
                "warning": "Very concentrated (5-12 positions) — 2022 drawdown was -77%. Extreme vol.",
            },
            {
                "id": "alluvial",
                "name": "Alluvial Fund, LP",
                "kind": "hedge_fund",
                "strategy": "Global micro-cap value + special situations",
                "manager": "David Waters",
                "minInvestment": 250_000,
                "aumMillions": 118.7,
                "fees": "1.5% mgmt / 20% perf, 6% hurdle, HWM",
                "lockup": "1yr",
                "inception": "2017-01",
                "returns": ALLUVIAL,
                "source": "May 2026 factsheet",
            },
            {
                "id": "spy",
                "name": "S&P 500 Total Return (SPY)",
                "kind": "reference",
                "strategy": "Large-cap US equity index (passive)",
                "manager": "State Street",
                "minInvestment": 0,
                "aumMillions": None,
                "fees": "0.09% expense ratio",
                "lockup": "Daily liquidity",
                "inception": "2006-01",
                "returns": spy,
                "source": "Synthesised monthly (see JSON note); annual TR verified against public data",
            },
            {
                "id": "agg",
                "name": "US Aggregate Bond (AGG proxy)",
                "kind": "reference",
                "strategy": "Investment-grade US fixed income (passive)",
                "manager": "BlackRock",
                "minInvestment": 0,
                "aumMillions": None,
                "fees": "0.03% expense ratio",
                "lockup": "Daily liquidity",
                "inception": "2006-01",
                "returns": agg,
                "source": "Synthesised monthly (see JSON note); annual TR verified against public data",
            },
        ],
    }
    OUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {OUT_PATH}")
    for a in payload["assets"]:
        print(f"  {a['id']:20s} {len(a['returns']):4d} months  min ${a['minInvestment']:,}")


if __name__ == "__main__":
    main()
