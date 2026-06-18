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

All three accept the **same selection shape** — exactly one of:
- `programmeId` — single programme/year
- `chainId` — latest programme; prior auto-paired (override via `comparisonProgrammeId`)
- `chainIds[]` — office-level multi-chain combination (frontend resolves the office selection here)
- `cedentId` — all chains under the cedent (uses MAX_ACROSS_PERILS_AT_VIEW_GRAIN)
- `datasetId` / `datasetGroupId` — legacy escape hatches

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

## Hurricanes (NOAA HURDAT2 overlay)

| Verb | Path | Query |
|---|---|---|
| GET | `/api/hurricanes` | `yearMin` `yearMax` `minCategory` `landfallOnly` |

Live-fetches and parses HURDAT2 once per cold start (lru_cached). Returns:

```json
{
  "storms": [
    {
      "stormId": "AL112017",
      "name": "IRMA",
      "year": 2017,
      "landfallCategory": 5,         // -2 = no landfall, -1 = TD, 0 = TS, 1..5 = SS
      "landfallState": "FL",
      "peakWindKt": 155,
      "effectiveCategory": 5,        // = landfall cat if landfall; else peak cat (filter target)
      "track": [
        { "lat": 16.0, "lon": -29.0, "windKt": 30, "category": -1,
          "status": "TD", "datetime": "2017-08-30T00:00:00Z", "isLandfall": false },
        …
      ]
    }
  ],
  "count": 24,
  "filters": { "yearMin": 2010, "yearMax": 2024, "minCategory": 3, "landfallOnly": true }
}
```

Filter semantics: `effectiveCategory >= minCategory`. When `landfallOnly=true`
non-landfalling storms are dropped entirely. When `false` they're kept and
filtered by their peak.

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
