# API — endpoints + request/response shapes

All endpoints under `/api`. JSON request/response (camelCase) except
`/exports/excel` and `/hurricanes/{id}/impact/export` which stream `.xlsx`.
Enum values from `docs/CONTRACTS.md`. Errors use a standard envelope.

> System context: [`FOR_INTERNAL_DEVELOPERS.md`](./FOR_INTERNAL_DEVELOPERS.md) ·
> multi-EDM runbook: [`MULTI_EDM.md`](./MULTI_EDM.md).

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
| GET | `/api/health` | liveness probe + `dataProvider` + fact-cache summary when available |
| GET | `/api/docs` | FastAPI Swagger UI (dev only — useful for poking endpoints) |
| GET | `/api/openapi.json` | OpenAPI 3 schema |

`GET /api/health` example fields:

```json
{
  "status": "ok",
  "service": "exposure-eclipse-backend",
  "version": "0.1.0",
  "dataProvider": "mock",
  "factCacheMaxDatasets": 256,
  "factLoadMaxWorkers": 16,
  "factCache": {
    "datasetsCached": 3,
    "rowsCached": 12000,
    "hits": 10,
    "misses": 3
  }
}
```

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

## Live wildfire overlay

Live-data layer, not part of the mock data plane. Sources are NIFC/WFIGS
(burn-area perimeters) and NASA FIRMS (satellite thermal anomalies). Both are
fetched at request time; results are cached in-process with short TTLs
(perimeters 10 min; FIRMS 30 min). Every upstream failure degrades gracefully
— the endpoint returns what it has and describes the shortfall in `notes[]`.

