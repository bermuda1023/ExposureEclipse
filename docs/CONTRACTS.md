# CONTRACTS.md — Canonical Enums & Constants (Single Source of Truth)

> ⭐ **This file is authoritative.** Every enum value used on the wire (frontend ↔ backend)
> MUST come from here. If a value isn't here, it doesn't exist yet — add it here first,
> then implement. Frontend defines these as TS `const`/union types; backend as Python
> `Enum`/`Literal`. Keep both generated from or checked against this file.

## Conventions

- **Enum codes:** `UPPER_SNAKE_CASE` string literals on the wire (stable, language-neutral).
- **JSON field names:** `camelCase`.
- **Money:** numbers are in the dataset's currency, **no implicit conversion**. Always
  carry a `currency` (ISO 4217) alongside any monetary value.
- **Ratios/shares:** decimals in `[0,1]` (e.g. `0.182` = 18.2%). UI formats as %.
- **Missing/blocked values:** `null` for "not applicable / could not compute" — paired
  with a warning code explaining why. Never `0` as a stand-in for missing.

---

## 1. Metric keys (`MetricKey`)

What the map/tooltip/pivot can measure or color by. (For the underlying *measures* —
the raw value columns like Building/Contents/BI/EXPLIM — see §1b.)

| Code | Display label | Unit | Notes |
|---|---|---|---|
| `TIV` | Total Insured Value | money | Default metric; = Building + Contents + BI |
| `LOCATION_COUNT` | Location Count | integer | |
| `DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY` | Deal Share of Portfolio in Geography | ratio | deal geo TIV ÷ portfolio geo TIV |
| `GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO` | Geography Share of Total Portfolio | ratio | geo portfolio TIV ÷ total portfolio TIV |
| `SELECTED_DEAL_GEOGRAPHY_CONCENTRATION` | Selected Deal Geography Concentration | ratio | deal geo TIV ÷ deal total TIV |
| `CLIENT_MARKET_SHARE` | Client Market Share | ratio | client TIV ÷ RMS IED industry TIV |
| `YOY_CHANGE` | Year-over-Year Change | ratio (signed) | superseded in the UI by `yoyMode` (toggle) which wraps any selected metric; enum kept for back-compat |

## 1b. Measures (`Measure`) — raw value columns from ERT cuts

The numeric columns the ERT produces. Selectable as pivot/export measures; `TIV` is the
default exposure basis. See `ERT_OUTPUT_FORMAT.md`.

| Code | Display | Unit | Notes |
|---|---|---|---|
| `TIV` | TIV | money | = `BUILDING + CONTENTS + BI` |
| `BUILDING` | Building | money | TIV component |
| `CONTENTS` | Contents | money | TIV component |
| `BI` | Business Interruption | money | TIV component |
| `EXPLIM_GR` | Exposed Limit (Gross) | money | gross exposure basis |
| `EXPLIM_NET` | Exposed Limit (Net) | money | net exposure basis |
| `LOCATION_COUNT` | # Locations | integer | |
| `ACCOUNT_COUNT` | # Accounts | integer | policies/accounts |
| `INVALID_TIV` | Invalid TIV | money | data quality |
| `INVALID_COUNT` | # Invalid | integer | data quality |

**Exposure basis:** users may view on `TIV`, `EXPLIM_GR`, or `EXPLIM_NET`. Default `TIV`.
Every export/tooltip must state which basis a number uses.

## 2. Aggregation / geography levels (`AggregationLevel`)

Ordered coarse → fine.

| Code | Display | Geometry availability (v1) |
|---|---|---|
| `COUNTRY` | Country | Global |
| `STATE` | State / Admin-1 | US + major countries |
| `COUNTY` | County / Admin-2 | US selected states only (FL, TX, CA, NY) |
| `CRESTA` | CRESTA Zone | Where geometry exists |

`GeographyId` format: ISO-ish stable keys — `US`, `US-FL`, `US-FL-12086` (FIPS),
`CRESTA-US_01`. Document the exact scheme per level in `MAPBOX_SPEC.md`.

## 3. ERT status (`ErtStatus`)

