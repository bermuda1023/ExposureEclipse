# CALCULATIONS — the math (single source of truth)

All formulas live ONCE in `backend/app/services/calculations.py` +
`grouping.py`. Map, detail, pivot, and Excel export call the same functions.
Heaviest test coverage lives here (`backend/tests/test_calculations.py` +
`test_grouping.py`).

> Inputs are always `ExposureFactNormalized[]` from the provider (mock JSON
> or SQL cuts). Loading/caching is orthogonal — see
> [`MULTI_EDM.md`](./MULTI_EDM.md). Engineer overview:
> [`FOR_INTERNAL_DEVELOPERS.md`](./FOR_INTERNAL_DEVELOPERS.md).

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
- **Portfolio** = all **in-force BOUND** programmes when no selection target
  is supplied. Facts for those programmes are loaded in parallel (cache-aware)
  then combined under `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` when more than one
  programme is included.
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

## Hurricane impact (IBTrACS-driven)

`services/hurricane_impact.compute_impact(storm)` returns
`(impacts, footprint, inner_cone, outer_cone, outer_rings)`.

Filters applied to every storm fix before inclusion in the footprint:

- `wind_kt ≥ 64` (Cat 1 threshold)
- `status == "HU"` (true hurricane phase; excludes the extratropical "EX"
  phase where IBTrACS reports a much larger Rmax that isn't a hurricane
  wind field — Michael 2018 jumps from 15 nm to 120 nm post-EX)
- `lat/lon` inside US bbox

**Rmax (eyewall)** uses IBTrACS `USA_RMW` if present, else Willoughby
(2006) parametric fallback `Rmax(km) = 46.6 · exp(-0.0155·V_ms + 0.0169·|lat|)`.

**R64 (hurricane-wind extent)** uses IBTrACS `USA_R64_{NE,SE,SW,NW}` per
quadrant. `r64_at_bearing(quads, bearing)` linearly interpolates between
adjacent quadrant centers (NE=45°, SE=135°, SW=225°, NW=315°) so any
bearing yields a smooth lopsided value. Fallback (pre-~2004 storms with
no R64): symmetric 2.5×Rmax.

**County capture** — for each candidate county within a generous bbox:

    bearing_to_county = compass bearing from eye to centroid
    threshold = r64_at_bearing(quads, bearing_to_county, fallback=2.5×Rmax)
    capture iff haversine(eye, centroid) ≤ threshold
                AND fix.wind_kt ≥ 85   # MIN_IMPACT_WIND_KT

**Tropical-storm field for industry loss** — `compute_impact(..., ts_field=True)`,
used by the industry-loss engine, backtest and calibration for historical
storms, also paints the 34–63 kt field. It reads the IBTrACS best-track
`USA_R34_*` / `USA_R50_*` quadrants and pins local wind to them with the same
`radii_wind_kt` profile the live NHC path uses. HU, TS and SS fixes count;
EX and LO fixes count only when the best track carries a 34 kt radius
(ASSUMPTION: Sandy 2012 came ashore as EX). A fix below 64 kt gets no R64 ring.
The drawn cone is unchanged (hurricane-force fixes only). Without this field,
Debby, Isaias, Helene, Delta and Zeta had 56–99% of their PCS county loss
outside the modelled footprint. With it, every event except Debby is under
33%, and most of what remains is flood or tornado (see §Post-event evidence).
The three USVI districts are not in us-atlas. They are added as fixed points
so Irma and Maria losses there can be scored.

**TIV join** — fact rows joined by `geography_id`, summed per county and
also indexed per `dataset_id` for the per-programme breakdown in the
right-rail impact detail view.

## Layered loss scenarios

`services/layer_calc.run_scenario(layers, …)` runs deterministic XOL math:

    ground_up_loss = tiv × damage_ratio        (or supplied directly)
    loss_to_layer  = max(0, min(gross − ded, limit))
    ceded_loss     = loss_to_layer × share

Stacked layers evaluate INDEPENDENTLY against the same gross loss (no
cumulative carry-over). The reinsurer's total payout is the sum of
`ceded_loss` across the stack; the cedent's net loss is
`ground_up_loss − total_ceded`.

`run_sweep(layers, tiv)` runs a default damage-ratio series
`(0.5%, 1%, 2%, 5%, 10%, 15%, 20%, 30%, 50%, 75%, 100%)` to produce a
payout curve. Reinstatements / aggregate limits / event-vs-occurrence
wording are out of scope for v1.

## Hurricane loss bands (frontend, user-driven)

The backend's `/impact` response returns TIV per county but **no damage
ratios** — the user owns the loss model. Two zustand stores combine in
the browser to produce the displayed loss band:

- `damageAssumptions` (`frontend/src/state/damageAssumptions.ts`) — per
  SSHWS category {`mean`, `sd`} percentages. `applyAssumption(tiv,
  windKt, byCategory)` looks up the category from `windKt`, then returns
  a `LossBand` of `{ mean, low, high }` with `low = mean - sd` and
  `high = mean + sd`, clamped to `[0, 100]`. Persists to localStorage.
- `countyOverrides` (`frontend/src/state/countyOverrides.ts`) — per
  `(stormId, geoid)` exposed-fraction in `[0, 1]`. Applied as a scalar
  multiplier on the county's TIV BEFORE the damage assumption runs.
  Auto-prunes any override that's been set to 100% (the default).

The displayed county loss is therefore:

    effective_tiv = tiv * exposed_fraction
    loss_band(category) = effective_tiv * { mean - sd, mean, mean + sd } / 100

Neither store is sent back to the backend; persistence is per browser
in v1. This band is for the user's selection (portfolio). The industry loss
below is computed on the backend.

