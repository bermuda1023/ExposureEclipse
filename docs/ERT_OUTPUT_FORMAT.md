# ERT Output Format — Ground Truth (from `BER25_Proforma_ERT`)

> **Source of truth for the real ERT shape.** Reverse-engineered from screenshots of the
> production proforma workbook `BER25_Proforma_ERT` (Read-Only, modified 2025-02-06). These
> are the exact "cuts" the product must consume; the mock provider must emit the same shapes
> and the SQL provider must map onto them. Where a value/column is uncertain from the source
> it is marked **(confirm)** and tracked in `OPEN_QUESTIONS.md`.
>
> Note: the proforma is an **Excel** workbook whose cuts are produced by named
> `CALC.Get_*` functions. The *columns and vocabularies* below are the contract; the eventual
> SQL routine produces equivalent tables (naming TBD).

## Workbook context

- **File naming:** `BER25_Proforma_ERT` → `BER` = Bermuda, `25` = treaty year 2025.
- **`PORTNAME` / `Portname`:** the exposure-data snapshot date, e.g. `09302025` = 30 Sep 2025.
  This is the dataset's `ExposureDataCutoffDate` and effectively the "portfolio name".
- **Aggregation is a column,** not separate tables. Values seen: `Country`, `State`
  (expect also `Cresta`, future `County`). Filter on this column to get a level.
- **`CrestaName`:** `blank` / `No Cresta` in this proforma (no CRESTA detail present here).
- **Tabs (pipeline):** `Current_lookup`, `Previous_lookup` (← YoY prior), `Sequel_Import`,
  `Full Workings (2)`, `SRS_Import` (← SRS hook already exists), `GDPR Query`, `Spider`,
  `Spider_Summary`, `Spider_Datadump`, `Mapping`, `Sheet1`, `Issues`.

## Perils (as used across all cuts)

| Code | Display (best read) | Confidence |
|---|---|---|
| `EQ` | Earthquake | high |
| `WS` | Windstorm (US hurricane / tropical cyclone) | high |
| `CS` | Convective Storm (severe convective storm) | high |
| `FL` | Flood | high |
| `FR` | Fire | high |
| `TR` | Terror | high |

> ⚠️ The earlier draft used `HU`/`SCS`. Canonical codes are the ERT codes above:
> `HU`→`WS`, `SCS`→`CS`. See `CONTRACTS.md §5`.

## Measures (the value columns)

| Column | Meaning |
|---|---|
| `Building` | TIV — building component |
| `Contents` | TIV — contents component |
| `BI` | TIV — business interruption component |
| `TIV` | Total Insured Value = `Building + Contents + BI` |
| `#Location` / `#Locations` | count of locations |
| `#Account` | count of accounts/policies |
| `EXPLIM_GR` | Exposed Limit, **Gross** |
| `EXPLIM_NET` | Exposed Limit, **Net** |
| `GR` / `NET` (summary blocks) | shorthand for `EXPLIM_GR` / `EXPLIM_NET` |
| `Invalid_TIV` | TIV of records failing validation (data quality) |
| `#Invalid` | count of invalid/unmapped records |
| `WS_TIV` (DTC cut) | peril-specific TIV (windstorm) for the distance-to-coast cut |

## The cuts (output sections)

### 1. `CALC.Get_TIV_Summary` — TIV Summary
Geography × peril TIV, split into components, at each aggregation level.

`Aggregation | Country | CountryName | Statecode | StateName | CrestaName | Peril | Building | Contents | BI | …`

- Rows repeat per `Aggregation` (`Country`, then `State`, …).
- Geography seen: `US` / United States; states `LA, NC, SC, TX`.

### 2. `CALC.Get_Evolution` — Evolution (full-grain normalized; drives YoY)
The richest cut — the closest thing to `ExposureFactNormalized`.

`Invalid_TIV | Cresta_No(flag) | Country | CountryName | Statecode | StateName | CrestaName | Peril | Occupancy | OccupancyGroup | Building | Contents | BI | #Location | EXPLIM_GR | EXPLIM_NET`  (+ `Aggregation`)

- `Occupancy` seen: `Permanent`. `OccupancyGroup` seen: `Res-MFD`, `Res-SFD`.
- `Cresta_No` flag seen: `No Cresta`.