| Code | Display label | Meaning |
|---|---|---|
| `ERT_NOT_FOUND` | ERT Not Found | No expected output tables exist |
| `ERT_PARTIAL` | ERT Partial | Some required tables missing |
| `ERT_READY` | ERT Ready | All v1-required tables present |
| `ERT_READY_PRIOR_RUN_DETECTED` | ERT Ready - Prior Run Detected | Ready, but outputs may be stale |
| `ERT_ERROR` | ERT Error | Detection or last run errored |

## 3b. Programme status (`ProgrammeStatus`)

Deal lifecycle. **In-force today** = `BOUND` AND `today ∈ [inceptionDate,
expiryDate]`. The "portfolio mode" view in the map / pivot / export
aggregates every in-force programme across all cedents.

| Code | Display | Counts in portfolio? |
|---|---|---|
| `BOUND` | Bound | yes (when dates in window) |
| `QUOTED` | Quoted | no |
| `DECLINED` | Declined | no |
| `NTU` | Not Taken Up | no |
| `EXPIRED` | Expired | no |

## 4. Dataset group combination methods (`CombinationMethod`)

| Code | Display | Behavior | Default? |
|---|---|---|---|
| `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` | Max across perils (at viewed grain) | Max TIV per group key = all active view dimensions | ✅ default |
| `SUM_DISTINCT_SEGMENTS` | Sum (distinct segments only) | Sum TIV; requires explicit user confirmation EDMs are distinct | |
| `SELECTED_EDM_AS_BASE` | Selected EDM as exposure base | One EDM = exposure base; others for peril views only | |
| `KEEP_PERILS_SEPARATE` | Keep perils separate | No combination; perils shown side by side | |
| `CUSTOM` | Custom (future) | Reserved, v2 | |

Any method other than `KEEP_PERILS_SEPARATE` on a multi-peril group emits
`WARN_DATASET_GROUP_MAX_ACROSS_PERILS` (or the relevant combination warning).

## 5. Peril codes (`Peril`)

Canonical = the real ERT codes (see `ERT_OUTPUT_FORMAT.md`). RMS-style aliases noted.

| Code | Display | Alias | Confidence |
|---|---|---|---|
| `EQ` | Earthquake | | high |
| `WS` | Windstorm (US hurricane) | `HU` | high |
| `CS` | Convective Storm (SCS) | `SCS` | high |
| `FL` | Flood | | high |
| `FR` | Fire | | high |
| `TR` | Terror | | high |
| `ALL` | All Perils (filter value only) | | — |

## 6. Occupancy (`Occupancy`, `OccupancyGroup`, `OccupancySegment`)

ERT carries an `Occupancy` (e.g. `Permanent`) and an `OccupancyGroup` (e.g. `Res-MFD`,
`Res-SFD`). For market-share segmentation these roll up to an `OccupancySegment`.

