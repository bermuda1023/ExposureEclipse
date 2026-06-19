# API — endpoints + request/response shapes

All endpoints under `/api`. JSON request/response (camelCase) except
`/exports/excel` which streams `.xlsx`. Enum values from
`docs/CONTRACTS.md`. Errors use a standard envelope.

## Standard error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable, friendly summary.",
    "details": { "field": "treatyYear", "reason": "must be int" },
    "traceId": "uuid",
    "timestamp": "2026-06-18T12:00:00Z"
  }
}
```

`code` → HTTP status mapping in `CONTRACTS.md §11`. Domain outcomes (missing
IED, failed ERT job, county fallback) are NOT HTTP errors — they ride in
200 responses as `warnings[]` / null fields / status flags.

## Meta

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness probe |

## Cedent tree

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/cedents` | full tree (Cedent → ProgrammeChain → Programme) |
| GET | `/api/cedents/{id}` | one cedent |
| GET | `/api/chains/{id}` | one chain |
| GET | `/api/programmes/{id}` | one programme |
| GET | `/api/programmes/{id}/status` | ERT status of programme's EDM |

`GET /api/cedents` response:
```json
{
  "cedents": [
    {
      "cedentId": "ced-farmers",
      "cedentName": "Farmers Group",
      "region": "Nationwide",
      "chains": [
        {
          "chainId": "chain-farmers-bda",
          "chainName": "Farmers Nationwide",
          "office": "BDA",
          "defaultPeril": "ALL",
          "programmes": [
            { "programmeId": "prog-farmers-bda-2027", "treatyYear": 2027,
              "perils": ["WS","EQ","CS"], "office": "BDA",
              "edm": { "ertStatus": "ERT_READY", "currency": "USD", ... },
              "datasetId": "ds-farmers-bda-2027", ... },
            …
          ]
        },
        …
      ]
    },
    …
  ]
}
```

## Exposure analytics

| Verb | Path | Returns |
|---|---|---|
| POST | `/api/exposures/map` | choropleth features |
| POST | `/api/exposures/detail` | side-panel detail for one geography |
| POST | `/api/exposures/pivot` | pivot grid |

All three accept the **same selection shape** — AT MOST one of:
- `programmeId` — single programme/year
- `chainId` — latest programme; prior auto-paired (override via `comparisonProgrammeId`)
- `chainIds[]` — office-level multi-chain combination, OR the chains matching
  the active scope-filter chips (office / region / underwriter — frontend
  builds the list, backend just consumes it)
- `cedentId` — all chains under the cedent (uses MAX_ACROSS_PERILS_AT_VIEW_GRAIN)
- `datasetId` / `datasetGroupId` — legacy escape hatches
- **none** → **portfolio mode**: union of every currently in-force BOUND
  programme (status=BOUND AND today within [inception, expiry]). Multiple
  targets still return 422.

Plus, common across the three:

| Field | Type | Notes |
|---|---|---|
| `aggregationLevel` | AggregationLevel | required by `/map` and `/detail`; pivot derives finest level from rows+columns |
| `metric` | MetricKey | required by `/map` and `/detail` |
| `filters` | ExposureFilters | peril (ALL\|specific), occupancy[], distanceToCoast[], geocoding[], construction[], numberOfStories[], yearBuilt[] |
| `perils` | Peril[] | top-of-page multi-select (empty / contains ALL = no filter) |
| `comparisonProgrammeId` | str \| null | YoY override |
| `comparisonDatasetId` | str \| null | legacy YoY override |
| `yoyMode` | bool | when true, `metricValue` becomes YoY change of `metric` |
| `currencyAssumption` | dict | `{fromCurr: rate-to-display-curr}` |

### `POST /api/exposures/map` response

```json
{
  "aggregationLevel": "STATE",
  "metric": "TIV",
  "currency": "USD",
  "features": [
    {
      "geographyId": "US-FL",
      "geographyName": "FLORIDA",
      "metricValue": 12700000000,
      "priorMetricValue": 11200000000,
      "tiv": 12700000000,
      "locationCount": 42318,
      "dealShareOfPortfolioInGeography": 0.182,
      "geographyShareOfTotalPortfolio": 0.064,
      "selectedDealGeographyConcentration": 0.270,
      "clientMarketShare": 0.031,
      "yoyChange": 0.134,
      "yoyStatus": "OK",
      "hasGeometry": true,
      "warnings": []
    }
  ],
  "warnings": []
}
```

- `metricValue` mirrors the requested metric (or YoY change of it when `yoyMode=true`).
- `priorMetricValue` set whenever a comparison is wired — drives the mini-table tooltip.
- `clientMarketShare: null` + per-feature `WARN_IED_DENOMINATOR_MISSING` when IED gap.
- County fallback (state has no county data) emits `WARN_COUNTY_DATA_UNAVAILABLE` once.
- Empty result → `WARN_FILTERS_RETURN_NO_ROWS`.

### `POST /api/exposures/detail` response