### 3. `CALC.Get_Construction_Summary` — Construction
`Construction | Peril | TIV | GR | NET`
- Construction classes seen: `Masonry`, `Reinforced` (concrete/masonry), `Wood`
  (expect also Steel / Other / Unknown — **confirm**).

### 4. `CALC.Get_YearBuilt_Summary` — Year Built
`YearBuilt | Peril | TIV | GR | NET`
- Bands: `1930 and (before)`, `1930 to 1960`, `1960 to 1980`, `1980 to 2000`,
  `2000 to Present`, `Unknown`.

### 5. `CALC.Get_NumberOfStories_Summary` — Number of Stories
`NumberOfStories | Peril | TIV | GR | NET`
- Bands seen: `(blank)`, `1-3 stories` (expect more bands — **confirm**).

### 6. `CALC.GET_Peril_Details` — Peril × Geocoding detail
`Portname | Peril | Geocoding | #Location | #Account | TIV | Invalid_TIV | #Invalid | EXPLIM_GR | EXPLIM_NET`
- Geocoding-resolution bands: `Coordinate`, `Street/Parcel`, `Postal code`, `Block Group`.
- Example resolution mix (one portfolio): Coordinate 68,225 · Street/Parcel 3,997 ·
  Postal code 1,023 · Block Group 127.

### 7. `CALC.Get_Distance_To_Coast` — Distance to Coast (WS-focused)
`DistanceToCoastRange | Country | State | #Locations | WS_TIV | EXPLIM_GR | EXPLIM_NET`
- Lettered bands (sortable): `a=> At the Coast`, `b=> 0 - 0.5 Miles from Coast`,
  `c=> 0.5 - 1 Miles from Coast`, `d=> 1.0 - 2 Miles from Coast`,
  `e=> 2.0 - 5 Miles from Coast`, `f=> 5.0 - 10 Miles from Coast`,
  `g=> +10 Miles from Coast`. Keep the `a..g` prefix for sort order.
- **Peril scope:** distance-to-coast exists for all perils in theory, but only matters for
  **`WS`** (storm surge + wind). The cut is therefore WS-focused (`WS_TIV`). Default the DTC
  view/metric to `WS`; if other perils are exposed later, label them as low-relevance.

### Header / Full Workings
`Aggregation | PORTNAME | RMSCountry | CountryName | Statecode | …` — carries the snapshot
date (`PORTNAME`) and RMS geography keys used to join the cuts.

## Implications for the build

- **`Peril` enum** = `EQ, WS, CS, FL, FR, TR` (+ `ALL` filter). Update everywhere.
- **TIV is composite:** store/serve `building`, `contents`, `bi`, and derived `tiv`. Allow
  metric/measure selection across them and across `EXPLIM_GR` / `EXPLIM_NET`.
- **Two exposure bases:** GR (gross) and NET. The app should let users pick GR vs NET vs TIV;
  default = TIV. Export must label which basis each number uses.
- **Aggregation discriminator:** providers filter the `Aggregation` column rather than
  selecting a table per level.
- **Data-quality columns are first-class:** surface `Invalid_TIV` / `#Invalid` (feeds a
  data-quality warning) — don't silently drop invalid records.
- **Dimension vocabularies above are canonical** for filters, pivot fields, and breakdowns —
  mirror them in `CONTRACTS.md` and the mock fixtures.
- **`ExpectedERTTable` registry** = the seven `CALC.Get_*` cuts (TableType names below).

### TableType ↔ cut mapping (for `ExpectedERTTable`)

| TableType | Cut / function |
|---|---|
| `TIV_SUMMARY` | `CALC.Get_TIV_Summary` |
| `EVOLUTION` | `CALC.Get_Evolution` |
| `CONSTRUCTION_SUMMARY` | `CALC.Get_Construction_Summary` |
| `YEARBUILT_SUMMARY` | `CALC.Get_YearBuilt_Summary` |
| `NUMBEROFSTORIES_SUMMARY` | `CALC.Get_NumberOfStories_Summary` |
| `PERIL_DETAILS` | `CALC.GET_Peril_Details` |
| `DISTANCE_TO_COAST` | `CALC.Get_Distance_To_Coast` |