See `docs/CALCULATIONS.md §Live wildfire overlay` for the clustering and
footprint-tracing algorithms.

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/wildfire/active` | WFIGS perimeters + FIRMS satellite heat + affected-state roll-up |
| POST | `/api/wildfire/exposure` | Exposed TIV by client inside submitted fire polygon(s) |

### `GET /api/wildfire/active`

Query parameters:

| Param | Type | Default | Constraint | Notes |
|---|---|---|---|---|
| `bbox` | string | CONUS | `west,south,east,north` (lon/lat) | Omit for CONUS default |
| `dayRange` | int | 3 | 1–30 | FIRMS look-back; chained ≤5-day windows (FIRMS API cap) |
| `includeHeat` | bool | true | — | Fetch NASA FIRMS active-fire pixels |
| `includePerimeters` | bool | true | — | Fetch WFIGS burn-area polygons |
| `simplify` | float | 0.005 | 0.0–0.05 | Perimeter generalisation in degrees (0 = full resolution; 0.005 ≈ 550 m, ~70× smaller payload) |
| `minCells` | int | 2 | 1–20 | Minimum distinct grid cells for a heat cluster to be kept (removes point sources) |
| `minDetections` | int | 4 | 1–200 | Minimum FIRMS detections per cluster |
| `minConfidence` | string | `nominal` | `low\|nominal\|high` | Drop VIIRS/MODIS detections below this confidence band |
| `minFrp` | float | 0.0 | ≥ 0 | Drop detections with FRP (MW) below this threshold |

`FIRMS_MAP_KEY` must be set for heat to populate; omitting it returns WFIGS
perimeters only, with an explanatory message in `notes[]`.

Response:

```json
{
  "generatedAt": "2026-08-07T14:23:00Z",
  "bbox": [-125.0, 24.0, -66.5, 50.0],
  "dayRange": 3,
  "perimeters": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "id": "{irwinId}",
        "geometry": { "type": "Polygon", "coordinates": [...] },
        "properties": {
          "incidentId": "...",
          "name": "PARK FIRE",
          "gisAcres": 429603.0,
          "incidentSizeAcres": 429603.0,
          "percentContained": 62.0,
          "cause": "Human",
          "discoveryAt": "2024-07-24T14:00:00Z",
          "perimeterUpdatedAt": "2026-08-06T08:00:00Z",
          "state": "CA"
        }
      }
    ]
  },
  "heatShapes": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": { "type": "Polygon", "coordinates": [...] },
        "properties": {
          "shapeId": "heat-0",
          "detectionCount": 312,
          "maxFrpMw": 847.3,
          "sumFrpMw": 12043.8,
          "firstDetectedAt": "2026-08-05T02:00:00Z",
          "lastDetectedAt": "2026-08-07T10:00:00Z"
        }
      }
    ]
  },
  "activeFires": [
    {
      "lat": 39.87, "lon": -121.43,
      "brightnessK": 368.2, "frpMw": 312.4,
      "confidence": "high", "satellite": "S-NPP",
      "source": "VIIRS_SNPP_NRT",
      "acquiredAt": "2026-08-07T10:00:00Z"
    }
  ],
  "affectedStates": [
    { "state": "CA", "fireCount": 14, "acres": 438201.0 }
  ],
  "counts": {
    "perimeters": 14,
    "activeFires": 2847,
    "activeFiresTotal": 31200,
    "heatShapes": 8
  },
  "notes": ["Showing 2,847 of 31,200 detections (thinned for display); shapes use all of them."],
  "attribution": {
    "perimeters": "NIFC / WFIGS Interagency Perimeters (Current)",
    "perimetersUrl": "https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-interagency-perimeters-current",
    "activeFires": "NASA FIRMS (VIIRS/MODIS active fire, NRT)",
    "activeFiresUrl": "https://firms.modaps.eosdis.nasa.gov/"
  }
}
```

`heatShapes` are footprints built by this service from FIRMS clusters — they
are NOT official agency polygons. See `docs/CALCULATIONS.md §Live wildfire
overlay` for how the footprint boundary is traced and holes are preserved.
`shapeId` is the stable per-response handle a client should use to identify a
shape (e.g. for click-to-select); shapes are sorted by `detectionCount`, so it
is stable within a response but not across responses.

At most 2,000 heat shapes are returned. When more exist the largest are kept
and a `notes[]` entry says so — at `minCells=1` a CONUS-wide fire-season pull
can otherwise produce tens of thousands of polygons.

Degradation is always explicit in `notes[]`, never silent. An upstream that
rejects a query (WFIGS answers with HTTP 200 and an error body; FIRMS answers
over-quota with HTTP 200 plain text) is reported as unavailable rather than
cached as "no fires". Partial FIRMS coverage — some of the chained ≤5-day
windows failing — is reported too, and is not cached, because it understates
every footprint and every exposed-TIV figure derived from it.

### `POST /api/wildfire/exposure`

Computes exposed TIV by client for each submitted fire polygon. Accepts
official WFIGS perimeters and heat-derived shapes alike.

Limits (the geometry drives a grid walk and a point-in-polygon sweep, so it is
bounded): at most 50 polygons and 100,000 total ring vertices per request;
rings need ≥4 numeric `[lon, lat]` positions within WGS84 bounds. Anything
else is a `422`. If the exposure plane cannot be loaded the endpoint returns
`503 UPSTREAM_UNAVAILABLE` rather than a silent zero.

**IMPORTANT — synthetic data limitation:** v1 exposure facts are
county-aggregated (no per-location lat/lon). This endpoint distributes each
county's TIV across 4 deterministic synthetic points inside the county, then
runs point-in-polygon against those. The `synthetic: true` flag and `note`
field in the response make this explicit. The single swap point for real
location-level data is `_load_locations()` in
`backend/app/services/wildfire_exposure.py`.

Request:

```json
{
  "polygons": [
    {
      "id": "park-fire",
      "name": "PARK FIRE",
      "geometry": { "type": "Polygon", "coordinates": [...] }
    }
  ]
}
```

Response:

```json
{
  "currency": "USD",
  "synthetic": true,
  "note": "Estimated from synthetic location points distributed within counties from aggregate TIV — not real location-level data. Replace the location source with individual-location exposure for exact in-perimeter TIV.",
  "results": [
    {
      "id": "park-fire",
      "name": "PARK FIRE",
      "totalTiv": 2840000000,
      "locationCount": 48,
      "byClient": [
        { "client": "Farmers Group", "tiv": 1920000000, "locationCount": 32 },
        { "client": "CoastalRe", "tiv": 920000000,  "locationCount": 16 }
      ]
    }
  ],
  "combined": {
    "id": "combined",
    "name": null,
    "totalTiv": 2840000000,
    "locationCount": 48,
    "byClient": [
      { "client": "Farmers Group", "tiv": 1920000000, "locationCount": 32 },
      { "client": "CoastalRe", "tiv": 920000000,  "locationCount": 16 }
    ]
  },
  "warnings": []
}
```

`combined` is the union across every submitted polygon with each location
counted **once**. Use it rather than summing `results` — selecting an official
perimeter together with the heat shape over the same fire is the natural thing
to do, and summing double-counts every location in the overlap.

TIV is combined **max-across-perils at the (client, county) grain** per
CLAUDE.md rules 3+4: within one peril, fact rows are disjoint segments and are
summed; across perils and across treaty years for the same cedent the max is
taken. Summing there would report a cedent carrying WS+EQ+CS on one EDM at
several times its real exposure.

`totalTiv` and `byClient[].tiv` are in the currency reported in the `currency`
field (ISO 4217). CONTRACTS.md §12 currency rules apply — if the exposure
plane spans more than one currency the values are not combinable, so the
rollup is reported as 0 with an entry in `warnings[]`.

## Live flood overlay

Active NWS flood watches, warnings and advisories as GeoJSON polygons, plus
exposed TIV by client for a selected set of them. Live layer, like the storm
and wildfire bundles — not part of the mock data plane.

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/flood/active` | polygon-bearing NWS flood alerts + affected-state roll-up |
| POST | `/api/flood/exposure` | Exposed TIV by client inside submitted alert polygon(s) |
| GET | `/api/flood/inundation` | NWM modelled water extent for a bbox (additive to the alerts) |
| POST | `/api/flood/inundation/exposure` | Exposed TIV by client inside the modelled extent |