Extra `geographyId` field on request. Response carries `summary`,
`dealVsPortfolio`, `marketShare`, `yoy`, `breakdowns` (peril / occupancy /
distanceToCoast / geocoding / stories / construction), `activeFilters`,
`warnings`.

### `POST /api/exposures/pivot`

Request adds `rows[]`, `columns[]`, `measures[]` (Measure[]). The combined
`rows + columns` set IS the view grain (CONTRACTS.md §13) — group
max-across-perils is computed at that grain. Response:

```json
{
  "rows": ["STATE","OCCUPANCY"],
  "columns": ["PERIL"],
  "measures": ["TIV","LOCATION_COUNT"],
  "currency": "USD",
  "cells": [{"rowKey":["US-FL","RESIDENTIAL"],"colKey":["WS"],"values":{"TIV":..., "LOCATION_COUNT":...}}],
  "rowTotals": [], "columnTotals": [], "grandTotal": {},
  "warnings": []
}
```

## Dataset groups (legacy, ad-hoc)

| Verb | Path | Purpose |
|---|---|---|
| POST | `/api/dataset-groups` | create |
| GET | `/api/dataset-groups` | list |

Mostly superseded by the cedent/office/chain navigation; kept for ad-hoc
multi-EDM combinations. Validation: mixed currencies → 409 `CURRENCY_MISMATCH`,
`SUM_DISTINCT_SEGMENTS` without `distinctSegmentsConfirmed: true` → 422.

## ERT jobs

| Verb | Path | Purpose |
|---|---|---|
| POST | `/api/ert-jobs/run` | start ERT job (202 + jobId) |
| GET | `/api/ert-jobs/status/{jobId}` | poll status |
| POST | `/api/ert-jobs/{jobId}/cancel` | cancel (optional) |

In-process asyncio registry in v1. Mock simulates `queued → running →
completed` (or `failed` for any EDM whose name contains `AlwaysFails`).

## Excel export

| Verb | Path | Purpose |
|---|---|---|
| POST | `/api/exports/excel` | streams `.xlsx` |

Request mirrors the map+detail+pivot shape so the workbook reflects exactly
what's on screen. Tabs: Summary, Filters Used, Dataset Metadata, Data Quality
Warnings, Map Data, Geography Summary, Deal vs Portfolio, Market Share,
YoY Comparison, Peril, Occupancy, Distance to Coast, Geocoding, Stories,
Construction, Pivot Output, Raw Aggregated Data. Over `EXPORT_MAX_ROWS` →
`413 EXPORT_TOO_LARGE`.

## Hurricanes (NOAA IBTrACS overlay + impact engine)

Live-fetches and parses NOAA IBTrACS v04r01 North-Atlantic CSV once per
cold start (lru_cached). A single parse populates THREE indexes:

- storm tracks (3-hour interpolated USA fixes — denser than HURDAT2's
  6-hour native; smoother paths and finer post-landfall coverage)
- recon-measured Rmax per fix (`USA_RMW`)
- per-quadrant R64 per fix (`USA_R64_NE/SE/SW/NW`) → asymmetric wind field

The HURDAT2 module is kept around for helper functions
(`category_for_wind`, `landfall_summary`, `peak_wind`) that are
duck-typed against the Storm dataclass.

### `GET /api/hurricanes`

Query: `yearMin` `yearMax` `minCategory` `landfallOnly`. Same response
shape as before; track points now come from IBTrACS.

Filter semantics: `effectiveCategory >= minCategory`. When `landfallOnly=true`
non-landfalling storms are dropped entirely. When `false` they're kept and
filtered by their peak.

### `POST /api/hurricanes/{stormId}/impact`

Request body mirrors `MapRequest` (any of the selection-shape targets +
filters + perils). Computes the storm's wind field and intersects it
with the user's currently-selected programmes' fact rows.

Key behaviours:

- **Footprint filter** — only fixes with `wind ≥ 64 kt` AND
  `status == "HU"` count. Excludes extratropical (EX) phase where
  IBTrACS reports a much larger Rmax that isn't a hurricane wind field.
- **Asymmetric R64** — `r64_at_bearing(quads, bearing)` linearly
  interpolates between the four IBTrACS quadrant centers (45/135/225/315).
- **County capture** — for each candidate county, the threshold is R64
  at the bearing FROM the eye TO the county centroid. A county on the
  storm-weak side won't be captured even if it's inside the storm's
  average R64. Falls back to 2.5×Rmax when no IBTrACS R64 (pre-~2004).
- **Per-programme breakdown** — `byProgramme[]` per county lists each
  contributing programme's TIV + location count.

Response:

```json
{
  "stormId": "AL142018",
  "stormName": "MICHAEL",
  "year": 2018,
  "currency": "USD",
  "multiplier": 2.5,
  "bbox": [west, south, east, north],
  "summary": {
    "countiesImpacted": 8,
    "countiesWithData": 6,
    "totalTiv": 4500000000,
    "totalLocationCount": 12340
  },
  "footprint": [
    { "lat": 30.1, "lon": -85.7, "windKt": 140,
      "rmaxNm": 10, "radiusNm": 25, "rmaxSource": "ibtracs",
      "r64Nm": 30, "r64Source": "ibtracs",
      "r64QuadsNm": [35, 35, 25, 25] }
  ],
  "cone": [
    { "corners": [[lon,lat], …, [lon,lat]],   // closed ring, Rmax half-width
      "windKt": 130, "startWindKt": 120, "endWindKt": 140 }
  ],
  "outerCone": [ /* same shape, asymmetric R64 half-widths */ ],
  "outerFootprint": [
    { "corners": [[lon,lat], …],              // 48-vertex asymmetric "egg"
      "windKt": 140, "r64Nm": 30, "r64Source": "ibtracs" }
  ],
  "counties": [
    { "geographyId": "US-FL-12005", "geoid": "12005", "name": "Bay", "state": "FL",
      "centroidLat": 30.43, "centroidLon": -85.69,
      "maxWindKt": 140, "maxCategory": 5,
      "closestDistanceNm": 12.1, "rmaxAtClosestNm": 15, "rmaxSource": "ibtracs",
      "tiv": 1400000000, "locationCount": 3500, "hasData": true,
      "byProgramme": [
        { "datasetId": "ds-coastalre-26-ws", "tiv": 950000000, "locationCount": 2350 },
        { "datasetId": "ds-farmers-bda-2026", "tiv": 350000000, "locationCount": 900 },
        { "datasetId": "ds-acmere-26-multi", "tiv": 100000000, "locationCount": 250 }
      ]
    }
  ]
}
```

### `POST /api/hurricanes/{stormId}/impact/export`

Same request shape as `/impact`. Streams an `.xlsx` workbook (Summary
sheet + Impacted Counties sheet with per-county breakdown including
the Rmax source per row).

## Counties (reference data)

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/counties/{geographyId}/reference` | population, households, avg replacement cost, avg insured value, coastal exposure share |

`geographyId` accepts either `US-FL-12086` or `12086`. Returns 404 if not
in the centroid index. Source is `curated` for ~35 cat-prone counties
(hand-anchored to census + Marshall & Swift), `synthetic` for the rest
(deterministic synthesis from state baselines).

## Calc — layered loss scenarios

| Verb | Path | Purpose |
|---|---|---|
| POST | `/api/calc/layers` | run deterministic XOL scenarios through a layer stack |

Request:

```json
{
  "layers": [
    { "deductible": 5000000,  "limit": 5000000,  "share": 0.20, "name": "1st XOL" },
    { "deductible": 10000000, "limit": 10000000, "share": 0.15, "name": "2nd XOL" },
    { "deductible": 20000000, "limit": 25000000, "share": 0.10, "name": "3rd XOL" }
  ],
  "scenarios": [
    { "tiv": 500000000, "damageRatio": 0.12, "label": "12% loss" }
  ],
  "sweepTiv": 500000000
}
```

Either supply `scenarios` (each with `grossLoss` OR `tiv` + `damageRatio`),
or set `sweepTiv` to run a default damage-ratio sweep (0.5% → 100%), or
both. Layers evaluate INDEPENDENTLY against gross loss (no cumulative
carry-over). Per-layer math: `loss_to_layer = max(0, min(gross-ded, limit))`,
`ceded_loss = loss_to_layer × share`.

Response shape per scenario:

```json
{
  "label": "12% loss",
  "tiv": 500000000,
  "damageRatio": 0.12,
  "groundUpLoss": 60000000,
  "layers": [
    { "name": "1st XOL", "deductible": 5000000, "limit": 5000000, "share": 0.20,
      "lossToLayer": 5000000, "cededLoss": 1000000, "exhausted": true },
    …
  ],
  "totalCeded": 5000000,
  "cedentNetLoss": 55000000
}
```

Reinstatements / annual aggregates / event-vs-occurrence wording are out
of scope for v1 (single-event deterministic only).

## Endpoint summary

| Verb | Path |
|---|---|
| GET | `/api/health` |
| GET | `/api/cedents` |
| GET | `/api/cedents/{id}` |
| GET | `/api/chains/{id}` |
| GET | `/api/programmes/{id}` |
| GET | `/api/programmes/{id}/status` |
| POST | `/api/exposures/map` |
| POST | `/api/exposures/detail` |
| POST | `/api/exposures/pivot` |
| POST | `/api/dataset-groups` |
| GET | `/api/dataset-groups` |
| POST | `/api/ert-jobs/run` |
| GET | `/api/ert-jobs/status/{id}` |
| POST | `/api/ert-jobs/{id}/cancel` |
| POST | `/api/exports/excel` |
| GET | `/api/hurricanes` |
| POST | `/api/hurricanes/{stormId}/impact` |
| POST | `/api/hurricanes/{stormId}/impact/export` |
| GET | `/api/counties/{geographyId}/reference` |
| POST | `/api/calc/layers` |