| `OccupancySegment` | Display | Notes |
|---|---|---|
| `RESIDENTIAL` | Residential | e.g. `Res-MFD`, `Res-SFD` |
| `COMMERCIAL` | Commercial | |
| `INDUSTRIAL` | Industrial | |
| `UNKNOWN` | Unknown | Shown separately, never force-mapped (OPEN_QUESTIONS #14) |

`OccupancyGroup` values are passed through from ERT (e.g. `Res-MFD`, `Res-SFD`, …) — the
full list comes from the data; do not hardcode an exhaustive set.

## 7. Background job status (`JobStatus`)

`queued` → `running` → `completed` | `failed` | `cancelled`. (lowercase on the wire)

## 8. Portfolio scope (`PortfolioScope`)

| Code | Display | Version |
|---|---|---|
| `ALL_LOADED_DATASETS` | All loaded datasets | v1 default |
| `BOUND_DEALS` | Bound deals only | v2 |
| `CUSTOM` | Custom selection | v2 |

## 9. YoY status flags (`YoyStatus`)

| Code | Meaning |
|---|---|
| `NEW` | Current exists, prior missing |
| `REMOVED` | Prior exists, current missing |
| `NA` | Prior is zero / not comparable |
| `OK` | Comparable, `yoyChange` is valid |

## 10. Warning codes (`WarningCode`)

Stable codes. UI renders `message`; logs/exports include `code`. Severity: `info | warn`.

| Code | Severity | Default message |
|---|---|---|
| `WARN_COUNTY_DATA_UNAVAILABLE` | warn | County-level data is not available for this dataset. Showing state-level results. |
| `WARN_CURRENCY_ASSUMED` | warn | Currency was manually assumed for this dataset. |
| `WARN_CURRENCY_MISMATCH` | warn | Selected datasets use different currencies. Provide a conversion assumption or compare separately. |
| `WARN_IED_DENOMINATOR_MISSING` | warn | Market share cannot be calculated; the RMS IED table has no matching geography. |
| `WARN_PRIOR_DATASET_NOT_SELECTED` | info | No prior-year dataset selected; YoY is unavailable. |
| `WARN_AGGREGATION_LEVEL_MISMATCH` | warn | Current and prior datasets differ in aggregation level; aggregated to the common level. |
| `WARN_DATASET_GROUP_MAX_ACROSS_PERILS` | info | This group contains multiple peril EDMs. Max-across-perils is used at the current viewed grain. |
| `WARN_DATASET_GROUP_SUMMED` | warn | This group sums TIV across EDMs marked as distinct segments. |
| `WARN_ERT_TABLES_PARTIAL` | warn | Some ERT output tables are missing; results may be incomplete. |
| `WARN_ERT_NOT_FOUND` | warn | No ERT output tables found for this dataset. |
| `WARN_MAP_GEOMETRY_MISSING` | info | Map geometry is unavailable for some features at this level. |
| `WARN_FILTERS_RETURN_NO_ROWS` | info | No exposure records match the current filters. |
| `WARN_EXPORT_TOO_LARGE` | warn | Export exceeds the size limit; refine filters or aggregation. |

Warning object shape:
```json
{ "code": "WARN_COUNTY_DATA_UNAVAILABLE", "severity": "warn", "message": "…", "context": { "geographyId": "US-FL" } }
```

## 11. Error codes (`ErrorCode`) — see `ERROR_HANDLING.md` for envelope

| Code | HTTP | User-facing? |
|---|---|---|
| `VALIDATION_ERROR` | 422 | yes |
| `DATASET_NOT_FOUND` | 404 | yes |
| `DATASET_GROUP_NOT_FOUND` | 404 | yes |
| `CURRENCY_MISMATCH` | 409 | yes |
| `PRIOR_DB_NOT_FOUND` | 404 | yes |
| `IED_GEOGRAPHY_MISSING` | 200* | yes (returned as warning + null metric, not a hard error) |
| `ERT_JOB_FAILED` | 200* | yes (job status = failed; not an HTTP error) |
| `JOB_NOT_FOUND` | 404 | yes |
| `EXPORT_TOO_LARGE` | 413 | yes |
| `INTERNAL_ERROR` | 500 | yes (generic) |

\* These are domain outcomes, not transport failures — they ride in the response body.

## 12. Currency

ISO 4217 codes (`USD`, `EUR`, `GBP`, …). No implicit conversion in v1. A "display currency"
or explicit conversion assumption is required to combine/compare mismatched currencies, and
that assumption must be surfaced (warning) and exported.

## 13. Combination/grain key definition

The **group key** for any aggregation = the ordered set of active view dimensions:
`[aggregationLevel geography] + [each grouping dimension in pivot/filter view]`.
Example viewing County + Occupancy + DistanceToCoast → key = `(countyId, occupancy, dtcBand)`.

## 14. Dimension band vocabularies (from real ERT — see `ERT_OUTPUT_FORMAT.md`)

These are canonical filter/pivot/breakdown values. Treat the *set* as data-driven where
noted (don't hardcode an exhaustive list the data may extend), but use these exact labels.

**Geocoding quality** (`GeocodingQuality`): `Coordinate`, `Street/Parcel`, `Postal code`,
`Block Group`.

**Distance to coast** (`DistanceToCoastBand`) — keep `a..g` prefix for sort:
`a=> At the Coast`, `b=> 0 - 0.5 Miles from Coast`, `c=> 0.5 - 1 Miles from Coast`,
`d=> 1.0 - 2 Miles from Coast`, `e=> 2.0 - 5 Miles from Coast`,
`f=> 5.0 - 10 Miles from Coast`, `g=> +10 Miles from Coast`.

**Year built** (`YearBuiltBand`): `1930 and before`, `1930 to 1960`, `1960 to 1980`,
`1980 to 2000`, `2000 to Present`, `Unknown`.

**Number of stories** (`NumberOfStoriesBand`): `(blank)`, `1-3 stories`, … *(data-driven —
confirm full band set, OPEN_QUESTIONS #27)*.

**Construction** (`ConstructionClass`): `Masonry`, `Reinforced`, `Wood`, … *(data-driven —
confirm full set incl. Steel/Other/Unknown)*.

## 15. Snapshot / portfolio name

`PORTNAME` (a.k.a. `Portname`) is the exposure-data snapshot date as `MMDDYYYY`
(e.g. `09302025` = 2025-09-30). It is the dataset's `ExposureDataCutoffDate` and the de-facto
portfolio label. Parse it to a date; display it ISO (`2025-09-30`).

## 16. Hurricane impact + R64 sourcing

`rmaxSource` per impacted county and per footprint point:

| Code | Source |
|---|---|
| `ibtracs` | NOAA IBTrACS `USA_RMW` (recon-measured) |
| `willoughby` | Willoughby (2006) parametric estimate fallback |

`r64Source` per impacted county and per footprint point:

| Code | Source |
|---|---|
| `ibtracs` | NOAA IBTrACS `USA_R64_{NE,SE,SW,NW}` mean of non-zero quadrants |
| `fallback` | symmetric 2.5×Rmax (used for pre-~2004 storms with no R64) |

## 17. Layer terms (`LayerTerms`)

One XOL layer's contract terms on the wire. See `docs/CALCULATIONS.md`
for the math.

| Field | Type | Notes |
|---|---|---|
| `deductible` | money | attachment point (ground-up $); ≥ 0 |
| `limit` | money | layer width; > 0; layer covers `[ded, ded+limit]` |
| `share` | ratio in `[0,1]` | reinsurer signed line on the layer |
| `name` | string \| null | display label (e.g. "1st XOL") |

## 18. Hazard overlay types (`HazardType`)

The pre-baked hazard grids served by `/api/hazards/{hazard}`.

| Code | Display | Source | UI visibility |
|---|---|---|---|
| `tornado` | Tornado | SPC SVRGIS 1950-2025 + Brooks/Tippett climatology blend | active chip |
| `hail` | Hail | SPC SVRGIS 1955-2025 + Cintineo/Allen-Tippett climatology blend | active chip |
| `wildfire` | Wildfire | WFIGS Interagency Perimeters 2020-present | endpoint live, chip hidden |

Tornado + hail use the climatology-blend pipeline (60% smooth prior + 40%
historical KDE) so the surface has no reporting-bias artifacts. Wildfire
uses acres-weighted KDE alone (perimeter data isn't human-reported, so it
has no population bias to correct). See `docs/CALCULATIONS.md §Hazard
climatology blend`.

The wildfire chip is currently hidden from `HazardOverlayControls` because
the WFIGS dataset only covers 2020-present, which skews the picture. The
backend grid + endpoint stay live — re-add the wildfire entry to the
`HAZARDS` array in `HazardOverlayControls.tsx` to bring the chip back.

## 19. Hurricane loss assumption stores

User-controlled inputs that turn an `/api/hurricanes/{id}/impact` response
into a probabilistic loss band. Both are zustand stores in the frontend,
persisted to localStorage; neither is sent back to the backend.

`DamageAssumption` (per SSHWS category):
| Field | Type | Range |
|---|---|---|
| `mean` | percent | `[0, 100]` |
| `sd` | percent | `[0, 100]` |

`CountyOverride` (per `(stormId, geoid)`):
| Field | Type | Range | Default |
|---|---|---|---|
| `exposedFraction` | ratio | `[0, 1]` | `1.0` (auto-pruned at 1.0) |

See `docs/CALCULATIONS.md §Hurricane loss bands` for how the two combine.