Source: NOAA / National Weather Service `api.weather.gov/alerts/active`
(keyless). Results are cached for 60 s per (bbox, states, severity floor,
event set); the cache key includes the severity floor so a `Severe`-filtered
response can never be served to an unfiltered caller.

### `GET /api/flood/active`

| Param | Type | Default | Notes |
|---|---|---|---|
| `bbox` | `west,south,east,north` | none | lon/lat, EPSG:4326. Omit for nationwide. `422` unless west<east and south<north. |
| `minSeverity` | `Unknown\|Minor\|Moderate\|Severe\|Extreme` | `Unknown` | CAP severity floor. `422` on anything else. |

Only flood products are fetched — `Flood`, `Flash Flood`, `Coastal Flood` and
`Lakeshore Flood` × Warning/Watch/Advisory/Statement. That filter is what keeps
a hurricane or winter-storm alert off the flood map.

**Severity is the only "how bad" signal that arrives attached to the geometry.**
NWS alert polygons carry no depth, no return period and no flood category, so
`minSeverity=Severe` is the practical approximation of "major flooding only" —
and it is the frontend default for that reason.

```json
{
  "generatedAt": "2026-08-08T14:02:11Z",
  "bbox": null,
  "minSeverity": "Severe",
  "alerts": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "id": "urn:oid:2.49.0.1.840.0.264ec87f…",
        "geometry": { "type": "Polygon", "coordinates": [...] },
        "properties": {
          "alertId": "urn:oid:2.49.0.1.840.0.264ec87f…",
          "event": "Flash Flood Warning",
          "headline": "Flash Flood Warning issued August 8 …",
          "severity": "Severe",
          "severityRank": 3,
          "urgency": "Immediate",
          "certainty": "Observed",
          "sentAt": "2026-08-08T12:00:00Z",
          "expiresAt": "2026-08-08T18:00:00Z",
          "areaDesc": "Houston, TN; Stewart, TN"
        }
      }
    ]
  },
  "affectedStates": [{ "state": "TN", "alertCount": 4 }],
  "counts": { "alerts": 19, "zoneOnly": 1 },
  "notes": ["1 alert is zone-coded and carries no polygon, so it is not mapped."],
  "attribution": { "alerts": "NOAA / National Weather Service active alerts", "alertsUrl": "…" }
}
```

`severityRank` is the numeric twin of `severity` (`Unknown`=0 … `Extreme`=4) so
the Mapbox fill ramp can interpolate without a string-match expression. The two
always agree — they come from the same source field.

The feature `id` is the upstream NWS URN. Unlike wildfire heat shapes, which are
re-derived on every fetch and therefore need a geometry hash for a stable
selection key, alert ids are already stable, so they are used directly.

**Zone-coded alerts.** Coastal and Lakeshore products and most Watches are
issued against NWS zone codes rather than polygons. They cannot be drawn or
intersected, so they are excluded from `alerts` and reported in
`counts.zoneOnly` **with an explanatory entry in `notes[]`** — an alert that
vanished silently would understate the event. `zoneOnly` means "had no
geometry" and never counts alerts dropped by `minSeverity`.

