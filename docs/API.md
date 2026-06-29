# API — endpoints + request/response shapes

All endpoints under `/api`. JSON request/response (camelCase) except
`/exports/excel` and `/hurricanes/{id}/impact/export` which stream `.xlsx`.
Enum values from `docs/CONTRACTS.md`. Errors use a standard envelope.

## Standard error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable, friendly summary.",
    "details": { "field": "treatyYear", "reason": "must be int" },
    "traceId": "uuid",
    "timestamp": "2026-06-29T12:00:00Z"
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
| GET | `/api/docs` | FastAPI Swagger UI (dev only — useful for poking endpoints) |
| GET | `/api/openapi.json` | OpenAPI 3 schema |

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
            ...
          ]
        }
      ]
    }
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
  programme. Multiple targets still return 422.

Common fields across the three:

| Field | Type | Notes |
|---|---|---|
| `aggregationLevel` | AggregationLevel | required by `/map` and `/detail`; pivot derives finest level from rows+columns |
| `metric` | MetricKey | required by `/map` and `/detail` |
| `filters` | ExposureFilters | peril (ALL\|specific), occupancy[], distanceToCoast[], geocoding[], construction[], numberOfStories[], yearBuilt[] |
| `perils` | Peril[] | top-of-page multi-select (empty / contains ALL = no filter) |
| `comparisonProgrammeId` | str \| null | YoY override |
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

### `POST /api/exposures/detail` response

Extra `geographyId` field on request. Response carries `summary`,
`dealVsPortfolio`, `marketShare`, `yoy`, `breakdowns` (peril / occupancy /
distanceToCoast / geocoding / stories / construction), `activeFilters`,
`warnings`.

### `POST /api/exposures/pivot`

Request adds `rows[]`, `columns[]`, `measures[]` (`Measure[]`). The combined
`rows + columns` set IS the view grain (CONTRACTS.md §13). Response:

```json
{
  "rows": ["STATE","OCCUPANCY"],
  "columns": ["PERIL"],
  "measures": ["TIV","LOCATION_COUNT"],
  "currency": "USD",
  "cells": [{"rowKey":["US-FL","RESIDENTIAL"],"colKey":["WS"],
             "values":{"TIV":..., "LOCATION_COUNT":...}}],
  "rowTotals": [], "columnTotals": [], "grandTotal": {},
  "warnings": []
}
```

## Dataset groups (legacy, ad-hoc)

| Verb | Path | Purpose |
|---|---|---|
| POST | `/api/dataset-groups` | create |
| GET | `/api/dataset-groups` | list |

Mostly superseded by the cedent/office/chain navigation. In-memory store —
won't survive serverless cold starts.

## ERT jobs

| Verb | Path | Purpose |
|---|---|---|
| POST | `/api/ert-jobs/run` | start ERT job (202 + jobId) |
| GET | `/api/ert-jobs/status/{jobId}` | poll status |
| POST | `/api/ert-jobs/{jobId}/cancel` | cancel |

In-process asyncio registry in v1. Mock simulates `queued → running →
completed` (or `failed` for any EDM whose name contains `AlwaysFails`).
On serverless, the submit + poll may land on different lambdas — acceptable
for the demo.

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

## Hurricanes (historical IBTrACS overlay + impact engine)

Live-fetches NOAA IBTrACS v04r01 North-Atlantic CSV once per cold start
(lru_cached). A single parse populates THREE indexes:

- storm tracks (3-hour interpolated USA fixes — denser than HURDAT2's
  6-hour native; smoother paths and finer post-landfall coverage)
- recon-measured Rmax per fix (`USA_RMW`)
- per-quadrant R64 per fix (`USA_R64_NE/SE/SW/NW`) → asymmetric wind field

The HURDAT2 module is kept around for helper functions
(`category_for_wind`, `landfall_summary`, `peak_wind`) duck-typed against
the Storm dataclass.

### `GET /api/hurricanes`

