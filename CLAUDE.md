# CLAUDE.md — Exposure Eclipse operating manual

> Auto-loaded into every conversation. Read it fully before writing code.
> The contract is **this file + `docs/CONTRACTS.md` + `docs/DATA_MODEL.md`**.

## What you're building

**Exposure Eclipse** — a web-based Property Cat exposure management workbench
for reinsurance underwriters. It turns ERT/EDM exposure outputs into an
interactive Mapbox choropleth + pivot + Excel-export pipeline, overlays
historical hurricane tracks + wind-field cones, and runs deterministic
layered-loss scenarios for the in-force portfolio.

**V1 = mock-data prototype.** No SQL Server. Mock provider satisfies the
same `ExposureDataProvider` ABC the SQL provider will satisfy later.

## Capability snapshot (June 2026)

- **Exposure map** — choropleth at state / county grain via Mapbox vector
  tilesets, peril multi-select, YoY, programme/chain/cedent/office/portfolio
  scopes, scope-filter chips (office / region / underwriter).
- **Pivot workbench** — county labels qualify by state; same scope as map.
- **Detail panel** — summary + breakdowns + county reference (population /
  avg replacement cost / households) for the clicked geography.
- **Hurricane impact engine** — click any storm on the map → IBTrACS-driven
  wind-field cone (eyewall Rmax + asymmetric R64 outer wash, per-quadrant
  bearing-interpolated). County capture uses R64 at the bearing to each
  county. Right-rail detail view expands per-county per-programme TIV
  breakdown. Excel export per impact.
- **Layer calc engine** — `POST /api/calc/layers` runs deterministic XOL
  scenarios (TIV × damage ratio through deductible/limit/share stacks),
  payout curves via the default damage-ratio sweep. Frontend UI not built
  yet — engine ready for a future "what-if" panel.
- **Excel export** — works for any scope (single deal, chain, cedent,
  portfolio, scope-filtered) and dumps the most-granular fact rows for
  inspection.

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

## Selection model (at-most-one)

`POST /api/exposures/{map,detail,pivot}` accepts AT MOST one of:
- `programmeId` — one programme/year
- `chainId` — latest programme; prior auto-paired (override via
  `comparisonProgrammeId`)
- `chainIds[]` — office-level multi-chain combination, OR the chains
  matching the active scope-filter chips (office / region / underwriter)
- `cedentId` — all chains under the cedent
- `datasetId` / `datasetGroupId` — legacy escape hatches
- **none** — **portfolio mode**: every currently in-force BOUND programme
  (status=BOUND AND today within [inception, expiry])

Frontend resolves this exactly once in `useEffectiveScope()`
(`frontend/src/state/useEffectiveScope.ts`); the map, pivot, export and
hurricane impact all consume that hook so they can't drift.

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
- **Hurricanes:** Live fetch of NOAA IBTrACS v04r01 NA-basin CSV via the
  backend; lru_cached. Single parse pass populates storm tracks (3-hour
  interpolated USA fixes), recon Rmax, and per-quadrant R64 indexes.
- **County reference:** us-atlas TopoJSON for centroids (lru_cached);
  ~35 curated census-style counties + deterministic synthesis for the rest.
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
