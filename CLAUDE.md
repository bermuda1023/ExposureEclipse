# CLAUDE.md — Exposure Eclipse operating manual

> Auto-loaded into every conversation. Read it fully before writing code.
> The contract is **this file + `docs/CONTRACTS.md` + `docs/DATA_MODEL.md`**.

## What you're building

**Exposure Eclipse** — a web-based Property Cat exposure management workbench
for reinsurance underwriters. It turns ERT/EDM exposure outputs into an
interactive Mapbox choropleth + pivot + Excel-export pipeline, and overlays
historical hurricane tracks for context.

**V1 = mock-data prototype.** No SQL Server. Mock provider satisfies the
same `ExposureDataProvider` ABC the SQL provider will satisfy later.

## The 10 rules (do not violate)

1. **Frontend never touches data sources.** All data flows
   *Frontend → FastAPI → Provider → mock JSON*.
2. **Mock data first.** `MockExposureDataProvider` reads `mockdata/cedents.json`
   + `mockdata/exposure_facts/<datasetId>.json`. SQL provider is later.
3. **Default group combination is `MAX_ACROSS_PERILS_AT_VIEW_GRAIN`.**
   Never sum TIV across distinct perils unless `SUM_DISTINCT_SEGMENTS` with
   `distinctSegmentsConfirmed=true`.
4. **Max-across-perils is computed at the current viewed grain** — every
   active grouping dimension (geography + pivot dims). See
   `docs/CALCULATIONS.md`.
5. **Never silently mix currencies.** Currency rides on every monetary value
   and is shown in every tooltip, panel, and export. Mismatch → block or warn.
6. **Every displayed number is traceable** to: source dataset(s) → filters
   → formula → currency → warnings.
7. **Don't guess business logic.** When ambiguous, pick a safe default, mark
   it as an assumption in a code comment.
8. **No hardcoded SQL table names, support email, or Mapbox token.** All from
   env (`.env.example` documents the surface).
9. **Excel export accuracy > formatting.** The export reuses the same router
   builder functions the screen uses — numbers must match.
10. **Use canonical enums from `docs/CONTRACTS.md`** in both `backend/app/models/enums.py`
    and `frontend/src/types/contracts.ts`. No ad-hoc string literals on the wire.

## The data model (the most important thing)

```
Cedent  (Farmers Group)        region: "Nationwide"
└── Office BDA                  ← click = union of BDA's chains
    ├── Chain "Nationwide"      ← click = chain; YoY auto-pairs latest vs prior
    │   ├── Programme 2027      ← multi-peril (perils: WS+EQ+CS)  → EDMRef
    │   ├── Programme 2026
    │   └── Programme 2025
    └── …
```

- **Cedent** = the insurer; carries a region bucket (Nationwide / California / Southeast).
- **Office** = where the deal is written (BDA / NYC / LON). Display tier only;
  resolved to `chainIds[]` for the API.
- **ProgrammeChain** = the renewal lineage (same deal slot year over year).
  Unit of YoY comparison.
- **Programme** = a specific treaty year. **Multi-peril by default** — its EDM
  may carry WS+EQ+CS rows together. The top-of-page peril multi-select filters.
- **EDMRef** = the SQL pointer (`serverName`, `edmDatabaseName`, currency,
  ertStatus, availableGranularity).

## Selection model (one-of)

`POST /api/exposures/{map,detail,pivot}` accepts exactly one of:
- `programmeId` — one programme/year
- `chainId` — latest programme; prior auto-paired (override via
  `comparisonProgrammeId`)
- `chainIds[]` — office-level multi-chain combination
- `cedentId` — all chains under the cedent
- `datasetId` / `datasetGroupId` — legacy escape hatches

Plus `perils: Peril[]` (multi-select; empty = ALL), `metric: MetricKey`,
`aggregationLevel: AggregationLevel`, `filters: ExposureFilters`,
`yoyMode: bool`.

## The golden path

Open app → pick a cedent / office / chain / programme in the left rail →
peril multi-select up top → map paints state level → scroll-zoom past
~zoom 4 → county vector tileset takes over → hover for full tooltip
(geo, active metric, YoY delta if on, other metrics, currency, warnings)
→ click → detail panel populates → optionally enable hurricane overlay
→ Export to Excel.

## Tech stack (pinned)

- **Frontend:** React 18 + TS 5 + Vite 5 + Mapbox GL JS v3, TanStack Query v5,
  Zustand, react-resizable-panels v2, Vitest + Testing Library.
- **Backend:** Python 3.12 + FastAPI + Pydantic v2 + openpyxl. No pandas in
  prod (slimmed for Vercel). pytest + httpx for tests.
- **Map geometry:** Mapbox vector tilesets (state + county), not GeoJSON.
  Tilesets defined in `frontend/src/components/Map/MapView.tsx`.
- **Hurricanes:** Live fetch of NOAA HURDAT2 via the backend; lru_cached.
- **Deploy:** Vercel (single project: static SPA + Python serverless function).
  See `docs/DEPLOY.md`.

## Project layout

```
api/                  Vercel Python entrypoint (api/index.py re-exports app.main:app)
backend/app/          FastAPI app, providers, services, models
backend/scripts/      Data-generation / merge scripts
backend/tests/        pytest
frontend/src/         React app — never imports a data client
mockdata/             cedents.json + exposure_facts/*.json + ied_industry.csv
docs/                 lean specification pack (~6 files)
vercel.json           single-deploy config
```

See `docs/ARCHITECTURE.md` for the directory tree in detail.

## Per-task required reading (token discipline)

| Task | Read |
|---|---|
| Always-loaded | `CLAUDE.md` + `docs/CONTRACTS.md` |
| Data model / mock / fact rows | `docs/DATA_MODEL.md`, `docs/MOCK_DATA.md`, `docs/ERT_OUTPUT_FORMAT.md` |
| Calculations / grouping | `docs/CALCULATIONS.md` |
| API endpoints | `docs/API.md` |
| Architecture / deploy | `docs/ARCHITECTURE.md`, `docs/DEPLOY.md` |

When delegating to sub-agents: scope them to the row above + `CONTRACTS.md`,
nothing more. Agents return diffs/summaries, not file dumps.

## How to work each task

For every implementation step, report: **files changed → what changed → how
to run → how to test → assumptions → next step.** Keep diffs small.