### Trained category defaults

The `custom` defaults are trained on the 15 PCS events
(`backend/scripts/train_category_damage.py`, output
`mockdata/damage_assumptions/sshws_calibrated.json`). The panel's own model
is linear in the six ratios:

    loss_county = TIV × Σ_c areaFraction_c × DR_c        c = TS, Cat 1 … Cat 5

so it is fitted with the curve-calibration machinery
(`services/curve_fit.py`: county + event-total log error, sqrt(loss)
weights, materiality censoring, ridge to the insured KCC category mean,
monotone in category, leave-one-storm-out). Inputs:

- `areaFraction_c` from `compute_impact` on the historical track, multiplier
  2.5, **no** tropical-storm field: exactly the bands the panel receives.
  The R34/R50 field reshapes the wind outside the eyewall, so a table fitted
  on it under-prices the panel (Irma 27 vs 46 $B).
- Loss = PCS county loss summed over residential, commercial and auto,
  on-levelled to the TIV date. TIV = the supplied 2026 book, all three
  segments. Maria (Puerto Rico / USVI) has no TIV and drops out.
- TS is held at 0.04%, the fit on the tropical-storm field (2,706 counties).
  On the panel field TS is only the fringe of a major's footprint (9
  counties), where PCS loss is surge and flood and the free fit pools TS
  with Cat 1. ASSUMPTION.
- Cat 5 has no county where it is the largest slice. It keeps the KCC
  shape, scaled by the Cat 4 fit / prior (0.69), and borrows Cat 4's sigma.
  ASSUMPTION.

SD is the spread of a storm's summed loss when the storm is priced by the
table fitted without it: per category, the sqrt(loss)-weighted RMS log error
of held-out event × category cells (≥ $25M reported), turned into the SD of
a lognormal with the fitted mean: `SD = mean × sqrt(exp(σ²) − 1)`.

| Category | Mean % | SD % | σ (log) | Counties | KCC insured % |
|---|---|---|---|---|---|
| TS | 0.04 | 0.06 | pooled 1.11 | 9 | 0.07 |
| Cat 1 | 1.0 | 1.4 | 1.06 | 140 | 0.58 |
| Cat 2 | 1.4 | 1.6 | 0.93 | 31 | 2.04 |
| Cat 3 | 3.3 | 2.5 | 0.67 | 15 | 6.47 |
| Cat 4 | 14.6 | 9.5 | 0.59 | 13 | 21.2 |
| Cat 5 | 28.2 | 18.3 | Cat 4 | 0 | 40.8 |

Reading it:
- **Insured on modelled wind.** The ratios are insured loss over total TIV,
  keyed on this app's marine-wind categories. That wind runs about 1.4× hot
  over land (§Post-event evidence), so a modelled Cat 3 county mostly saw
  Cat 1–2 on the ground. That is why Cat 2–4 sit below vendor ground-up
  curves.
- **Uncertainty falls as category rises.** σ ≈ 1 at TS–Cat 2 (a storm can
  come in at a third or three times the mean) and ≈ 0.6 at Cat 3–4. Low-
  category loss is driven by things a wind table cannot see: flood,
  tornadoes, the size of the wind field.
- **Event totals.** In-sample on the panel field: Ian 0.96, Laura 0.93,
  Milton 0.84, Irma 0.72, Michael 0.70 of on-levelled PCS. Flood events read
  low (Ida 0.24, Helene 0.21, Florence 0.41, Sally 0.46, Delta 0.23), and so
  does most of Isaias and Debby, whose loss is outside the hurricane-force
  field. Broad weak storms read high (Beryl 2.1, Zeta 2.0).

The stored table is migrated to these defaults only when it still equals the
pre-calibration hand-set values; edited tables are kept.

### PCS-calibrated chip

`model = "pcs"` uses the backend's default calibrated curve set instead of a
category table. `blendCalibratedCurve` weights the residential / commercial /
auto curves by `fit.bookMix` (0.478 / 0.491 / 0.031 on the supplied book).
Each county's speed bins are priced at their midpoint with the same transform
as the backend (`calibratedLandMph` = `damage_curves.land_mph`, then linear
between band midpoints, zero at 39 mph land), and
`SD = mean × sqrt(exp(sigmaLogEvent²) − 1)`. The curve was fitted on the
tropical-storm field (`ts_field=True`), the panel receives the radii-free
field; inside hurricane force they agree, so the difference is confined to
the TS fringe. ASSUMPTION. Without a calibrated set loaded the chip falls back
to the typed table.

## Industry loss (backend, calibrated)

`services/event_loss.py`, served by `POST /api/hurricanes/{id}/industry-loss`.
For each county in the storm's wind field and each segment
(`RESIDENTIAL`, `COMMERCIAL`, `AUTO`):

    loss[seg] = exposedFraction × TIV[seg] × Σ_b areaFraction_b × insuredDR[seg](land_mph(mph_b))

`land_mph` is `mph_b × windFactor` for vendor sets; calibrated sets add the
observed-wind shape (§Observed-wind calibration).

- `areaFraction_b` = share of the county polygon whose peak local wind is in
  10 mph band `b`, from `compute_impact` `speed_bins`. `mph_b` is the band
  midpoint. Same wind field as the impact panel, live or historical.
- **Marine to land.** IBTrACS / NHC intensity, and so the whole wind field, is
  the 1-minute sustained wind over open water. Form V-1 curves are defined on
  wind over land. `windFactor` (default 0.80, ASSUMPTION: published
  marine-to-open-terrain ratios are 0.83–0.87, eyewall airport observations
  about 0.75) converts it. Leaving it out roughly doubled Ian: with no
  conversion and no deductible KCC gave about $204B.
