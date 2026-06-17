# Data Model — Exposure Eclipse

> Conceptual entities and typed fields. In v1 several of these are mock fixtures (JSON/CSV);
> backend responses must behave as if the normalized shapes below exist regardless of
> provider. Enum-typed fields reference `CONTRACTS.md`. Field names here are logical; the
> API serializes to `camelCase`.

Type legend: `string`, `int`, `decimal`, `bool`, `datetime`, `enum:<Name>`, `?` = nullable.

## DatasetRegistry
One registered EDM/dataset.

| Field | Type | Notes |
|---|---|---|
| DatasetId | string | stable id |
| ServerName | string | |
| EDMDatabaseName | string | e.g. `Re_BER_27_Farmers_HU_EDM_01` |
| TreatyYear | int | |
| CedentName | string? | manual in v1 |
| ProgrammeName | string? | manual in v1 |
| YearOfAccount | int? | |
| Currency | enum:Currency | ISO 4217 |
| ExposureDataCutoffDate | datetime? | |
| PriorExposureDataCutoffDate | datetime? | |
| AvailableGranularity | enum:AggregationLevel[] | subset of COUNTRY/STATE/COUNTY/CRESTA |
| ERTStatus | enum:ErtStatus | |
| LastERTGeneratedAt | datetime? | |
| IsIncludedInPortfolio | bool | drives portfolio scope (v1) |
| CreatedAt / UpdatedAt | datetime | |

## DatasetMetadata
Manual metadata before Front Sheet/SRS (v2 replaces).

| Field | Type |
|---|---|
| DatasetId | string |
| Office / Underwriter / ProductClass | string? |
| CedentName / Broker / ProgrammeName | string? |
| YearOfAccount | int? |
| Currency | enum:Currency |
| Notes | string? |

## DatasetGroup
Multiple EDMs as one analytical programme.

| Field | Type | Notes |
|---|---|---|
| DatasetGroupId | string | |
| GroupName | string | |
| CedentName / ProgrammeName | string? | |
| YearOfAccount | int? | |
| Currency | enum:Currency | all members must match (or conversion assumption) |
| CombinationMethod | enum:CombinationMethod | default `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` |
| DistinctSegmentsConfirmed | bool | required `true` for `SUM_DISTINCT_SEGMENTS` |
| CreatedBy / CreatedAt | string / datetime | |
| Notes | string? | |

## DatasetGroupMember

| Field | Type |
|---|---|
| DatasetGroupId | string |
| DatasetId | string |
| ServerName / EDMDatabaseName | string |
| Peril | enum:Peril |
| IncludedFlag | bool |
| SortOrder | int |

## ExpectedERTTable
Configurable registry of expected standardized ERT outputs — **names are not hardcoded**.

| Field | Type | Notes |
|---|---|---|
| ExpectedTableId | string | |
| TableType | string | the 7 real ERT cuts (see `ERT_OUTPUT_FORMAT.md`): `TIV_SUMMARY`, `EVOLUTION`, `CONSTRUCTION_SUMMARY`, `YEARBUILT_SUMMARY`, `NUMBEROFSTORIES_SUMMARY`, `PERIL_DETAILS`, `DISTANCE_TO_COAST` |
| AggregationLevel | enum:AggregationLevel? | |
| TableNamePattern | string | pattern resolved from EDM/year/currency/peril/level (TBD — OPEN_QUESTIONS) |
| RequiredForV1 | bool | drives `ERT_READY` vs `ERT_PARTIAL` |
| Description | string | |

ERT status logic: all `RequiredForV1` tables present → `ERT_READY`; some present →
`ERT_PARTIAL`; none → `ERT_NOT_FOUND`.

## IEDIndustryExposure
Static RMS IED industry TIV — market-share denominator.

| Field | Type | Notes |
|---|---|---|
| GeographyLevel | enum:AggregationLevel | has county-level rows |
| Country / State / County / CRESTA | string? | identifiers per level |
| OccupancySegment | enum:OccupancySegment | may be `UNKNOWN` |
| IndustryTIV | decimal | denominator |
| Currency | enum:Currency | |
| SourceYear | int | |

Include intentional gaps in mock to exercise `WARN_IED_DENOMINATOR_MISSING`.

## ExposureFactNormalized
Conceptual normalized analytical row the backend exposes from ERT outputs (the `Evolution`
cut is the closest real analogue — see `ERT_OUTPUT_FORMAT.md`). May not exist physically in
v1, but **all calculations operate on this shape** so providers are swappable.

| Field | Type | Notes |
|---|---|---|
| DatasetId | string | |
| DatasetGroupId | string? | |
| Portname | string | ERT `PORTNAME` snapshot, `MMDDYYYY` (= ExposureDataCutoffDate) |
| SourceServerName / SourceDatabaseName / SourceTableName | string | traceability |
| Aggregation | enum:AggregationLevel | ERT `Aggregation` discriminator (Country/State/…) |
| GeographyLevel | enum:AggregationLevel | = Aggregation |
| Country / CountryName | string? | e.g. `US` / `United States` |
| Statecode / StateName | string? | e.g. `TX` / `TEXAS` |
| County / CRESTA / CrestaName | string? | `CrestaName` may be `No Cresta`/`blank` |
| GeographyId | string | canonical key (`US`, `US-FL`, `US-FL-12086`, …) |
| Peril | enum:Peril | `EQ, WS, CS, FL, FR, TR` |
| Occupancy | string? | raw ERT occupancy (e.g. `Permanent`) |
| OccupancyGroup | string? | e.g. `Res-MFD`, `Res-SFD` |
| OccupancySegment | enum:OccupancySegment | derived (RES/COM/IND/UNKNOWN) |
| Construction | string? | `Masonry` / `Reinforced` / `Wood` / … |
| YearBuilt | string? | band (`1980 to 2000`, `Unknown`, …) |
| DistanceToCoast | string? | lettered band (`g=> +10 Miles from Coast`) |
| GeocodingQuality | string? | `Coordinate` / `Street/Parcel` / `Postal code` / `Block Group` |
| NumberOfStories | string? | band (`1-3 stories`, `(blank)`, …) |
| Building / Contents / BI | decimal | TIV components |
| TIV | decimal | = Building + Contents + BI |
| ExplimGross | decimal | `EXPLIM_GR` |
| ExplimNet | decimal | `EXPLIM_NET` |
| LocationCount | int | `#Location` |
| AccountCount | int? | `#Account` |
| InvalidTIV | decimal? | data quality |
| InvalidCount | int? | `#Invalid` data quality |
| Currency | enum:Currency | |
| ExposureDataCutoffDate | datetime? | parsed from Portname |

## BackgroundJob
See `BACKGROUND_JOBS_SPEC.md`. Fields: JobId, ServerName, EDMDatabaseName, TreatyYear,
Currency, Peril, AggregationLevels, StartedBy, StartedAt, CompletedAt,
Status(enum:JobStatus), ErrorMessage?, OutputTablesGenerated[], RowsGenerated,
InputParametersJson, TablesChecked[], TablesGeneratedBeforeFailure[].

## Relationships

```
DatasetRegistry 1───* DatasetGroupMember *───1 DatasetGroup
DatasetRegistry 1───1 DatasetMetadata (v1 manual)
DatasetRegistry 1───* ExposureFactNormalized
IEDIndustryExposure  — joined to facts by geography (+ occupancy segment) for market share
ExpectedERTTable     — config; matched against actual tables to derive ErtStatus
BackgroundJob        — produced by ERT run/rerun against a Dataset
```
