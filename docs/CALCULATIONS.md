# CALCULATIONS — the math (single source of truth)

All formulas live ONCE in `backend/app/services/calculations.py` +
`grouping.py`. Map, detail, pivot, and Excel export call the same functions.
Heaviest test coverage lives here (`backend/tests/test_calculations.py` +
`test_grouping.py`).

## Universal principles

- **One source of truth.** Don't recompute a metric differently per surface.
- **No silent currency mixing.** Aggregations span only matching currencies,
  or an explicit conversion assumption is applied + surfaced via
  `WARN_CURRENCY_ASSUMED`.
- **`null`, not `0`, for "cannot compute."** Always pair with a warning code.
- **Divide-by-zero never raises** — return `None` + warning.
- **Aggregate, then divide.** Sum numerator and denominator at the target
  grain before taking ratios.

## Definitions

- **Selected deal** = the chosen `programmeId` / `chainId` / `chainIds[]` /
  `cedentId` (combined per its method).
- **Portfolio** = all programmes whose EDM has loaded facts (v1 = every
  programme with a fact file).
- **Geography TIV** = `Σ fact.tiv` for a given `geographyId` at the active
  `aggregationLevel`.
- **Current viewed grain** = ordered tuple of active grouping dimensions
  (geography level + every pivot/filter dim). CONTRACTS.md §13.

## TIV / location count

```
TIV(scope, key) = Σ fact.tiv     where fact matches scope + filters + key
LocationCount(scope, key) = Σ fact.location_count
```

## Deal Share of Portfolio in Geography → `DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY`

```
= SelectedDealGeographyTIV / PortfolioGeographyTIV
```
Denominator 0 or missing → `null`.

## Geography Share of Total Portfolio → `GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO`

```
= PortfolioGeographyTIV / TotalAllLoadedPortfolioTIV
```

## Selected Deal Geography Concentration → `SELECTED_DEAL_GEOGRAPHY_CONCENTRATION`

```
= SelectedDealGeographyTIV / TotalSelectedDealTIV
```

> The three "share" metrics answer different questions; UI labels must stay
> distinct. The tooltip's Active-metric block plus the listed shares below
> already reinforce this.

## Client Market Share → `CLIENT_MARKET_SHARE`

```
= ClientTIV / RMS_IED_IndustryTIV
```
- Denominator must match geography and, where available, occupancy segment.
- No matching IED geography → share = `null` + `WARN_IED_DENOMINATOR_MISSING`
  (per-feature warning).
- `UNKNOWN` occupancy never force-mapped — reported separately.

## YoY Change → `YOY_CHANGE` *(historical: now driven by `yoyMode`)*

```
yoyChange = (CurrentValue − PriorValue) / PriorValue
```

| Condition | `yoyStatus` | `yoyChange` |
|---|---|---|
| current & prior present, prior ≠ 0 | `OK` | computed |
| current present, prior missing | `NEW` | `null` |
| prior present, current missing | `REMOVED` | `null` |
| prior = 0 | `NA` | `null` |
| no prior selected | — | `null` + `WARN_PRIOR_DATASET_NOT_SELECTED` |

**`yoyMode` is a view modifier**: when `true` and a comparison is set, the
response's `metricValue` is replaced by `yoy_change(current_metric,
prior_metric)` at the same grain. The original metric value rides as `tiv` /
etc. and `priorMetricValue` carries the prior so the tooltip can show
current / prior / Δ / Δ%.

**Approximation for ratio metrics in v1**: the prior-period denominator uses
the CURRENT portfolio (we don't carry a prior portfolio in v1). TIV and
LOCATION_COUNT are exact. Surface the limitation when needed.

## Group combination at view grain

Default for multi-peril selections: `MAX_ACROSS_PERILS_AT_VIEW_GRAIN`.

```
For each group key g (= every active view dimension):
    combinedTIV(g) = MAX over distinct perils p of TIV(facts_p, g)
```

Examples (key = the grain):
- Viewing **State** → max per (state).
- Viewing **County + Occupancy** → max per (county, occupancy).

Rules:
- **Never sum** across distinct perils unless `SUM_DISTINCT_SEGMENTS` AND
  `distinctSegmentsConfirmed = true`.
- Max recomputed whenever the view grain changes.
- `SELECTED_EDM_AS_BASE`: exposure base = one EDM's TIV; others supply
  peril views only.
- `KEEP_PERILS_SEPARATE`: no combination; perils side by side.
- Location count under max-across-perils: **count of the EDM that supplied
  the max TIV** for that key (don't sum counts).

### Worked example

Members: WS, EQ, CS. Viewing by State:

| State | WS TIV | EQ TIV | CS TIV | combinedTIV (max) |
|---|---|---|---|---|
| FL | 12.4bn | 9.1bn | 7.8bn | **12.4bn** |
| CA | 3.0bn | 14.2bn | 2.1bn | **14.2bn** |

Summing would give FL = 29.3bn — overstated double-count. Max avoids it.

Asserted exactly by `backend/tests/test_grouping.py` against in-test fact
fixtures.

## Rounding & formatting

Calculations carry full precision. Round only for display (frontend) and in
export cells (raw values still available in the Raw Aggregated Data tab).
Ratios display as % to 1 decimal by default.

## Traceability

Every returned metric must be reconstructible from: source dataset(s) +
filters + this formula + currency (+ conversion assumption if any) +
combination method. The Excel export and tooltips expose enough of this to
audit a number.