- `TIV[seg]` = supplied industry TIV vintage for the storm year
  (`industry_tiv/<year>.csv`), else the built-in Industry book (no auto).
- `DR[seg]` = curve set (`services/damage_curves.py`), linear between the
  Form V-1 band midpoints (45.5 … 165.5 mph over land), zero at 39 mph.
  Built-ins are Form V-1 AIR / KCC / RMS. ASSUMPTION until calibrated:
  commercial = residential curve, auto = 15% of it.
- **Insured, not ground-up.** Vendor curves are ground-up. Each segment's
  deductible (fraction of TIV; ASSUMPTION residential 1.3% ≈ 2% of Cov A,
  commercial 3%, auto 3%) is applied per location, with location DR ~
  Beta(mean = county DR, precision 9): `insuredDR = E[max(0, X − d)]`.
  Calibrated sets are fitted to insured loss directly, so they carry no
  deductible.

**Uncertainty.** The point estimate is the mean of a lognormal. County bands
use `sigmaLogCounty`, segment and event bands use `sigmaLogEvent`:

    median = mean × exp(−σ²/2);  P10/P90 = median × exp(∓1.2816 σ)

Event bands are not the sum of county bands (that would assume every county
misses in the same direction). Calibrated sets carry fitted sigmas; built-ins
use 0.9 (county) and 0.45 (event), both assumptions.

### Calibration against supplied PCS losses

`services/curve_fit.py` + `scripts/calibrate_damage_curves.py`. Per segment,
each reported county loss in an event is an observation
`(TIV, {band: areaFraction}, actual)`. Parameters are `θ_b = log DR_b`:

    J = mean_i(w_i · r_i²) + α · mean_e(R_e²) + λ · mean_b((θ_b − prior_b)²)
    r_i = log(model_i + ε_i) − log(actual_i + ε_i)    county error
    R_e = log(Σ model) − log(Σ actual) per event       event-total error

- `w_i ∝ sqrt(actual_i)` (normalised to mean 1), `ε_i` = 0.01% of TIV,
  `α = 1`, `λ = 0.05`, prior = KCC after its deductible. All assumptions,
  overridable on the CLI (`--wind-factor` too).
- Each county's wind mix becomes per-node weights through the same
  `windFactor` interpolation the engine uses, so model loss stays linear in
  the curve values.
- Projected gradient descent; after each step DR is projected to a
  non-decreasing curve (pool-adjacent-violators) inside [1e-5, 1].
- With ≥ 2 events every event is re-fitted out (leave-one-event-out).
  `sigmaLogCounty` = holdout county log-RMS (floor 0.25). `sigmaLogEvent` =
  holdout event log-RMS once ≥ 3 events exist (floor 0.15), else 0.45.

County matching (`services/loss_calibration.py`): reported loss outside the
modelled wind field is a **footprint miss** and reported loss with no TIV
is an **exposure gap**. Both are excluded from the fit and listed in the
backtest. A county missing from the loss file counts as unknown, not zero: it
is left out of the county scoring, but its modelled loss stays in the event
total. Unallocated
state loss (PCS "County Not Available") is in the event totals, and so in
`R_e`, but never in a county error.

**Below-materiality rows (PCS noise).** PCS spreads small, often round
amounts over barely touched counties: $5k, $15k, $20k and $40k are the most
common values. In most events 50–75% of positive county rows are at or below
$250k, and they hold only 0.1–5% of the dollars. Read as exact, they imply
damage ratios orders of magnitude too low and drag the low-wind bands down.
A row is **below materiality** when its on-levelled loss is under $250k, or it
has fewer than 25 claims when the source carries counts (ASSUMPTION, both
`MATERIALITY_*` in `loss_calibration.py`). Reported zeros are included.
Such a row is interval-censored: the true loss is only known to be in
`[0, U]` with `U = max(reported, $250k)`, so

    r_i = max(0, log(model_i + ε_i) − log(U_i + ε_i))

It costs nothing while the model stays under `U`, and is penalised like any
other row above it. The rows stay in every event total. They are excluded from
`countyLogRms`, the holdout county sigma and `impliedDrByBand`, and are
flagged `belowMateriality` in the backtest.

PCS basis caveat: PCS includes private-market flood and surge and excludes
NFIP and LAE, while the modelled loss is wind only. Flood-dominated events
therefore read as wind underestimates. `--exclude-flood` drops counties where
the modelled peak is under 64 kt, no ASOS station saw 34 kt sustained, and
there are 2 or more flood reports or riverine high-water marks. Otherwise,
leave whole events out with `--events`.

### Post-event evidence

`backend/scripts/build_event_evidence.py` writes
`mockdata/event_evidence/<stormId>.json` for each event with losses. It is
served through `services/event_evidence.py` into the backtest. Evidence is
diagnostic and never changes a loss. It covers the states with reported loss,
from 12 h before the track comes within 250 nm of one of their counties to
48 h after it leaves.

- **IEM ASOS**: peak sustained wind (2-min) and peak gust per station, after QC:
  - a sustained value above the same report's gust is dropped;
  - a sustained value with no gust, and every gust, needs a report within 90 minutes at ≥ 60% of it.

  The modelled wind at the same point comes from the same engine (`compute_impact` with one pseudo county per station). A station whose record stops within 3 h of closest approach, while the model has ≥ 64 kt there, is a probable outage and is left out of the bias.
- **NCEI Storm Events**: tornado, flood (flash flood, flood, heavy rain), surge (storm surge/tide, coastal flood) and wind reports, with the NWS property-damage estimate. Zone reports are mapped to counties through the NWS zone–county correlation file, with damage split evenly across the zone's counties.
- **USGS STN**: surveyed high-water marks per county: coastal vs riverine, and the maximum height above ground.

