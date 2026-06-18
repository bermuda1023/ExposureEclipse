# DATA_MODEL — Cedent → Office → Chain → Programme

The navigation entity. Replaces the flat `DatasetRegistry` rows of the
pre-cedent design.

```
Cedent  (Farmers Group)        region: "Nationwide"
├── Office BDA                  ← display tier only; resolves to chainIds[]
│   ├── ProgrammeChain "Farmers Nationwide"
│   │   ├── Programme 2027     perils: [WS,EQ,CS]   → EDMRef → SQL pointer
│   │   ├── Programme 2026
│   │   └── Programme 2025
│   └── …
└── Office NYC
    └── ProgrammeChain "Farmers Florida-Only"
        ├── Programme 2027     perils: [WS]
        └── Programme 2026
```

## Cedent

| Field | Type | Notes |
|---|---|---|
| `cedentId` | string | stable id |
| `cedentName` | string | display name |
| `region` | string \| null | short bucket — `Nationwide` / `California` / `Southeast` |
| `notes` | string \| null | optional (no longer rendered) |
| `chains` | ProgrammeChain[] | one or more |

Selecting a cedent = union of every chain's latest-year programme,
combined under `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` (CLAUDE.md rule 3).

## Office (display tier)

Not a separate entity — derived from `chain.office`. Selecting an office
unions every chain in that office. Only three offices in v1: **BDA**, **NYC**,
**LON**. Resolution happens in the frontend (CedentTree → `chainIds[]`),
then the backend treats it like a multi-chain combination.

## ProgrammeChain

| Field | Type | Notes |
|---|---|---|
| `chainId` | string | stable id |
| `cedentId` | string | parent |
| `chainName` | string | display name (e.g. "Farmers Nationwide") |
| `office` | string | `BDA` / `NYC` / `LON` |
| `defaultPeril` | Peril | metadata; can be `ALL` |
| `programmes` | Programme[] | ordered newest-first by treatyYear |

A chain is the **unit of YoY comparison**: clicking a chain auto-pairs
the latest programme with its prior. Override via `comparisonProgrammeId`.

## Programme

| Field | Type | Notes |
|---|---|---|
| `programmeId` | string | stable id |
| `chainId` | string | parent |
| `cedentId` | string | grandparent |
| `programmeName` | string | display |
| `treatyYear` | int | |
| `perils` | Peril[] | **canonical** — perils this EDM carries |
| `peril` | Peril | legacy single-peril label (defaults to `ALL`) |
| `office` | string | mirrors chain.office |
| `underwriter` | string | |
| `status` | string | `bound` \| `quoted` \| `written` (free-text v1) |
| `layer` | string \| null | e.g. `"$100M xs $50M"` (not currently displayed) |
| `signedShare` | float \| null | e.g. `0.20` |
| `inceptionDate` / `expiryDate` | datetime \| null | |
| `notes` | string \| null | |
| `edm` | EDMRef | the SQL/EDM pointer |
| `datasetId` | string | the legacy fact-file key (`mockdata/exposure_facts/<datasetId>.json`) |

**Multi-peril by default.** An office's annual EDM typically bundles WS+EQ+CS
together. The top-of-page peril multi-select filters which perils get
rendered. `Programme.peril` is kept only for compatibility with single-peril
metadata.

## EDMRef

| Field | Type | Notes |
|---|---|---|
| `serverName` | string | |
| `edmDatabaseName` | string | |
| `currency` | string | ISO 4217 |
| `ertStatus` | ErtStatus | `ERT_READY` \| `ERT_PARTIAL` \| `ERT_NOT_FOUND` \| `ERT_ERROR` |
| `availableGranularity` | AggregationLevel[] | subset of COUNTRY/STATE/COUNTY/CRESTA |
| `lastGeneratedAt` | datetime \| null | |
| `exposureDataCutoffDate` | datetime \| null | |

The SQL data-source pointer that used to live on `DatasetRegistry`. Frontend
never imports this directly — it rides inside a Programme.

## ExposureFactNormalized (the row calc operates on)

The conceptual analytical row the backend exposes from ERT outputs. All
calculations operate on this shape so providers are swappable. Stored as JSON
per dataset_id under `mockdata/exposure_facts/<datasetId>.json` for the mock
provider.

| Field | Type | Notes |
|---|---|---|
| `datasetId` | string | matches Programme.datasetId |
| `portname` | string | ERT `PORTNAME` snapshot, MMDDYYYY |
| `sourceServerName` / `sourceDatabaseName` / `sourceTableName` | string | traceability |
| `aggregation` / `geographyLevel` | AggregationLevel | the row's grain |
| `country` / `countryName` | string \| null | e.g. `US` / `United States` |
| `statecode` / `stateName` | string \| null | e.g. `FL` / `FLORIDA` |
| `county` / `countyName` | string \| null | FIPS / display |
| `cresta` / `crestaName` | string \| null | optional |
| `geographyId` | string | canonical key — `US`, `US-FL`, `US-FL-12086`, `CRESTA-…` |
| `peril` | Peril | `EQ` / `WS` / `CS` / `FL` / `FR` / `TR` |
| `occupancy` / `occupancyGroup` | string \| null | from ERT |
| `occupancySegment` | OccupancySegment | `RESIDENTIAL` / `COMMERCIAL` / `INDUSTRIAL` / `UNKNOWN` |
| `construction` / `yearBuilt` / `distanceToCoast` / `geocodingQuality` / `numberOfStories` | string \| null | dimension bands |
| `building` / `contents` / `bi` | float | TIV components |
| `tiv` | float | **must equal** Building + Contents + BI |
| `explimGross` / `explimNet` | float | exposure bases |
| `locationCount` | int | |
| `accountCount` | int \| null | |
| `invalidTiv` / `invalidCount` | float? / int? | data quality |
| `currency` | string | ISO 4217 |
| `exposureDataCutoffDate` | datetime \| null | |

## Relationships

```
Cedent 1──N ProgrammeChain ──N Programme ──1 EDMRef
                                  │
                                  └──── datasetId ──→ exposure_facts/<id>.json
                                                              (ExposureFactNormalized[])

IEDIndustryExposure (mockdata/ied_industry.csv)
  └── joined to facts by geographyId (+ optional occupancy segment) for market share
```

## Geometry IDs

ISO-ish stable keys. The Mapbox vector tilesets render against these:

| Level | Format | Example |
|---|---|---|
| COUNTRY | ISO-2 | `US` |
| STATE | `US-{USPS}` | `US-FL` |
| COUNTY | `US-{USPS}-{FIPS5}` | `US-FL-12086` |
| CRESTA | `CRESTA-{scheme}` | `CRESTA-US_01` |

FIPS↔USPS lookup lives in both `backend/scripts/build_geo.py` (for any
geometry generation) and `frontend/src/components/Map/fipsToUsps.ts` (for
joining tileset features to API rows).
