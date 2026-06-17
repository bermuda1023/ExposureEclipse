# Background Jobs Specification — Exposure Eclipse

> The ERT SQL generation routine may be long-running. It must never lock the frontend or
> block the user. Enum values from `CONTRACTS.md §7`. API in `API_SPEC.md`.

## Principle

Run/Rerun ERT is **asynchronous**: the API returns a `jobId` immediately; the frontend
polls status and updates the ERT badge; the user keeps working meanwhile.

## v1 implementation

In-process `asyncio` task + a job store (in-memory dict, or SQLite for persistence across
reloads). No external broker/queue in v1. The mock provider simulates job duration and a
designated "always-fails" EDM (see `MOCK_DATA_SPEC.md`).

## Job flow

```
User clicks Run/Rerun ERT
  → POST /api/ert-jobs/run
  → backend creates job record (status: queued), returns jobId (202)
  → backend starts ERT process asynchronously (status: running)
  → frontend polls GET /api/ert-jobs/status/{jobId}
  → frontend updates the ERT status badge
On completion  → status: completed → refresh dataset status
On failure     → status: failed → smart error shown + optional error email sent
On cancel      → status: cancelled
```

## When it runs

Only when outputs are missing/partial/stale, or the user explicitly requests rerun. **Never
on every dataset open.** `rerun: true` is required to overwrite existing outputs (overwrite
semantics are **[OPEN]** — confirm before SQL integration).

## Job statuses

`queued` → `running` → `completed` | `failed` | `cancelled`.

## Job metadata (persisted)

JobId, ServerName, EDMDatabaseName, TreatyYear, Currency, Peril, AggregationLevels,
StartedBy, StartedAt, CompletedAt, Status, ErrorMessage, OutputTablesGenerated[],
RowsGenerated, InputParametersJson, TablesChecked[], TablesGeneratedBeforeFailure[].

## Polling guidance

Frontend polls every ~2s while `queued`/`running` (back off to ~5s after 30s); stop on
terminal status. Use TanStack Query with `refetchInterval` keyed on status.

## Failure requirements

On failure, capture and surface (and include in the error email, see `ERROR_HANDLING.md`):
server name, database name, procedure name, all input parameters, timestamp, error message,
stack trace or log ID, tables checked, tables generated before failure. Plus the user
context (current/prior dataset, group, combination method, currency, active filters).

## Concurrency & cleanup

- Guard against duplicate concurrent jobs for the same `(server, edm)` — return the existing
  running `jobId` instead of starting a second.
- Retain completed/failed job records long enough for the UI to read final status and for
  the error report; define a simple TTL/cleanup.