**Wind bias** = median over stations of `observed sustained / (modelled × windFactor)`.
Only stations where either value is ≥ 30 kt count. The backtest also splits
out-of-field dollars by the first reported peril in that county, in the order
tornado, flood, surge, wind (`footprintMissByPeril`).

Findings across the 15 PCS events, on the built-in book TIV (2026-10). Columns:
- *obs / model* is the ASOS bias over all qualifying stations.
- *> 50 kt* is the same ratio where the modelled land wind is above 50 kt.
- *KCC / PCS* is the KCC modelled total over the on-levelled PCS total.
- *Out of field* is the share of PCS county dollars outside the wind field, with its leading reported perils.

| Storm | obs / model | > 50 kt | stations | KCC / PCS | Out of field (leading perils) |
|---|---|---|---|---|---|
| Beryl 2024 | 0.80 | 0.77 | 30 | 0.85 | 14% (no report 8%, tornado 3%) |
| Debby 2024 | 0.64 | – | 117 | 0.30 | 80% (flood 25%, tornado 21%, wind 17%) |
| Florence 2018 | 0.61 | 0.59 | 83 | 0.28 | 33% (flood 29%) |
| Isaias 2020 | 0.62 | 0.72 | 181 | 2.90 | 13% (wind 7%) |
| Ida 2021 | 0.66 | 0.57 | 99 | 0.17 | 23% (flood 18%) |
| Ian 2022 | 0.73 | 0.67 | 144 | 1.46 | 1% |
| Helene 2024 | 0.70 | 0.50 | 236 | 0.38 | 29% (flood 18%, wind 7%) |
| Irma 2017 | 0.78 | 0.69 | 136 | 0.55 | 3% |
| Laura 2020 | 0.87 | 0.56 | 38 | 0.57 | 6% |
| Michael 2018 | 0.68 | 0.69 | 205 | 1.13 | 5% |
| Milton 2024 | 0.75 | 0.70 | 70 | 1.00 | 0.5% (PCS supplied in GBP, converted at 1.3247) |
| Maria 2017 | (2 usable; PR network failed) | | 2 | 1.24 | 0% |
| Sally 2020 | 0.72 | 1.05 | 31 | 0.39 | 15% (flood 5%) |
| Delta 2020 | 0.90 | 0.86 | 34 | 0.12 | 26% (flood 8%, 9 stations at TS force outside the field) |
| Zeta 2020 | 0.72 | 0.55 | 131 | 2.33 | 27% (wind 22%) |

What it says:
- **The modelled land wind runs hot: about 1.4× airport observations in a typical event.** The obs / model median is 0.72, over a range of 0.61–0.90. About 4% of that is 2-min versus 1-min averaging, and failed anemometers pull the observed peaks down a little. The rest is real: `windFactor` 0.80 plus the radii profile overstate open-terrain wind inland. The vendor curves therefore see too much wind and need a lower curve to compensate. A calibrated set absorbs the average.
- **The event-to-event spread is the nuance.** With damage rising roughly as wind^5, a 0.61 versus 0.90 bias is a factor of about 7 in loss. Florence, Isaias, Debby and Ida, slow or weakening storms with broad wind fields, have the most over-modelled wind. Delta and Laura, compact landfalling majors, have the least. `calibrate_damage_curves.py --wind-correction evidence` scales each event's wind by its bias relative to the all-event median, clamped to 0.7–1.3. The curve then learns vulnerability rather than one storm's wind-field error.
- **Most remaining out-of-field loss is flood or tornado, not missing wind.** Florence, Ida, Helene and Debby carry 18–29% of their dollars in counties with flood reports or riverine high-water marks. Debby adds 21% under tornadoes. No wind curve should fit these.
- **Underestimates are flood events.** Florence, Ida, Helene and Debby all read below 0.4 even with the full wind field. Delta at 0.12 is the exception: it is a wind-field size problem, because 9 stations saw tropical-storm-force wind with no modelled wind.

Sources not yet integrated:
- NHC Tropical Cyclone Report station tables: official peaks, including stations that failed in ASOS.
- HRD / H*Wind and HAFS analysed surface wind fields.
- FCMP and Texas Tech portable towers.
- ERA5 10 m gusts, for coverage away from airports.
- MRMS and Stage IV rainfall, to put a number on flood.
- NWS Damage Assessment Toolkit surveys: tornado tracks and straight-line wind.
- FEMA Individual Assistance and NFIP claims by county, to split flood from wind.

### Observed-wind calibration (default curve set)

`services/wind_calibration.py`, used by `calibrate_damage_curves.py
--wind-model observed` (the default). The evidence above showed the flat
`windFactor` is wrong in shape, not just level: weak storms are under-
converted and strong cores over-converted. Over 2,126 usable ASOS stations
(not a probable outage, modelled ≥ 34 kt; observed 1-minute = 1.05 × 2-minute
sustained), observed land / modelled marine is

    ratio(m) = A × max(floor, (m / 64 kt)^b),  A = 0.513, b = −0.358, floor = 0.47 / A

0.64 at 34 kt, 0.56 at 50 kt, flat at 0.47 from about 83 kt. The floor is the
median ratio of the stations modelled ≥ 83 kt: a power law keeps cutting the
cores, where failed anemometers bias the record low. The curve axis stays
anchored at `windFactor` 0.80 at 64 kt, so only the shape is taken:

    land_mph = windFactor × marine_mph × max(windFloor, (marine_mph / 73.6)^windExponent)

Leave-one-station-out log RMS of the land wind: 0.36 with flat 0.80, 0.28 with
the shape. It applies to every storm, live included.