Query: `yearMin`, `yearMax`, `minCategory`, `landfallOnly`, `landfallStates`
(comma-separated USPS, e.g. `FL,LA,TX` — filters to storms whose landfall
record's state is in the list).

Filter semantics: `effectiveCategory >= minCategory`. When `landfallOnly=true`
non-landfalling storms are dropped entirely.

### `POST /api/hurricanes/{stormId}/impact`

Request body mirrors `MapRequest` (any selection-shape target + filters + perils).
Computes the storm's wind field and intersects it with the user's
currently-selected programmes' fact rows.

Key behaviours:

- **Footprint filter** — only fixes with `wind ≥ 64 kt` AND `status == "HU"`
  count. Excludes extratropical (EX) phase where IBTrACS reports a much
  larger Rmax that isn't a hurricane wind field.
- **Asymmetric R64** — `r64_at_bearing(quads, bearing)` linearly
  interpolates between the four IBTrACS quadrant centers (NE=45°, SE=135°,
  SW=225°, NW=315°).
- **County capture** — for each candidate county, the threshold is R64
  at the bearing FROM the eye TO the county centroid. Falls back to
  2.5×Rmax when no IBTrACS R64 (pre-~2004).
- **Per-programme breakdown** — `byProgramme[]` per county.

Response:

```json
{
  "stormId": "AL142018",
  "stormName": "MICHAEL",
  "year": 2018,
  "currency": "USD",
  "bbox": [west, south, east, north],
  "summary": { "countiesImpacted": 8, "countiesWithData": 6,
               "totalTiv": 4500000000, "totalLocationCount": 12340 },
  "footprint": [
    { "lat": 30.1, "lon": -85.7, "windKt": 140,
      "rmaxNm": 10, "rmaxSource": "ibtracs",
      "r64Nm": 30, "r64Source": "ibtracs",
      "r64QuadsNm": [35, 35, 25, 25] }
  ],
  "cone": [
    { "corners": [[lon,lat], ...], "windKt": 130,
      "startWindKt": 120, "endWindKt": 140 }
  ],
  "outerCone": [ /* asymmetric R64 half-widths */ ],
  "outerFootprint": [ /* 48-vertex asymmetric "egg" per fix */ ],
  "counties": [
    { "geographyId": "US-FL-12005", "geoid": "12005", "name": "Bay",
      "state": "FL", "centroidLat": 30.43, "centroidLon": -85.69,
      "maxWindKt": 140, "maxCategory": 5,
      "closestDistanceNm": 12.1, "rmaxAtClosestNm": 15, "rmaxSource": "ibtracs",
      "tiv": 1400000000, "locationCount": 3500, "hasData": true,
      "byProgramme": [
        { "datasetId": "ds-coastalre-26-ws", "tiv": 950000000, "locationCount": 2350 },
        { "datasetId": "ds-farmers-bda-2026", "tiv": 350000000, "locationCount": 900 }
      ]
    }
  ]
}
```

The frontend's per-SSHWS-category damage assumption store +
per-county-exposed-fraction override store run on top of this response —
they're not sent back to the backend; the loss band is computed in the
browser. See `frontend/src/state/{damageAssumptions,countyOverrides}.ts`.

### `POST /api/hurricanes/{stormId}/impact/export`

Same request shape as `/impact`. Streams an `.xlsx` workbook (Summary +
Impacted Counties sheets, per-county breakdown with the Rmax source per row).

## Live + replay storms

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/live/storms` | picker rows: active NHC + curated replay |
| GET | `/api/live/storms/{atcfId}` | full bundle for one storm |

`GET /api/live/storms` reads NHC `CurrentStorms.json` for active storms and
returns a curated replay list (Atlantic basin majors with R64 data, e.g.
Michael 2018, Ian 2022) for demo when nothing is active.

`GET /api/live/storms/{atcfId}` returns the bundle:

```json
{
  "storm": { /* LiveStormRow: stormId, name, intensityKt, lat, lon, ... */ },
  "observedTrack": [ /* ObservedFix per IBTrACS / NHC fix */ ],
  "forecasts": [
    { "advisoryNumber": 17, "issuedAt": "...", "synthetic": true,
      "points": [ /* ForecastFix per +12h step */ ] }
  ],
  "bbox": [west, south, east, north],
  "alerts": [ /* WeatherAlertOut from NWS api.weather.gov */ ],
  "buoys": [ /* BuoyOut from NDBC latest_obs.txt */ ],
  "landStations": [ /* LandObsOut from NWS observations */ ],
  "sst": [ /* SSTOut from JPL MUR via ERDDAP CSV */ ],
  "sstMinC": 24.1, "sstMaxC": 30.7,
  "sstMeta": { "source": "mur", "stepDeg": 0.25 },
  "observedWindField": {
    "innerCone": [ /* same shape as historical impact */ ],
    "outerCone": [],
    "outerRings": []
  },
  "forecastWindField": { /* same shape applied to the forecast track */ }
}
```

Query toggles: `asOfIndex`, `includeObs`, `includeAlerts`, `includeSst`,
`includeLand` — let the frontend skip expensive layers when not needed.

`synthetic: true` on forecasts means the advisory history was synthesised
from IBTrACS for a retired storm (replay mode). Real-time NHC text-advisory
scraping is out of scope for v1.

## Hazard overlays (tornado / hail / wildfire)

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/hazards/{tornado\|hail\|wildfire}` | pre-baked lat/lon hazard grid + legend |

Returns:

```json
{
  "hazard": "tornado",
  "stepDeg": 0.2,
  "grid": [
    { "lat": 35.4, "lon": -98.0, "raw": 85.6, "normalised": 1.0 },
    ...
  ],
  "legend": {
    "title": "Tornado hazard index",
    "unit": "0–100 (blended climatology + history)",
    "source": "SPC SVRGIS 1950-2025 + Brooks/Tippett climatology",
    "sourceUrl": "https://www.spc.noaa.gov/gis/svrgis/",
    "rawMin": 0.0, "rawMax": 85.6,
    "palette": ["#f8fafc", "#fef3c7", "#fde047", ...],
    "stops": [0, 12, 28, 45, 60, 75, 90],
    "note": "Blend of 60% smooth climatology prior + 40% real SPC touchdowns ..."
  }
}
```

`stepDeg` is the grid step the JSON was baked at — the frontend uses it to
size each square-fill polygon. Tornado + hail are 0.2°; wildfire is 0.15°.

Grids are pre-baked offline by `backend/scripts/build_*_grid.py` (require
`pyshp` for the SPC shapefile reads — dev dep only). See
`docs/CALCULATIONS.md §Hazard climatology blend` for the methodology.

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

Supply `scenarios` (each with `grossLoss` OR `tiv` + `damageRatio`), or set
`sweepTiv` for a default damage-ratio sweep (0.5% → 100%), or both. Layers
evaluate INDEPENDENTLY against gross loss. Per-layer math:
`loss_to_layer = max(0, min(gross-ded, limit))`,
`ceded_loss = loss_to_layer × share`.

```json
{
  "label": "12% loss",
  "tiv": 500000000,
  "damageRatio": 0.12,
  "groundUpLoss": 60000000,
  "layers": [
    { "name": "1st XOL", "deductible": 5000000, "limit": 5000000, "share": 0.20,
      "lossToLayer": 5000000, "cededLoss": 1000000, "exhausted": true }
  ],
  "totalCeded": 5000000,
  "cedentNetLoss": 55000000
}
```

Reinstatements / annual aggregates / event-vs-occurrence wording are out
of scope for v1 (single-event deterministic only). No frontend UI yet — the
engine is API-only until a "what-if" panel is built.

## Admin — programme treaty metadata

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/admin/programmes` | joined treaty rows + EDM linkage + auto-suggest |
| PUT | `/api/admin/programmes/{fsDisplayId}/edm-link` | set/clear EDM link for one treaty |
| POST | `/api/admin/programmes/edm-links` | bulk save EDM links |
| POST | `/api/admin/programmes/import` | parse + replace treaty rows from a CSV |

Backs the `/admin/programmes` page. Treaty rows persist to
`mockdata/treaty_metadata.json`; EDM links to `mockdata/edm_linkage.json`.
Auto-suggest matches treaty rows to cedent EDMs by reinsured-name
substring; the UI surfaces the suggestion as an "Apply suggestion" action
per row.

`/import` accepts CSVs from the upstream RMS treaty registry. Header names
tolerate both `FS display` (with space) and `fs_display` (snake) variants.

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
| GET | `/api/live/storms` |
| GET | `/api/live/storms/{atcfId}` |
| GET | `/api/hazards/{tornado\|hail\|wildfire}` |
| GET | `/api/counties/{geographyId}/reference` |
| POST | `/api/calc/layers` |
| GET | `/api/admin/programmes` |
| PUT | `/api/admin/programmes/{fsDisplayId}/edm-link` |
| POST | `/api/admin/programmes/edm-links` |
| POST | `/api/admin/programmes/import` |