`affectedStates` is parsed from the free-text `areaDesc` (`"Houston, TN;
Stewart, TN"`). A trailing token that is not a 2-letter code is ignored rather
than becoming a phantom state.

### `POST /api/flood/exposure`

Same request/response shape, same limits and the same engine as
[`POST /api/wildfire/exposure`](#post-apiwildfireexposure) — at most 50
polygons and 100,000 total ring vertices, `422` on malformed or oversized
geometry, `503 UPSTREAM_UNAVAILABLE` if the exposure plane cannot be loaded,
and the same rules 3+4 max-across-perils rollup. The shared validation lives in
`backend/app/api/geometry_input.py` so the two routes cannot drift apart.

`combined` is the union across every submitted polygon with each location
counted **once**. Adjacent flood warnings routinely overlap, so summing
`results` double-counts the shared ground.

**IMPORTANT — two stacked caveats.** The exposure is `synthetic: true` for the
same reason wildfire's is (county-aggregated TIV spread over deterministic
synthetic points). On top of that, **alert polygons are warning areas**, often
drawn to county or zone boundaries rather than observed water extent, so the
exposed TIV is an **upper bound** on the affected area. Both are stated in the
response `note` and surfaced in the UI.

### `GET /api/flood/inundation`

Modelled water extent from the NOAA **National Water Model** — a second,
additive layer under the alerts. Alerts are warning areas drawn to county and
zone boundaries; this is modelled water at river-reach resolution, so it answers
"where is the water" rather than "where has a warning been issued". The two are
stacked, never merged.

**It cannot replace the alert layer**, for reasons that are properties of the
source rather than of our code: NOAA flags the service EXPERIMENTAL, it covers
roughly 30% of the US population, and it models riverine flooding only — storm
surge and other coastal processes are absent. **Silence here never means "no
flooding"**, which is why the coverage caveat rides on every response.

| Param | Type | Default | Notes |
|---|---|---|---|
| `bbox` | `west,south,east,north` | **required** | `422` if absent, malformed, or larger than 25 deg². |
| `simplify` | float, 0–0.05 | `0.001` | `maxAllowableOffset` in degrees. `0` requests full resolution. |

`bbox` is required and capped because the upstream service truncates at 2,000
features: a 12°×11° request returned exactly 2,000 features and 5.6 MB with
`exceededTransferLimit`, which would draw a partial extent as if it were all the
water there is. `simplify=0.001` cut a Houston bbox from 4,146 vertices to 787
(9×) with no visible change at mapping scales.

```json
{
  "generatedAt": "2026-08-08T21:15:39Z",
  "bbox": [-95.8, 29.4, -94.9, 30.2],
  "referenceTime": "2026-08-08 20:00:00",
  "truncated": false,
  "unavailable": false,
  "inundation": {
    "type": "FeatureCollection",
    "features": [{
      "type": "Feature",
      "geometry": { "type": "MultiPolygon", "coordinates": [...] },
      "properties": { "reachId": 5781231, "streamflowCfs": 1234.5 }
    }]
  },
  "counts": { "reaches": 16 },
  "notes": ["Modelled inundation is EXPERIMENTAL, covers roughly 30% …"],
  "attribution": { "model": "NOAA/NWS National Water Model …", "modelUrl": "…" }
}
```

`referenceTime` is hoisted onto the response rather than repeated per feature —
it is identical on every one, and at 2,000 features repeating it is pure payload.
`truncated` is cached **with** the features: caching the payload and recomputing
the caveat would serve a partial extent as complete for the rest of the 10-minute
TTL.

We read `MapServer/0` with `f=geojson` and take NOAA's own conversion.
`FeatureServer/0` returns HTTP 500 for `f=geojson` (reproduced 2026-08-08), and
converting Esri rings ourselves was built, tested and measured against the same
data: it recovered only 10 of the 35 holes NOAA emits, because ring winding
alone cannot always recover which outer a hole belongs to.

This route **fails soft**. If the model service is unreachable the response is an
empty extent with an explicit note that this is *not* a statement that there is
no flooding. An outage is never cached.