**County correction (opt-in, `observedWind=true`).** For a historical storm,
each station's log residual against the shape is shrunk to a storm mean
(`n / (n + 5)`) and the deviations are kernel-smoothed onto county centroids
(Gaussian, 40 km, clamped ±0.5 in log). It brings station error to 0.24 and
the holdout county log RMS from 1.79 to 1.69, but makes loss-weighted event
error worse (0.82 → 0.91): ±20% wind is about 2.5× loss through the curve,
and station detail is not yet more predictive of PCS loss than the smooth
field. Off by default; the backtest and industry-loss endpoints report what
was applied in `observedWind`.

**Smoothing and tail.** Monotone projection alone leaves plateaus and cliffs.
`--smooth` penalises the second difference of log DR; holdout all-segment log
RMS was 0.969 at 0, 0.940 at 0.5, 0.922 at 2 and 5, so 2 is the default
(ASSUMPTION). Bands holding under 0.05% of the exposure (about 120 mph land
and up) cannot be identified; smoothing alone extrapolated residential to 96%
at 165 mph. Those bands follow the KCC insured prior's shape, scaled at the
last supported band (`--tail-min-weight`, as for Cat 5 in the panel table).

#### Segment-model comparison (2026-10-20)

We tested whether the 15-event PCS set supports extra segment parameters,
rather than assuming that separate residential / commercial / auto curves are
better. Maria has no matching TIV, so 14 events can be scored. Every fold left
one whole event out and refitted all loss parameters on the other 13, with the
same observed-wind transform, on-levelling, flood exclusion, KCC insured prior,
smoothness, tail rule and materiality censoring used by the shipped calibration.
The shared prior is the current-book-TIV-weighted mean of the three insured KCC
priors. In the 16-parameter alternative, each segment level is estimated only
from the training folds' segment event totals, weighted by sqrt(loss).

| Model | Parameters | Event log RMS | Event log RMS, sqrt(loss)-weighted | Material county log RMS |
|---|---:|---:|---:|---:|
| One shared curve | 13 | 0.941 | **0.707** | **1.649** |
| Shared curve + segment level | 16 | 0.936 | 0.711 | 1.632 |
| Separate segment curves | 39 | **0.922** | 0.708 | 1.652 |

The separate curves improve the unweighted event score by only 0.019 (2.1%),
slightly worsen the loss-weighted event and county scores, and beat the shared
curve on only 6 of 14 held-out events. A paired event bootstrap puts the 95%
interval for the event-RMS change at `[-0.057, +0.028]`; the segment-level
model's interval is `[-0.021, +0.016]`. Both span no improvement. Commercial
event RMS improves (1.518 → 1.285), but residential (0.855 → 0.898) and auto
(0.833 → 0.849) worsen, so that result is not broad-based.

**Decision:** this sample does not validate additional segment complexity. Do
not add another per-segment parameterisation or claim segment vulnerability is
identified from these events. The existing wire shape and calibrated set stay
unchanged; reassess when more independent events or segment-specific exposure
vintages are available. ASSUMPTION: the paired bootstrap treats events as the
independent units and describes sampling uncertainty, not future catastrophe
uncertainty.

Shipped set `calibrated-20261020` (`--exclude-flood`), insured DR %:

| Land mph | 45.5 | 55.5 | 65.5 | 75.5 | 85.5 | 95.5 | 105.5 | 115.5 | 135.5 | 165.5 |
|---|---|---|---|---|---|---|---|---|---|---|
| Residential | 0.04 | 0.20 | 0.83 | 2.35 | 5.41 | 10.95 | 18.7 | 28.0 | 47.6 | 79.9 |
| Commercial | 0.01 | 0.08 | 0.47 | 1.67 | 4.23 | 8.20 | 13.0 | 18.3 | 32.1 | 54.8 |
| Auto | 0.10 | 0.29 | 0.79 | 1.92 | 4.10 | 7.67 | 11.5 | 13.4 | 24.6 | 45.7 |

90% of the exposure-weighted wind sits in the first two bands, so the curve is
tightly pinned below ~75 mph land and leans on the prior above ~110.
`sigmaLogEvent` 1.03 (loss-weighted 0.79), `sigmaLogCounty` 1.66.

All-segment event totals, counties in the wind field, on-levelled PCS $B,
model fitted **without** that storm / with it:

| Storm | PCS | Unseen | Ratio | In-sample |
|---|---|---|---|---|
| Ian | 57.0 | 80.9 | 1.42 | 1.21 |
| Irma | 39.2 | 28.0 | 0.71 | 0.75 |
| Ida | 28.8 | 9.7 | 0.34 | 0.38 |
| Milton | 25.5 | 29.0 | 1.14 | 1.09 |
| Michael | 18.2 | 20.6 | 1.13 | 1.08 |
| Laura | 15.8 | 15.8 | 1.00 | 0.96 |
| Helene | 11.9 | 8.9 | 0.75 | 0.78 |
| Florence | 4.5 | 4.1 | 0.92 | 0.94 |
| Sally | 4.3 | 2.6 | 0.61 | 0.65 |
| Zeta | 3.5 | 16.6 | 4.71 | 3.95 |
| Beryl | 3.0 | 9.6 | 3.20 | 2.86 |
| Delta | 2.1 | 0.9 | 0.44 | 0.48 |
| Isaias | 2.1 | 15.6 | 7.55 | 5.62 |
| Debby | 0.5 | 1.6 | 3.56 | 2.71 |

