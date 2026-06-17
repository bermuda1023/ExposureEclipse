# Mock Data Specification — Exposure Eclipse

> Mock data lets the full UI/API/calc/export/warning stack be validated before SQL. The
> **frontend must not be special-cased for mock** — it only sees API responses. Fixtures
> live in `/mockdata` and are served by `MockExposureDataProvider`. Shapes mirror
> `DATA_MODEL.md`; enum values from `CONTRACTS.md`.

## Goal

Every v1 feature and every warning/error path must be reachable using mock data alone.
The mock provider satisfies the **same** `ExposureDataProvider` interface as the future
SQL provider.

## Mock datasets (`mockdata/datasets.json`)

Peril codes are the **real ERT codes** (`CONTRACTS.md §5`, `ERT_OUTPUT_FORMAT.md`):
`WS` (windstorm/hurricane), `EQ`, `CS` (convective storm), `FL`, `FR`, `TR`.

| DatasetId | EDM name | Year | Peril | Currency | ERT status | Granularity | In portfolio |
|---|---|---|---|---|---|---|---|
| ds-farmers-27-ws | Re_BER_27_Farmers_WS_EDM_01 | 2027 | WS | USD | `ERT_READY` | COUNTRY, STATE, COUNTY*, CRESTA | yes |
| ds-farmers-27-eq | Re_BER_27_Farmers_EQ_EDM_01 | 2027 | EQ | USD | `ERT_READY` | COUNTRY, STATE | yes |
| ds-farmers-27-cs | Re_BER_27_Farmers_CS_EDM_01 | 2027 | CS | USD | `ERT_PARTIAL` | COUNTRY, STATE | yes |
| ds-farmers-26-ws | Re_BER_26_Farmers_WS_EDM_01 | 2026 | WS | USD | `ERT_READY` | COUNTRY, STATE | yes |
| ds-sample-27-ws | Re_USA_27_SampleClient_WS_EDM_01 | 2027 | WS | EUR | `ERT_NOT_FOUND` | COUNTRY | no |

\* County data only for FL, TX, CA, NY (see graceful degradation). Mirror the real geography
seen in the proforma where possible (states `LA, NC, SC, TX`). Each fact row should carry the
real measure columns: Building/Contents/BI (→ TIV), EXPLIM_GR, EXPLIM_NET, #Location,
#Account, Invalid_TIV/#Invalid, plus Occupancy/OccupancyGroup, Construction, YearBuilt,
DistanceToCoast band, GeocodingQuality, NumberOfStories — using the vocabularies in
`CONTRACTS.md §14`.

## Mock geography

- **Country-level** rows for several countries (US + a few non-US for the global map).
- **State-level** US data (≥ the major cat states).
- **County-level** data for **FL, TX, CA, NY** only.
- **At least one dataset/state where county data is unavailable** → exercises
  `WARN_COUNTY_DATA_UNAVAILABLE` and state-level fallback.
- CRESTA rows for at least one dataset where CRESTA geometry exists.

## Mock measures (per fact row)

Building, Contents, BI (→ TIV), EXPLIM_GR, EXPLIM_NET, #Location, #Account, Invalid_TIV,
#Invalid; dimensions: peril (`EQ/WS/CS/FL/FR/TR`), occupancy + occupancy group (incl. some
`UNKNOWN`), construction, year-built band, distance-to-coast band, geocoding quality,
number-of-stories band — all using `CONTRACTS.md §14` vocabularies. Plus prior-year values
via the 2026 dataset, and industry TIV via the IED fixture. Keep at least one dataset where
`Invalid_TIV`/`#Invalid` is non-zero to exercise a data-quality warning.

## RMS IED fixture (`mockdata/ied_industry.csv`)

Industry TIV by geography (+ occupancy segment), county-level where possible. **Include
intentional gaps** (e.g. a state/county with no IED row) to exercise
`WARN_IED_DENOMINATOR_MISSING` and `null` market share.

## Geometry (`mockdata/geo/`)

GeoJSON for country, US state, county (FL/TX/CA/NY), and at least one CRESTA set. Keep
`geographyId` keys aligned with fact rows (`US`, `US-FL`, `US-FL-12086`, `CRESTA-…`).
Include at least one feature with data but **no geometry** → `WARN_MAP_GEOMETRY_MISSING`.

## Required mock scenarios (each must be reachable)

| Scenario | How it's triggered | Expected |
|---|---|---|
| ERT Ready | select `ds-farmers-27-ws` | `ERT_READY` badge, full map |
| ERT Partial | select `ds-farmers-27-cs` | `ERT_PARTIAL` + `WARN_ERT_TABLES_PARTIAL` |
| ERT Not Found | select `ds-sample-27-ws` | `ERT_NOT_FOUND`, Run ERT offered |
| County unavailable | view county for a non-FL/TX/CA/NY state | state fallback + `WARN_COUNTY_DATA_UNAVAILABLE` |
| IED denominator missing | market share on a gap geography | `null` + `WARN_IED_DENOMINATOR_MISSING` |
| Currency mismatch | group/compare USD with `ds-sample-27-ws` (EUR) | blocked + `WARN_CURRENCY_MISMATCH` |
| Currency assumed | apply a conversion assumption | proceeds + `WARN_CURRENCY_ASSUMED` |
| Dataset group max-across-perils | group WS+EQ+CS | `WARN_DATASET_GROUP_MAX_ACROSS_PERILS`, max math |
| Prior-year missing | load current without prior | `WARN_PRIOR_DATASET_NOT_SELECTED`, YoY = null |
| Map geometry missing | feature flagged no-geometry | `WARN_MAP_GEOMETRY_MISSING` |
| Filters return no rows | over-filter | empty + `WARN_FILTERS_RETURN_NO_ROWS` |
| Successful ERT job | Run ERT on `ds-sample-27-ws` | queued→running→completed, status refresh |
| Failed ERT job | Run ERT on a designated "always-fails" EDM | failed + technical report + email called |

## Determinism

Mock numbers should be fixed (committed fixtures), not random, so calculation tests assert
exact expected values. Provide a small worked dataset whose hand-computed metrics match the
examples in `CALCULATION_RULES.md` (e.g. the FL/CA max-across-perils table).
