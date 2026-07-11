# MULTI_EDM — linking hundreds of pre-aggregated EDMs

Companion to `ARCHITECTURE.md`. Focused runbook for the multi-database data plane.

## Goal

Each programme points at an EDM via `EDMRef`:

```json
{
  "serverName": "BERMUDA-SQL01",
  "edmDatabaseName": "Re_BER_27_Farmers_BDA_EDM_01",
  "currency": "USD",
  "ertStatus": "ERT_READY"
}
```

Hundreds of programmes ⇒ hundreds of databases, usually on a **small set of
SQL hosts**. Facts are **pre-aggregated ERT cuts** (same conceptual shape as
`mockdata/exposure_facts/<datasetId>.json`), not location-level dumps.

## Components

| Module | Responsibility |
|---|---|
| `providers/fact_cache.py` | LRU + TTL cache; single-flight load per `datasetId` |
| `providers/parallel_load.py` | Bounded thread pool for multi-deal scopes |
| `providers/connection_registry.py` | `serverName` → host/user/password/driver |
| `providers/sql_row_map.py` | SQL/ERT columns → `ExposureFactNormalized` |
| `providers/sqlserver.py` | Catalog from `cedents.json` + SQL/mock fact load |
| `providers/mock.py` | Lazy JSON facts + same cache/parallel APIs |
| `api/admin.py` | `/cache`, `/cache/warmup`, `/connections` |

## Provider modes (`DATA_PROVIDER`)

| Value | Facts source | When to use |
|---|---|---|
| `mock` | `mockdata/exposure_facts/*.json` only | Default CI + offline demo |
| `hybrid` | SQL if `serverName` registered, else mock file | **Recommended demo** with partial live link-up |
| `sqlserver` | SQL only (no mock fallback) | Strict live environment |
| `databricks` | Not implemented | Placeholder |

## SQL table contract

Per EDM database, the loader tries in order:

1. **`ee_exposure_facts`** (preferred stable view you control)
2. Pattern from `SQLSERVER_EVOLUTION_TABLE_PATTERN` (default `{edm}__EVOLUTION`)

Columns may be:

- Demo/camelCase (`geographyId`, `tiv`, `locationCount`, …), or
- ERT-style (`Aggregation`, `Statecode`, `TIV`, `#Location`, `EXPLIM_GR`, …)

Mapping lives in `sql_row_map.py`. Prefer publishing a view that already
matches `ExposureFactNormalized` field names to reduce surprise.

## Registry file

Copy and edit:

```bash
cp mockdata/sql_servers.example.json mockdata/sql_servers.json
```

```json
{
  "BERMUDA-SQL01": {
    "host": "bermuda-sql01.example.local",
    "port": 1433,
    "user": "ee_readonly",
    "password": "…",
    "driver": "ODBC Driver 18 for SQL Server",
    "trustServerCertificate": true,
    "encrypt": true
  }
}
```

Env:

| Var | Purpose |
|---|---|
| `SQLSERVER_SERVERS_FILE` | Path to the JSON map |
| `SQLSERVER_SERVERS_JSON` | Inline JSON (optional) |
| `SQLSERVER_DEFAULT_USER` / `PASSWORD` / `DRIVER` | Defaults for incomplete entries |
| `FACT_CACHE_MAX_DATASETS` | LRU size (default 256) |
| `FACT_CACHE_TTL_SECONDS` | Refresh window (default 3600; `0` = LRU only) |
| `FACT_LOAD_MAX_WORKERS` | Parallelism (default 16) |

Install ODBC driver + Python binding:

```bash
pip install -e "backend[sql]"   # pyodbc
```

## Runtime behaviour

### Single programme

`get_facts_for_dataset(datasetId)` → cache → one file or one SQL DB.

### Portfolio / multi-chain / cedent

Collect many `datasetId`s → `get_facts_for_datasets` → parallel loads →
concatenate → existing grouping/calc (max-across-perils, etc.).

Failed EDM loads become **empty lists** (portfolio still renders; check logs /
cache load_errors).

### Warmup (do this before a live walkthrough)

```bash
curl -X POST http://localhost:8000/api/admin/cache/warmup \
  -H 'content-type: application/json' \
  -d '{"inForceOnly": true}'
```

Optional body: `{"datasetIds": ["ds-…", "ds-…"], "inForceOnly": false}`.

### Introspection

```bash
GET /api/admin/cache
GET /api/admin/connections
GET /api/admin/connections?probe=true   # live SELECT 1 per host
DELETE /api/admin/cache                 # flush all
DELETE /api/admin/cache?datasetId=ds-x  # flush one
GET /api/health                         # includes cache summary
```

## Performance expectations

| Situation | Expectation |
|---|---|
| Cold portfolio, N EDMs, mock JSON | Parallel disk parse; dominated by largest files |
| Warm portfolio (cache full) | Near-memory; calc-bound |
| Cold portfolio, N SQL DBs | Network + SQL; workers cap concurrent opens |
| Vercel serverless | Cache empty every cold start — prefer long-lived API host for multi-EDM demos |

**Rough capacity:** hundreds of *pre-aggregated* EDMs with `FACT_CACHE_MAX_DATASETS`
≥ active set and warmup before use. Raw location-level extracts will not fit
this path — keep ERT cuts.

## Operational checklist (link a new EDM)

1. Ensure programme exists in catalog (`cedents.json` or future catalog DB)
   with correct `edm.serverName`, `edm.edmDatabaseName`, `datasetId`.
2. Ensure server entry exists in `sql_servers.json`.
3. Ensure ERT cut / `ee_exposure_facts` is readable by the service account.
4. `GET /api/admin/connections?probe=true` → green for that host.
5. `DELETE /api/admin/cache?datasetId=…` if re-testing a failed load.
6. Hit map for that `programmeId`; confirm `/api/admin/cache` shows rows.
7. Spot-check TIV vs ERT workbook for one state.

## What this is not

- Not a replacement for ERT generation / RMS modeling.
- Not a global analytical warehouse (though facts are warehouse-shaped).
- Not multi-tenant auth-aware (no row-level security).
- Not durable across serverless instances without an external cache.

## Related docs

- `docs/FOR_INTERNAL_DEVELOPERS.md` — review + adopt guidance
- `docs/ARCHITECTURE.md` — system tree + env table
- `docs/DATA_MODEL.md` — `EDMRef` + fact schema
- `docs/ERT_OUTPUT_FORMAT.md` — source cut columns
- `backend/.env.example` — full knob list