Median observed / shaped-model wind by storm (all stations; ≥ 64 kt modelled):
Sally 1.13 / 1.81, Delta 1.25 / 1.49, Beryl 1.31 / 1.34, Milton 1.16 / 1.21,
Irma 1.09 / 1.16, Laura 1.20 / 0.99; Isaias 0.95, Zeta 1.01, Ida 0.94,
Debby 0.94, Helene 1.01 / 0.90. Reading the misses:

- **Landfalling majors are good.** Laura, Michael, Milton, Florence within
  ±15% unseen; Irma and Ian within the event sigma. Ian is high because one
  storm dominates the high bands: refitted without it, those bands lean on
  the prior.
- **Under: wind under-modelled.** Sally (stalled over Pensacola) and Delta
  had core stations at 1.5–1.8× the model. The county correction recovers
  part of this; it stays opt-in because it hurts other storms more.
- **Under: flood in PCS.** Ida (Louisiana plus north-east flash flood) and
  Helene (Appalachian flood) have winds on the shape. PCS includes private
  flood; the curve is wind only.
- **Over: weak storms over dense exposure.** Isaias (NY / NJ / CT), Zeta
  (New Orleans, Atlanta), Beryl (Houston) and Debby put 50–65 mph over very
  large TIV. Their winds match the shape (Beryl even ran above it), so the
  miss is vulnerability: low-wind damage per dollar is lower in these events
  than in Florida fringe counties of majors, which set the low bands.
  Candidate fixes: an event-size / demand-surge covariate, or a regional
  low-wind vulnerability term.

### On-levelling industry losses

`services/onlevel.py`. A PCS loss is priced in event-year dollars on the
event-year exposure. The industry TIV is valued at its own date: a supplied
vintage uses its `asOfDate`, defaulting to July 1 of the vintage year, and the
built-in book uses 2026-01-01. Every reported row is therefore scaled by the
growth in insured value in its county and segment:

    onLevelLoss = reportedLoss x V(target) / V(eventDate)

The damage ratio is not trended; that is what calibration learns. `V` is
built from public indices in `mockdata/onlevel/`, baked by
`backend/scripts/build_onlevel_indices.py`:

| Segment | V | Why |
|---|---|---|
| RESIDENTIAL | HU × (0.55 PPI residential inputs + 0.45 state construction pay) | units × replacement cost; contents and ALE are a share of Coverage A |
| COMMERCIAL | 0.62 × EMP × (0.55 PPI nonres inputs + 0.45 construction pay) + 0.38 × county payroll | building follows floor space × build cost; contents and BI are declared values that follow economic activity |
| AUTO | POP × CPI used cars and trucks | vehicles follow people; comprehensive pays actual cash value |

The inputs are:
- HU and POP: Census PEP July-1 estimates, with the 2010- and 2020-based series chain-linked at 2020.
- EMP and payroll: BLS QCEW private-sector annual averages.
- Construction pay: QCEW NAICS 23 average annual pay by state.
- PPI and CPI: FRED monthly series, read at the event month and the target month.

Annual values sit at mid-year and are interpolated linearly. Past the newest
year they are extrapolated at the last growth rate for at most 1.5 years.
After the newest month, monthly series hold their latest value.

House prices and GDP deflators are not used, because land is not insured and
insured value is replacement cost.

Each component falls back from county to state to flat (1.0), and the level
used is reported:
- A county with fewer than 500 private employees uses state employment and payroll.
- Connecticut's pre-2022 counties use state values, because the Census and QCEW replaced them with planning regions.
- Puerto Rico and USVI unit counts are held flat. This is an ASSUMPTION: Census municipio housing has no pre-2020 series, and the stock barely grew after Maria. Their own construction pay and the national cost indices still apply.
- Unallocated state rows use the state factor.

ASSUMPTIONS:
- The 55/45 materials/labour split.
- The 62/38 commercial building/contents+BI split, which is the built-in book's mix.
- New stock is assumed to be as vulnerable as the stock it adds to. Newer code-built homes are stronger, so the on-levelled loss slightly overstates.

`mockdata/onlevel/adjustments.csv` (template `adjustments.example.csv`) holds
optional analyst multipliers by storm, geography and segment, applied after the
index. An example is taking out Florida assignment-of-benefits litigation
creep that the 2019 and 2022–23 reforms would not repeat today. Every
adjustment used is listed in the response.

The factors are applied by default in `POST /api/hurricanes/{id}/industry-loss`
(`onLevel: false` to switch off), in the backtest (`?onLevel=false`), and in
`calibrate_damage_curves.py` (`--no-onlevel`). Reported totals stay visible as
`actuals.onLevel.reportedTotal`.

## Hazard climatology blend (tornado + hail)

Naive KDE of SPC point reports produces an obvious population-density
artifact — OKC, DFW, Atlanta, the I-35 corridor light up because reports
require humans to file them (Doswell 2007, Anderson et al. 2007).
Per-city deflation is the wrong fix — it trades urban DOTS for urban
HOLES at any city the deflator misses.

The shipped approach is a **climatology blend** that combines biased
point-history with a bias-free meteorology-based prior:

1. **Wide-kernel KDE of real SPC reports** (sigma 0.7°). Wider than the
   visual grid step (0.2°) so any single-city cluster dilutes across
   its ~50 mi region rather than forming a dot. Reports are weighted
   by:
   - Recency — tornado: 0.5× (1950) → 2.0× (2025); hail: 0.7× (1955) → 1.3× (2025).
   - Magnitude — tornado: EF3+ get `1 + 0.5·max(0, mag-2)` boost;
     hail: stones > 1″ get `1 + 0.5·(diam_in - 1)`, capped at 2.5×.

