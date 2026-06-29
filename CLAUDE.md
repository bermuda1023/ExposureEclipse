# CLAUDE.md — Exposure Eclipse operating manual

> Auto-loaded into every conversation. Read it fully before writing code.
> The contract is **this file + `docs/CONTRACTS.md` + `docs/DATA_MODEL.md`**.

## What you're building

**Exposure Eclipse** — a web-based Property Cat exposure management workbench
for reinsurance underwriters. Turns ERT/EDM exposure outputs into an
interactive Mapbox choropleth + pivot + Excel-export pipeline, overlays
historical hurricane tracks + asymmetric wind-field cones, runs deterministic
layered-loss scenarios, supplies a tornado / hail hazard climatology, plus
NHC-style live-storm forecasts with marine + alert + SST context.

**V1 = mock-data prototype.** No SQL Server. `MockExposureDataProvider`
satisfies the same `ExposureDataProvider` ABC the SQL provider will satisfy
later.

## Capability snapshot (2026-06-29)

- **Exposure map** — choropleth at state / county grain via Mapbox vector
  tilesets, peril multi-select, YoY, programme/chain/cedent/office/portfolio
  scopes, scope-filter chips (office / region / underwriter).
- **Pivot workbench** — county labels qualify by state; same scope as map.
- **Detail panel** — summary + breakdowns + county reference (population,
  households, avg replacement cost) for the clicked geography.
- **Hurricane impact engine** — click any storm → IBTrACS-driven wind-field
  cone (eyewall Rmax + asymmetric R64 per-quadrant bearing-interpolated).
  County capture uses R64 at the bearing to each county; right-rail detail
  shows per-county per-programme TIV. Per-impact Excel export. Storms can be
  filtered by **landfall state** before browsing.
- **Hurricane loss assumptions (user-driven)** — per-SSHWS-category mean +
  SD damage-ratio inputs (`damageAssumptions` zustand store) produce a
  probabilistic loss band; per-county **exposed-fraction overrides**
  (`countyOverrides` store) let an underwriter override partial-county
  exposure. Both persist to localStorage.
- **Live + replay storms** — `/api/live/storms`. NHC `CurrentStorms.json`
  for active storms; IBTrACS-derived replay for retired ones. Bundle adds
  observed track, advisory history (synthetic forecast cone), NWS active
  alerts within the cone, NDBC buoys + NWS land-station obs, and a JPL MUR
  SST grid for the bbox.
- **Hazard overlays** — `/api/hazards/{tornado|hail|wildfire}` returns a
  pre-baked 0.2° lat/lon hazard-index grid. Tornado + hail blend the real
  SPC SVRGIS shapefile (KDE-smoothed, recency- and mag-weighted) with a
  smooth Brooks/Tippett/Cintineo climatology prior (60% climatology / 40%
  history) — no per-city bias correction. Wildfire is acres-weighted KDE of
  WFIGS perimeters; wildfire chip is currently hidden in the UI but the
  endpoint + grid are live.
- **Admin programmes** (`/admin/programmes`) — treaty-metadata table that
  maps each FS-display treaty ID → its EDM server + database, with CSV
  import and auto-suggest. Not linked from the header nav.
- **Layer calc engine** — `POST /api/calc/layers` runs deterministic XOL
  scenarios (TIV × damage ratio through deductible/limit/share stacks),
  payout curves via the default damage-ratio sweep. Engine is wired; no
  frontend UI yet.
- **Excel export** — works for any scope (single deal, chain, cedent,
  portfolio, scope-filtered) and dumps the most-granular fact rows.

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
(`frontend/src/state/useEffectiveScope.ts`); map, pivot, export and
hurricane impact all consume that hook so they can't drift.

Plus `perils: Peril[]` (multi-select; empty = ALL), `metric: MetricKey`,
`aggregationLevel: AggregationLevel`, `filters: ExposureFilters`,
`yoyMode: bool`.

## The golden path

Open app → pick a cedent / office / chain / programme in the left rail →
peril multi-select up top → map paints state level → scroll-zoom past
~zoom 4 → county tileset takes over → hover for full tooltip (geo, active
metric, YoY Δ if on, other metrics, currency, warnings) → click → detail
panel populates → optionally toggle Hurricanes / Risk: Tornado / Hail
overlays (overlays hide the exposure choropleth while active) → Export to
Excel.

## Tech stack (pinned)

- **Frontend:** React 18 + TS 5 + Vite 5 + Mapbox GL JS v3, TanStack Query
  v5, Zustand (persist middleware on `damageAssumptions` + `countyOverrides`),
  react-resizable-panels v2, Vitest + Testing Library.
- **Backend:** Python 3.12 + FastAPI + Pydantic v2 + openpyxl. No pandas in
  prod (slimmed for Vercel). pytest + httpx for tests.
- **Map geometry:** Mapbox vector tilesets (state + county), not GeoJSON.
  Tilesets defined in `frontend/src/components/Map/MapView.tsx`.
- **Hurricanes:** Live-fetch NOAA IBTrACS v04r01 NA-basin CSV; lru_cached.
  Single parse populates storm tracks (3-hour interpolated USA fixes),
  recon Rmax, per-quadrant R64 indexes.
- **Live storms:** NHC `CurrentStorms.json` + NWS `api.weather.gov` alerts
  + NDBC `latest_obs.txt` buoys + JPL MUR SST via ERDDAP CSV.
- **County reference:** us-atlas TopoJSON for centroids (lru_cached);
  ~35 curated census-style counties + deterministic synthesis for the rest.
- **Hazard grids:** built offline by `backend/scripts/build_{tornado,hail,
  wildfire}_grid.py` (requires `pyshp` for shapefile reads — dev dep only);
  baked into `mockdata/hazard_*_grid.json` and served by `/api/hazards/{type}`.
- **Deploy:** Vercel (single project: static SPA + Python serverless).
  See `docs/DEPLOY.md`.

## Project layout

```
api/                  Vercel Python entrypoint (api/index.py re-exports app.main:app)
backend/app/          FastAPI app — api/ (routers), services/, models/, providers/
backend/scripts/      Data-generation + hazard-grid build scripts
backend/tests/        pytest (95)
frontend/src/         React app — never imports a data client
mockdata/             cedents.json + exposure_facts/ + treaty_metadata.json
                      + hazard_*_grid.json + ied_industry.csv
docs/                 spec pack
vercel.json           single-deploy config
```

See `docs/ARCHITECTURE.md` for the directory tree in detail.

## Per-task required reading (token discipline)

| Task | Read |
|---|---|
| Always-loaded | `CLAUDE.md` + `docs/CONTRACTS.md` |
| Data model / mock / fact rows | `docs/DATA_MODEL.md`, `docs/MOCK_DATA.md`, `docs/ERT_OUTPUT_FORMAT.md` |
| Calculations / grouping / impact / layers | `docs/CALCULATIONS.md` |
| API endpoints | `docs/API.md` |
| Architecture / deploy | `docs/ARCHITECTURE.md`, `docs/DEPLOY.md` |
| Hazard maps + bias correction | `docs/CALCULATIONS.md` §Hazard climatology blend |

When delegating to sub-agents: scope them to the row above + `CONTRACTS.md`,
nothing more. Agents return diffs/summaries, not file dumps.

## How to work each task

For every implementation step, report: **files changed → what changed → how
to run → how to test → assumptions → next step.** Keep diffs small.