Because it fails soft, an outage and a genuinely dry view are otherwise the same
response — zero reaches, null `referenceTime`. `unavailable: true` is what
separates them, so branch on it rather than on the wording of `notes`; rendering
an outage as a bold `0` reaches reads as "no water here".

### `POST /api/flood/inundation/exposure`

```json
{ "bbox": [-95.8, 29.4, -94.9, 30.2], "simplify": 0.001 }
```

Takes a bbox rather than geometry: a flood event is thousands of per-reach
polygons, well past the 50-polygon cap on the other exposure routes, and posting
them back up would be a multi-megabyte round trip. The reaches are combined
server-side into one multipart geometry before the rollup, which keeps the work
budget meaningful and matches how an underwriter thinks about one flood event.
Overlapping reaches do not double-count — the rollup collects location indices
into a set.

Reaches whose bounding box holds no synthetic location are dropped before the
rollup. That is answer-preserving — such a reach contributes no index — and it
is what makes the route usable at all: the work budget charges (candidate
locations × *total* vertices), and a live 25 deg² mid-Atlantic extent measured
1,871 reaches carrying 199,946 vertices, i.e. 86M charged operations against a
budget of 8M. Without the drop the route would `422` on exactly the widespread
floods it exists for; with it, that same extent prices at 96 operations.
Coarsening `simplify` is *not* an alternative — measured, 50× coarser removed
0.8% of the vertices, because the load is thousands of small separate reaches
rather than a few over-detailed rings.

Unlike the map route this **does not fail soft**: `503 UPSTREAM_UNAVAILABLE` if
the model is unreachable. A zero exposed TIV would be indistinguishable from a
genuine zero, and that number feeds the XOL layer calc.

**`belowResolution` — read this before reading `totalTiv`.** Exposure is
computed against synthetic locations (4 per client-county, scattered ±0.10°
around the centroid), so the method can only resolve areas of roughly
0.01 deg² and up. A real modelled extent is river corridors: a Houston bbox
measured 8×10⁻⁵ deg² against a 0.72 deg² viewport. Below that floor the answer
is structurally zero no matter how much exposure sits nearby, so the response
sets `belowResolution: true` and the UI renders "not measurable" instead of a
bare `$0` an underwriter would read as "no exposure here". The floor is derived
from the exposure engine's own constants (`wildfire_exposure.resolution_deg2`)
so the two cannot drift apart.

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

## Admin — multi-EDM cache & connections

| Verb | Path | Purpose |
|---|---|---|
| GET | `/api/admin/connections` | registered SQL hosts + fact-cache stats |
| GET | `/api/admin/connections?probe=true` | same + live `SELECT 1` per host |
| GET | `/api/admin/cache` | fact-cache hit/miss/eviction stats + cached ids |
| POST | `/api/admin/cache/warmup` | parallel preload of EDM facts into process cache |
| DELETE | `/api/admin/cache` | invalidate entire cache |
| DELETE | `/api/admin/cache?datasetId=ds-…` | invalidate one EDM |

### Warmup body

```json
{
  "datasetIds": null,
  "inForceOnly": true
}
```

- Omit `datasetIds` (or `null`) → warm programmes from the catalog.
- `inForceOnly: true` → only BOUND programmes in force today.
- Response: `{ "loaded": { "ds-…": rowCount }, "totalDatasets": N, "totalRows": M }`.

Under `DATA_PROVIDER=mock`, connections list is empty but cache endpoints
still work (JSON facts). Under `hybrid`/`sqlserver`, servers come from
`SQLSERVER_SERVERS_FILE` / `SQLSERVER_SERVERS_JSON`. See `docs/MULTI_EDM.md`.

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
| GET | `/api/wildfire/active` |
| POST | `/api/wildfire/exposure` |
| GET | `/api/flood/active` |
| POST | `/api/flood/exposure` |
| GET | `/api/hazards/{tornado\|hail\|wildfire}` |
| GET | `/api/counties/{geographyId}/reference` |
| POST | `/api/calc/layers` |
| GET | `/api/admin/programmes` |
| PUT | `/api/admin/programmes/{fsDisplayId}/edm-link` |
| POST | `/api/admin/programmes/edm-links` |
| POST | `/api/admin/programmes/import` |
| GET | `/api/admin/connections` |
| GET | `/api/admin/cache` |
| POST | `/api/admin/cache/warmup` |
| DELETE | `/api/admin/cache` |