2. **Smooth climatology prior** (`backend/scripts/_climatology.py`).
   Encodes the published environmental-frequency surfaces as a bag of
   Gaussian anchors:
   - Tornado anchors from Brooks et al. 2003 + Tippett et al. 2015 mean-
     annual EF1+ density maps (Tornado Alley, Dixie Alley, FL sea-breeze,
     Plains).
   - Hail anchors from Cintineo et al. 2012 + Allen & Tippett 2015
     hail-day climatology (Hail Alley, Black Hills upslope, TX
     Panhandle).
   These have zero reporting bias because they're derived from
   atmospheric ingredients (CAPE × storm-relative helicity × shear), not
   point reports.

3. **Normalised blend** — each surface is normalised to its own max,
   then combined as:

        blended = 0.60 * climatology + 0.40 * historical

   Output is a 0-100 hazard index per cell. The climatology dominates
   so the surface has no urban artifacts of either sign; the historical
   40% lets local real-data deviations move the surface where they're
   physically meaningful (Black Hills hail, central-Florida tornado).

Wildfire uses the same KDE machinery on the WFIGS perimeter CSV but
**without** a climatology prior — WFIGS perimeters come from satellite
+ agency tracking (not point reports), so the bias is the opposite of
SPC reports (slightly biased AWAY from population since forests aren't
where people live densely). Each fire is weighted by acres burned,
capped at 300k per fire so mega-events don't blanket a region.

The build scripts (`backend/scripts/build_{tornado,hail,wildfire}_grid.py`)
emit `mockdata/hazard_*_grid.json` with `{stepDeg, cells}` shape. Re-bake
when the upstream shapefile updates or you change a tuning constant.

## Live wildfire overlay

`GET /api/wildfire/active` is a live-data endpoint distinct from the pre-baked
hazard grid above. It stitches two real sources at request time and applies
its own clustering pipeline. See `docs/API.md §Live wildfire overlay` for the
full request/response shape.

### Source 1: WFIGS burn-area perimeters

NIFC/WFIGS publishes the authoritative current fire perimeters via an ArcGIS
FeatureServer (no API key). Raw IR-mapped polygons can carry 60 000+ vertices
per fire; the service requests server-side generalisation (`maxAllowableOffset`
in degrees, default 0.005° ≈ 550 m) before serialisation, reducing payload
~70× with negligible shape distortion at mapping scales.

Only `attr_IncidentTypeCategory == "WF"` (wildfire) features are kept;
prescribed burns (`RX`) and other types are dropped.

### Source 2: NASA FIRMS satellite thermal anomalies

VIIRS 375 m (S-NPP + NOAA-20) and MODIS 1 km NRT products are fetched from
the FIRMS area CSV API. The API caps a single request at 5 consecutive days.
To support look-backs up to 30 days, the service chains consecutive ≤5-day
windows (most-recent window uses the FIRMS "last N days" form; earlier windows
supply an explicit `start_date`).

Requires `FIRMS_MAP_KEY` (free registration). Without the key the heat layer
returns empty; WFIGS perimeters are unaffected.

Confidence filtering: VIIRS reports `low/nominal/high`; MODIS reports 0–100
(mapped to `low < 30`, `nominal < 80`, `high ≥ 80`). Default filter is
`nominal`; `minFrp` drops detections below a fire-radiative-power threshold
(MW).

### Clustering: grid connected-components

Raw FIRMS detections are gridded at 0.02° (~2.2 km) and grouped into spatial
clusters via 8-connected component labelling (flood-fill). Each occupied cell
is a node; two cells are connected if they share any face or corner (8-way).

A component whose cell count is < `minCells` OR whose detection count is
< `minDetections` is discarded. This removes persistent point sources
(industrial flares, gas stacks) which appear in FIRMS as a single cell with
high detection counts but zero spatial spread.

The UI's **All / Small+ / Med+ / Large+** control maps to these thresholds:

| UI label | `minCells` | `minDetections` |
|---|---|---|
| All | 1 | 1 |
| Small+ | 2 | 4 |
| Med+ | 3 | 15 |
| Large+ | 5 | 40 |

Source: `MIN_SIZE_PARAMS` in `frontend/src/state/liveWildfire.ts`; parameters
are passed to the backend on every `GET /api/wildfire/active` call.

### Heat-shape footprint tracing (marching edges)

For each qualifying cluster, the service traces the outer boundary of the
**union of occupied grid cells** at 0.01° (~1.1 km, ≈ VIIRS pixel scale)
rather than computing a convex hull. This preserves concavities and unburned
interior gaps (ridges, green islands inside a perimeter) — features that matter
for exposure analysis.

Algorithm:

1. Assign each occupied cell four directed boundary half-edges (one per
   exposed face, oriented so the burned area lies on the left — CCW outer
   convention).
2. Walk the half-edge graph to extract closed rings.
3. Simplify collinear staircase vertices, then scale integer grid coordinates
   to lon/lat.
4. Classify and nest the rings (below), then emit GeoJSON `Polygon` (one outer
   ring plus ≥0 hole rings) or `MultiPolygon` (disconnected burned patches).

Fallback: if the marching-edge trace yields a degenerate result (< 4 vertices),
the service falls back to Andrew's monotone-chain convex hull over the cluster
points.

### Ring nesting (signed area)

Because the tracer keeps the burned area on the left, orientation alone
classifies a ring exactly: positive signed area (CCW) is an outer boundary,
negative (CW) is an unburned interior pocket. Each pocket is then assigned to
the smallest-area outer ring containing it, which satisfies RFC 7946 §3.1.6
winding and hole containment.

**Do not classify by ray-casting a ring vertex.** Every traced vertex sits on
the grid lattice, and two cells touching only at a corner share that exact
vertex — a point where point-in-polygon is undefined. Deciding nesting that
way misfiled disjoint lobes of a diagonal fire front as holes and silently
dropped their TIV from the rollup (a diagonal 8-cell front lost 2 cells, 25%
of its burned area). The containment probe therefore uses a point half a cell
to the *right* of a hole edge's midpoint — off-lattice, and inside the
unburned pocket by construction.

