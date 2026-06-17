# Calculation Rules — Exposure Eclipse

> These rules are the heart of the product. They must be implemented once, in
> `backend/app/services/calculations.py` + `grouping.py`, and reused by map, detail, pivot,
> and export so every surface agrees. **Heaviest test coverage lives here** (`TEST_PLAN.md`).
> Enum codes reference `CONTRACTS.md`.

## Universal principles

- **Single source of truth:** map, detail, pivot, and export call the *same* calc functions.
  Never recompute a metric differently per surface.
- **No silent currency mixing.** Aggregations span only matching currencies, or an explicit
  conversion assumption is applied and surfaced (`WARN_CURRENCY_ASSUMED`).
- **`null`, not `0`, for "cannot compute."** Always pair with a warning code.
- **Divide-by-zero is never an exception** — return `null` + warning, or a status flag.
- **Aggregate, then divide.** Sum numerator and denominator at the target grain before
  taking ratios (ratios are not averaged).

## Definitions

- **Selected deal** = the chosen `datasetId` or `datasetGroupId` (combined per its method).
- **Portfolio** = all datasets with `isIncludedInPortfolio = true` under the active
  `portfolioScope` (`ALL_LOADED_DATASETS` in v1).
- **Geography TIV** = TIV summed for a given `geographyId` at the active `aggregationLevel`.
- **Current viewed grain** = ordered set of all active grouping dimensions in the current
  view (geography level + every pivot/filter grouping dimension). See `CONTRACTS.md §13`.

---

## TIV

Read from ERT outputs (normalized fact). Aggregate only by explicit user-selected filters
and grouping dimensions. Never combine currencies silently.

```
TIV(scope, key) = Σ fact.TIV  where fact matches scope, filters, and group key
```

## Location count

```
LocationCount(scope, key) = Σ fact.LocationCount  (only where aggregation is valid)
```

## Deal Share of Portfolio in Geography  → `DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY`

```
= SelectedDealGeographyTIV / PortfolioGeographyTIV
```
*How large is this deal vs the loaded portfolio in the same geography?*
- Denominator 0 or missing → `null`.
- Both numerator/denominator at the **same** geography + grain.

## Geography Share of Total Portfolio  → `GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO`

```
= PortfolioGeographyTIV / TotalAllLoadedPortfolioTIV
```
*How concentrated is the loaded portfolio in this geography?*
- Total portfolio TIV 0 → `null`.

## Selected Deal Geography Concentration  → `SELECTED_DEAL_GEOGRAPHY_CONCENTRATION`

```
= SelectedDealGeographyTIV / TotalSelectedDealTIV
```
*How concentrated is this deal in this geography?*
- Deal total TIV 0 → `null`.

> These three answer different questions; UI labels and tooltips must keep them distinct
> (see `MAPBOX_SPEC.md` tooltip example).

## Client Market Share  → `CLIENT_MARKET_SHARE`

```
= ClientTIV / RMS_IED_IndustryTIV
```
- Denominator (IED) must match **geography** and, where available, **occupancy segment**.
- No matching IED geography → market share `null` + `WARN_IED_DENOMINATOR_MISSING`
  (returned in body, not an HTTP error).
- Segment handling: if computing per occupancy segment, use the matching IED segment;
  `UNKNOWN` occupancy is reported separately, never forced into a segment.

### Future QBE Net Market Share (v2)
```
= ClientTIV × QBESignedShare / RMS_IED_IndustryTIV
```
Requires Front Sheet/SRS signed share — **do not implement in v1.**

## Year-over-Year Change  → `YOY_CHANGE`

```
yoyChange = (CurrentValue − PriorValue) / PriorValue
```
Status flags (`YoyStatus`):

| Condition | `yoyStatus` | `yoyChange` |
|---|---|---|
| current & prior present, prior ≠ 0 | `OK` | computed |
| current present, prior missing | `NEW` | `null` |
| prior present, current missing | `REMOVED` | `null` |
| prior = 0 | `NA` | `null` |
| no prior dataset selected | — | `null` + `WARN_PRIOR_DATASET_NOT_SELECTED` |

Additional rules:
- **Aggregation level mismatch:** if current and prior expose different levels, aggregate
  both to the **common valid (coarser) level** before comparing; emit
  `WARN_AGGREGATION_LEVEL_MISMATCH`.
- **Currency mismatch:** block YoY unless a conversion assumption exists; emit
  `WARN_CURRENCY_MISMATCH` / `CURRENCY_MISMATCH`.

## Dataset Group: Max Across Perils at Current Viewed Grain

Default for multi-peril groups (`MAX_ACROSS_PERILS_AT_VIEW_GRAIN`).

```
For each group key g (= every active view dimension):
    combinedTIV(g) = MAX over member EDMs m of TIV(m, g)
```
Examples (key = the grain):
- Viewing **State** → max across perils per State.
- Viewing **County + Occupancy** → max across perils per (County, Occupancy).
- Viewing **County + Occupancy + DTC** → max per (County, Occupancy, DTC).

Rules:
- **Never sum** across peril EDMs unless `SUM_DISTINCT_SEGMENTS` and the user confirmed the
  EDMs are distinct exposure segments (`distinctSegmentsConfirmed = true`).
- Max is recomputed whenever the view grain changes (drill-down changes the key).
- `SELECTED_EDM_AS_BASE`: exposure base = one EDM's TIV; other EDMs only supply peril views.
- `KEEP_PERILS_SEPARATE`: no combination; perils rendered side by side.
- Location count under max-across-perils: report the location count **of the EDM that
  supplied the max TIV** for that key (do not sum counts across perils). State this in the
  export notes.

### Worked example (max-across-perils)
Members: WS, EQ, CS. Viewing by State.

| State | WS TIV | EQ TIV | CS TIV | combinedTIV (max) |
|---|---|---|---|---|
| FL | 12.4bn | 9.1bn | 7.8bn | **12.4bn** |
| CA | 3.0bn | 14.2bn | 2.1bn | **14.2bn** |

Summing would give FL = 29.3bn — overstated double-count. Max avoids it. ✅

## Rounding & formatting
- Calculations carry full precision; round only for **display** (frontend) and in export
  cells (keep raw values available in a Raw tab). Ratios display as % to 1 decimal by default.

## Traceability requirement
Every returned metric must be reconstructible from: source dataset(s) + filters + this
formula + currency (+ conversion assumption if any) + combination method. Export and
tooltips must expose enough of this to audit a number.
