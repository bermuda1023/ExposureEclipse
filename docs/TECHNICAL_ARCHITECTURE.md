# Technical Architecture — Exposure Eclipse

> The non-negotiable: **frontend never queries SQL Server, Databricks, stored procedures, or
> internal tables.** Frontend → FastAPI → Provider → data source. The backend owns data
> access, calculations, exports, jobs, and error reporting. Stack/versions in
> `STACK_AND_SETUP.md`; layout in `PROJECT_STRUCTURE.md`.

## Layers

```
React Frontend  (src/api is the ONLY transport boundary)
  Map · Filters · Dataset Selector · Pivot · Detail Panel · Warnings · Export controls
        ↓  HTTP /api
FastAPI Backend
  API routers (thin)  ·  validation (Pydantic v2)
  Calculation service  ·  Grouping service  ·  Warning service
  Export service  ·  Background job service  ·  Email service
        ↓  ExposureDataProvider interface
Data Access Abstraction
  MockExposureDataProvider (v1)  ·  SqlServerExposureDataProvider (v1+)  ·  DatabricksExposureDataProvider (v2)
        ↓
Source systems
  EDM databases · ERT output tables · RMS IED static table · manual metadata · (v2) SRS/Front Sheet
```

## Provider interface

One interface, many implementations, identical API contracts:

```text
ExposureDataProvider
  list_datasets(filters)
  get_dataset_status(dataset_id)
  get_map_data(request)
  get_detail_data(request)
  get_pivot_data(request)
  get_market_share_data(request)
  get_yoy_data(request)
  list_dataset_groups() / create_dataset_group(req)
  run_ert_job(req) / get_ert_job_status(job_id)
```

- Concrete provider selected at startup by `DATA_PROVIDER` env (factory).
- Providers return data shaped as `ExposureFactNormalized` (or the API response models);
  **calculations live in services, not providers**, so math is provider-independent.
- Contract parity tests (Phase 9+) assert mock and SQL providers return identical shapes.

## Key design decisions

- **Calc once, reuse everywhere.** `services/calculations.py` + `grouping.py` back the map,
  detail, pivot, and export. No surface recomputes a metric.
- **Enums are shared.** `backend/app/models/enums.py` and `frontend/src/types/contracts.ts`
  both derive from `CONTRACTS.md`. Treat drift as a bug.
- **Currency is explicit end-to-end.** Carried on every monetary value; never silently mixed.
- **Config over hardcoding.** Table names (`ExpectedERTTable`), support email, Mapbox token,
  provider selection — all via config/env.
- **Async ERT jobs.** In-process `asyncio` + job store in v1 (`BACKGROUND_JOBS_SPEC.md`); no
  external broker until needed.

## Build strategy

Phase 1 mock data proves UI/API/map/pivot/warnings/export. Phase 2 adds the SQL provider
behind the same contract. Phase 3+ adds Databricks without frontend changes. Full sequence in
`IMPLEMENTATION_PLAN.md`.

## Cross-cutting concerns

- **Validation** at the API boundary (Pydantic) using canonical enums.
- **Errors:** standard envelope + codes (`ERROR_HANDLING.md`); domain outcomes returned in
  body as warnings/status, not HTTP errors.
- **Observability:** structured logs keyed by `traceId`; never log secrets.
- **Testing:** calculations get the deepest coverage (`TEST_PLAN.md`).