A pocket that cannot be placed under any outer ring is left filled rather than
discarded: over-stating burned area is the safe direction for an exposure
number, under-stating it is not.

### Display thinning

A 10-day CONUS FIRMS pull can exceed 50 000 detection points. The full point
set is used for shape construction; only the returned `activeFires` point list
is thinned to at most 8 000 points (evenly strided) for rendering. The
`counts.activeFiresTotal` field records the pre-thin count; `counts.activeFires`
records the displayed count. Heat shapes are built before thinning and are
therefore complete.

Shapes are capped separately at 2 000, keeping the largest by detection count.
At `minCells = 1` every isolated detection becomes its own polygon, so a
fire-season CONUS pull can otherwise emit tens of thousands. Truncation is
reported in `notes[]`.

## Wildfire exposed TIV (synthetic point method)

`POST /api/wildfire/exposure` reports TIV inside a fire polygon broken down by
client. See also `docs/API.md §POST /api/wildfire/exposure`.

**The result is labelled `synthetic: true` because the v1 exposure data plane
is county-aggregated.** The facts files carry no location coordinates — the
finest grain available is the county, and each county holds many rows (one per
peril × occupancy × construction × … segment). As shipped that is 3 956 COUNTY
rows over 1 184 distinct counties across the 7 in-portfolio datasets.

### Combining rows to a per-county TIV (rules 3+4)

Rows are folded to `(client, county)` before any point is synthesised:

1. Sum within a peril — a peril's rows are disjoint segments, so summing them
   is the correct combination at this grain.
2. **Take the max across perils *and* across treaty years** for the same
   client. Never sum. A cedent carrying WS+EQ+CS on one EDM, or renewing the
   same slot in consecutive years, appears as several datasets under one
   `cedentName`; summing reported it at a multiple of its real exposure.
   Measured on the shipped mock plane, Farmers Group in LA County (`06037`)
   summed to USD 14.60bn against a correct max of USD 9.10bn — a **1.60×
   overstatement** that fed straight into the XOL layer calc.

This is CLAUDE.md rules 3+4 applied at the finest grain this plane has.

If the rows span more than one currency they are not combinable (rule 5): the
rollup is reported as 0 with an entry in `warnings[]` rather than silently
mixed.

### Synthetic location generation

For each `(client, county)` TIV from the step above:

1. Look up the county centroid from the us-atlas TopoJSON index
   (`county_centroids()` in `hurricane_impact.py`).
2. Generate `_POINTS_PER_COUNTY = 4` deterministic jitter offsets using
   SHA-1 of `"{client}:{geoid}:{i}"`. The jitter radius is ±0.10° (~11 km).
3. Assign each synthetic point `tiv / 4` and the cedent name as `client`.

The county centroid plus deterministic jitter ensures the same polygon always
returns the same TIV (no random sampling), making the output auditable and
reproducible for any given data cut.

### Combining several selected fires

`combined` in the response is the union across every submitted polygon with
each synthetic location counted **once**. Selecting an official perimeter
together with the heat shape covering the same fire is the natural thing for
an underwriter to do, and summing the per-polygon totals would double-count
every location in the overlap. Clients must use `combined` rather than summing
`results`.

### Point-in-polygon test

A spatial grid index (cell size 0.5°) limits candidate testing to points
whose cell overlaps the polygon's bounding box. The polygon test uses the
ray-casting (even-odd) algorithm; multi-ring polygons with holes correctly
exclude interior hole regions.

### Accuracy characterisation

Because county TIV is distributed as 4 points within the county bounding area:

- A small fire that clips only part of a county will capture either 0 or a
  multiple of `tiv/4`, depending on whether any of the 4 synthetic points fall
  inside the perimeter. The error is bounded by one county's TIV (the largest
  partially-intersected county).
- A large fire spanning many complete counties will be accurate to within the
  partial-county error at each edge county.

**This is an estimation method, not a precise exposure report.** It is
appropriate for preliminary triage of fire exposure; it is not a substitute
for running a real location-level accumulation query.

### Resolution floor — when a zero means "unmeasurable"

4 points scattered over a ±0.10° box put one synthetic location every

```
resolution_deg2 = (2 × 0.10)² / 4 = 0.01 deg²
```

so a polygon smaller than roughly 0.01 deg² expects **fewer than one point**
even when it sits directly over dense exposure. Its result is structurally zero,
and that zero carries no information about the exposure underneath it.

This bites the flood inundation layer specifically. A modelled extent is river
corridors, not areas: measured on a Houston bbox, the whole extent was
8×10⁻⁵ deg² against a 0.72 deg² viewport — roughly 1/100th of the floor.
`POST /api/flood/inundation/exposure` therefore compares the dissolved extent
area against `wildfire_exposure.resolution_deg2()` and sets `belowResolution` on
the response; the UI renders "not measurable" in place of the `$0` an
underwriter would otherwise read as "no exposure here". Wildfire perimeters and
NWS alert polygons are both well above the floor, so they are unaffected.

The floor is computed from `_POINTS_PER_COUNTY` and `_JITTER_DEG` rather than
written down, so it follows the generator automatically. Real location-level
data (see *Upgrade path*) removes the floor entirely.

### Upgrade path

`_load_locations()` in `backend/app/services/wildfire_exposure.py` is the
documented single swap point. Replace its county-fact iteration with a
query against individual-location data (lat/lon, TIV, cedent); the
point-in-polygon rollup below that function is unchanged.
