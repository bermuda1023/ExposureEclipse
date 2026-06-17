# API Specification — Exposure Eclipse

> All enum values reference `CONTRACTS.md`. All responses are JSON except the Excel export
> (xlsx stream). JSON fields are `camelCase`. Monetary values carry an explicit `currency`.
> This contract is **provider-agnostic** — mock and SQL providers return identical shapes.

## Conventions

- **Base path:** `/api`
- **Content type:** `application/json` (export: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
- **Money:** raw numbers in the stated `currency`; no implicit conversion.
- **Ratios:** decimals in `[0,1]`; `yoyChange` is signed; `null` = not computable (+ warning).
- **Warnings:** every analytical response may include a top-level `warnings: Warning[]`
  and per-feature `warnings`. Shape in `CONTRACTS.md §10`.
- **Errors:** standard envelope (see `ERROR_HANDLING.md`). Domain outcomes like missing IED
  or failed ERT jobs are returned in the body, not as HTTP errors.

### Standard error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable, friendly summary.",
    "details": { "field": "treatyYear", "reason": "must be an integer" },
    "traceId": "uuid",
    "timestamp": "2026-06-17T12:00:00Z"
  }
}
```

HTTP status per `code` mapping is in `CONTRACTS.md §11`.

---

## Dataset APIs

### `GET /api/datasets`
List available EDM datasets. **Query:** `serverName?`, `treatyYear?`, `nameFilter?`, `currency?`.

```json
{
  "datasets": [
    {
      "datasetId": "ds-farmers-27-ws",
      "serverName": "MOCK-SQL-01",
      "edmDatabaseName": "Re_BER_27_Farmers_WS_EDM_01",
      "treatyYear": 2027,
      "currency": "USD",
      "ertStatus": "ERT_READY",
      "availableGranularity": ["COUNTRY", "STATE", "CRESTA"],
      "isIncludedInPortfolio": true,
      "lastGeneratedAt": "2026-06-04T12:00:00Z"
    }
  ]
}
```

### `GET /api/datasets/{datasetId}/status`
ERT output status for a dataset.

```json
{
  "datasetId": "ds-farmers-27-ws",
  "ertStatus": "ERT_PARTIAL",
  "tables": [
    { "tableType": "TIV_SUMMARY", "name": "…", "exists": true, "rowCount": 51 },
    { "tableType": "DISTANCE_TO_COAST", "name": "…", "exists": false, "rowCount": 0 }
  ],
  "warnings": [
    { "code": "WARN_ERT_TABLES_PARTIAL", "severity": "warn", "message": "…" }
  ]
}
```

---

## Dataset Group APIs

### `POST /api/dataset-groups`
```json
{
  "groupName": "Farmers 2027 All Perils",
  "currency": "USD",
  "combinationMethod": "MAX_ACROSS_PERILS_AT_VIEW_GRAIN",
  "members": [
    { "datasetId": "ds-farmers-27-ws", "peril": "WS" },
    { "datasetId": "ds-farmers-27-eq", "peril": "EQ" },
    { "datasetId": "ds-farmers-27-cs", "peril": "CS" }
  ]
}
```
**Response 201:**
```json
{
  "datasetGroupId": "grp-farmers-27",
  "warnings": [
    { "code": "WARN_DATASET_GROUP_MAX_ACROSS_PERILS", "severity": "info", "message": "…" }
  ]
}
```
**Validation:** mixed currencies among members → `409 CURRENCY_MISMATCH` (unless a
display currency / conversion assumption is supplied). `SUM_DISTINCT_SEGMENTS` requires
`distinctSegmentsConfirmed: true` else `422 VALIDATION_ERROR`.

### `GET /api/dataset-groups`
Returns saved groups (same fields as POST body + `datasetGroupId`, `createdAt`).

---

## Exposure APIs

> All three accept `datasetId` **or** `datasetGroupId` (exactly one), the current view
> grain, filters, and optional `comparisonDatasetId` for YoY. The **view grain** drives
> max-across-perils for groups.

### `POST /api/exposures/map`
**Request:**
```json
{
  "datasetId": "ds-farmers-27-ws",
  "datasetGroupId": null,
  "portfolioScope": "ALL_LOADED_DATASETS",
  "aggregationLevel": "STATE",
  "metric": "TIV",
  "filters": {
    "peril": "ALL",
    "occupancy": [],
    "distanceToCoast": [],
    "geocoding": [],
    "construction": [],
    "numberOfStories": []
  },
  "comparisonDatasetId": "ds-farmers-26-ws",
  "currencyAssumption": null
}
```
**Response:**
```json
{
  "aggregationLevel": "STATE",
  "metric": "TIV",
  "currency": "USD",
  "features": [
    {
      "geographyId": "US-FL",
      "geographyName": "Florida",
      "metricValue": 12400000000,
      "tiv": 12400000000,
      "locationCount": 42318,
      "dealShareOfPortfolioInGeography": 0.182,
      "geographyShareOfTotalPortfolio": 0.064,
      "selectedDealGeographyConcentration": 0.270,
      "clientMarketShare": 0.031,
      "yoyChange": 0.058,
      "yoyStatus": "OK",
      "hasGeometry": true,
      "warnings": []
    }
  ],
  "warnings": []
}
```
- `metricValue` mirrors whichever `metric` was requested (so the map colors by it directly).
- `clientMarketShare: null` + feature warning `WARN_IED_DENOMINATOR_MISSING` when IED has no match.
- `hasGeometry: false` + `WARN_MAP_GEOMETRY_MISSING` when geometry absent for that feature.
- Empty `features` + `WARN_FILTERS_RETURN_NO_ROWS` when filters exclude everything.

### `POST /api/exposures/detail`
Side-panel detail for one selected geography. **Request** = map request + `geographyId`.
**Response** sections (each may carry its own warnings):
```json
{
  "geographyId": "US-FL",
  "geographyName": "Florida",
  "aggregationLevel": "STATE",
  "currency": "USD",
  "summary": {
    "tiv": 12400000000, "locationCount": 42318,
    "dealShareOfPortfolioInGeography": 0.182,
    "geographyShareOfTotalPortfolio": 0.064,
    "selectedDealGeographyConcentration": 0.270,
    "clientMarketShare": 0.031, "yoyChange": 0.058, "yoyStatus": "OK"
  },
  "dealVsPortfolio": { "dealTiv": 12400000000, "portfolioTiv": 68000000000 },
  "marketShare": { "clientTiv": 12400000000, "industryTiv": 400000000000, "share": 0.031, "segment": "ALL" },
  "yoy": { "currentTiv": 12400000000, "priorTiv": 11720000000, "change": 0.058, "status": "OK" },
  "breakdowns": {
    "peril":           [ { "key": "WS", "tiv": 0, "locationCount": 0 } ],
    "occupancy":       [ { "key": "RESIDENTIAL", "tiv": 0, "locationCount": 0 } ],
    "distanceToCoast": [ { "key": "0-1mi", "tiv": 0, "locationCount": 0 } ],
    "geocoding":       [],
    "stories":         [],
    "construction":    []
  },
  "activeFilters": { },
  "warnings": []
}
```

### `POST /api/exposures/pivot`
**Request:**
```json
{
  "datasetId": "ds-farmers-27-ws",
  "datasetGroupId": null,
  "portfolioScope": "ALL_LOADED_DATASETS",
  "rows": ["STATE", "OCCUPANCY"],
  "columns": ["PERIL"],
  "measures": ["TIV", "LOCATION_COUNT"],
  "filters": { },
  "comparisonDatasetId": null
}
```
- `rows`/`columns` accept aggregation levels and dimension keys (peril, occupancy,
  construction, distanceToCoast, geocoding, numberOfStories, dataset, datasetGroup,
  currency, treatyYear). The combined rows+columns set **is** the view grain — group
  combination (max-across-perils) is computed at this grain.

**Response:**
```json
{
  "rows": ["STATE", "OCCUPANCY"],
  "columns": ["PERIL"],
  "measures": ["TIV", "LOCATION_COUNT"],
  "currency": "USD",
  "cells": [
    { "rowKey": ["US-FL", "RESIDENTIAL"], "colKey": ["WS"], "values": { "TIV": 0, "LOCATION_COUNT": 0 } }
  ],
  "rowTotals": [], "columnTotals": [], "grandTotal": { "TIV": 0, "LOCATION_COUNT": 0 },
  "warnings": []
}
```

---

## ERT Job APIs

### `POST /api/ert-jobs/run`
```json
{
  "serverName": "MOCK-SQL-01",
  "edmDatabaseName": "Re_BER_27_Farmers_WS_EDM_01",
  "treatyYear": 2027,
  "currency": "USD",
  "peril": "ALL",
  "aggregationLevels": ["COUNTRY", "STATE", "CRESTA"],
  "rerun": false
}
```
**Response 202:** `{ "jobId": "job-123", "status": "queued" }`

### `GET /api/ert-jobs/status/{jobId}`
```json
{
  "jobId": "job-123",
  "status": "failed",
  "startedAt": "…", "completedAt": "…",
  "outputTablesGenerated": ["STATE_OUTPUT"],
  "rowsGenerated": 51,
  "error": {
    "message": "The ERT routine failed for Re_BER_27_Farmers_WS_EDM_01.",
    "technical": {
      "serverName": "…", "databaseName": "…", "procedureName": "…",
      "inputParameters": { }, "timestamp": "…", "logId": "…",
      "tablesChecked": [], "tablesGeneratedBeforeFailure": ["STATE_OUTPUT"]
    },
    "emailSent": true
  }
}
```
See `BACKGROUND_JOBS_SPEC.md` for lifecycle and `ERROR_HANDLING.md` for the error report.

### `POST /api/ert-jobs/{jobId}/cancel` *(optional v1)* → `{ "jobId", "status": "cancelled" }`

---

## Export API

### `POST /api/exports/excel`
**Request** carries the full current view so the file matches the screen exactly:
```json
{
  "datasetId": "ds-farmers-27-ws",
  "datasetGroupId": null,
  "comparisonDatasetId": "ds-farmers-26-ws",
  "combinationMethod": null,
  "currency": "USD",
  "currencyAssumption": null,
  "aggregationLevel": "STATE",
  "metric": "TIV",
  "filters": { },
  "selectedGeographyId": "US-FL",
  "pivot": { "rows": [], "columns": [], "measures": [] }
}
```
**Response:** `.xlsx` stream. Workbook tabs and contents are specified in
`PRODUCT_REQUIREMENTS.md §15`. Exports include filters used, dataset metadata, currency
assumptions, warnings, and a timestamp. Over `EXPORT_MAX_ROWS` → `413 EXPORT_TOO_LARGE`.

---

## Endpoint summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/datasets` | list EDMs |
| GET | `/api/datasets/{id}/status` | ERT status |
| POST | `/api/dataset-groups` | create group |
| GET | `/api/dataset-groups` | list groups |
| POST | `/api/exposures/map` | map data |
| POST | `/api/exposures/detail` | side panel |
| POST | `/api/exposures/pivot` | pivot grid |
| POST | `/api/ert-jobs/run` | start ERT job |
| GET | `/api/ert-jobs/status/{jobId}` | job status |
| POST | `/api/ert-jobs/{jobId}/cancel` | cancel (optional) |
| POST | `/api/exports/excel` | Excel export |
| GET | `/api/health` | liveness |
