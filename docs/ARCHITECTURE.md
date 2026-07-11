# ARCHITECTURE — repo layout, stack, key boundaries, gotchas

> New to the repo? Engineers should read
> [`FOR_INTERNAL_DEVELOPERS.md`](./FOR_INTERNAL_DEVELOPERS.md) first.
> Multi-DB runbook: [`MULTI_EDM.md`](./MULTI_EDM.md).

## Tree

```
ExposureEclipse/
├── CLAUDE.md                ← operating manual (auto-loaded)
├── README.md
├── docs/                    spec pack
│   ├── FOR_INTERNAL_DEVELOPERS.md  engineer onboarding + review guide
│   ├── MULTI_EDM.md          multi-host SQL + cache runbook
│   ├── ARCHITECTURE.md       (this file)
│   ├── DATA_MODEL.md
│   ├── CONTRACTS.md          ⭐ canonical enums
│   ├── API.md
│   ├── CALCULATIONS.md
│   ├── MOCK_DATA.md
│   ├── DEPLOY.md
│   ├── ERT_OUTPUT_FORMAT.md  source schema reference
│   └── GLOSSARY.md
├── vercel.json               single-project: /api/* → serverless, /* → SPA
├── api/
│   ├── index.py              Vercel Python entrypoint, re-exports app.main:app
│   └── requirements.txt      lean runtime deps
├── backend/
│   ├── pyproject.toml
│   ├── .env.example
│   ├── app/
│   │   ├── main.py           FastAPI app, CORS, exception → ErrorEnvelope
│   │   ├── config.py         Pydantic Settings
│   │   ├── api/              thin routers
│   │   │     admin           treaty metadata + EDM linkage + cache/connections
│   │   │     calc            layered-loss engine (/api/calc/layers)
│   │   │     cedents         cedent tree + chain + programme + status
│   │   │     counties        per-county reference data
│   │   │     dataset_groups  legacy ad-hoc group store
│   │   │     ert_jobs        in-process ERT-job lifecycle (mock)
│   │   │     exports         Excel streaming
│   │   │     exposures       /map /detail /pivot (parallel multi-EDM resolve)
│   │   │     hazards         tornado / hail / wildfire pre-baked grids
│   │   │     hurricanes      historical IBTrACS storms + impact engine
│   │   │     live            NHC active + IBTrACS replay + alerts + buoys + SST
│   │   ├── models/           Pydantic v2 (cedent, exposure, dataset, jobs, warnings, enums, common)
│   │   ├── providers/        ABC + mock + sqlserver/hybrid + fact_cache +
│   │   │                       connection_registry + parallel_load + sql_row_map
│   │   ├── services/
│   │   │     calculations      core metric math
│   │   │     grouping          max-across-perils at the view grain
│   │   │     county_reference  curated + synthetic county stats
│   │   │     email             noop / smtp / graph transport
│   │   │     export_excel      openpyxl workbook builder
│   │   │     hazard_overlay    in-memory loader for hazard_*_grid.json
│   │   │     hurdat2           helpers (category_for_wind, landfall, peak)
│   │   │     hurricane_impact  IBTrACS cone + R64 capture + per-programme rollup
│   │   │     ibtracs           IBTrACS NA-basin parser (tracks + Rmax + R64 quads)
│   │   │     jobs              ERT-job state machine
│   │   │     layer_calc        deterministic XOL math
│   │   │     live_hurricane    NHC parser + advisory-history synthesiser
│   │   │     marine_obs        NDBC buoy + NWS land-station fetch
│   │   │     sea_surface_temp  JPL MUR SST via ERDDAP CSV + US-land mask
│   │   │     treaty_metadata   treaty rows + EDM linkage CSV
│   │   │     weather_alerts    NWS api.weather.gov active-alert fetch
│   │   └── ert/              ExpectedERTTable registry
│   ├── scripts/              data-generation + hazard-grid builders
│   │     _climatology         smooth Brooks/Tippett/Cintineo Gaussian anchors
│   │     _pop_bias            (unused; kept for reference — see CALCULATIONS.md)
│   │     backfill_county_rows / build_geo / generate_extra_facts /
│   │     merge_farmers_bda    fact-data helpers
│   │     build_tornado_grid   pyshp SPC SVRGIS → mockdata/hazard_tornado_grid.json
│   │     build_hail_grid      pyshp SPC SVRGIS → mockdata/hazard_hail_grid.json
│   │     build_wildfire_grid  CSV WFIGS → mockdata/hazard_wildfire_grid.json
│   └── tests/                pytest (~107, incl. multi-EDM cache/parallel)
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── postcss.config.js     ← intentional: stops Vite from picking up parent-dir Tailwind configs
│   ├── .env.example
│   ├── tsconfig.json
│   └── src/
│       ├── App.tsx           path-based router: / → Shell, /admin/programmes → AdminProgrammes
│       ├── main.tsx          QueryClient + design-token CSS
│       ├── api/              the ONLY place that hits the backend
│       │     admin, cedents, client, exports, exposures, hazards, hurricanes,
│       │     jobs, live, hooks, types
│       ├── components/
│       │   ├── layout/         Shell, Header (built by Anfossi Capital), WarningsPanel
│       │   ├── CedentTree/     tree rail + ErtBadge + StatusBadge (BOUND/QUOTED/...)
│       │   ├── Map/            MapView + MetricSelector + PerilSelector + YoyToggle
│       │   │                   HurricaneLayer + HurricaneControls + HurricaneImpactPanel
│       │   │                   LiveStormLayer + LiveStormPanel
│       │   │                   HazardOverlayControls + HazardOverlayLayer + HazardOverlayLegend
│       │   │                   colour-ramp, fipsToUsps, Tooltip
│       │   ├── DetailPanel/    DetailPanel + CountyReferenceSection + HurricaneImpactDetail
│       │   ├── Pivot/          pivot workbench
│       │   ├── ErtJob/         run/poll indicator + hook
│       │   └── ExportButton/
│       ├── pages/AdminProgrammes.tsx   treaty-metadata admin table (CSV import + EDM link)
│       ├── state/              Zustand stores
│       │     selection         current cedent / office / chain / programme
│       │     view              metric / aggregation / yoy
│       │     filters           top-of-page perils + ExposureFilters
│       │     scopeFilters      office / region / underwriter chips
│       │     hurricanes        catalog filters incl. landfallStates[]
│       │     hurricaneImpact   selected impact view-state
│       │     liveStorm         active live-storm picker state
│       │     hazardOverlay     active hazard chip (tornado | hail | wildfire | null)
│       │     damageAssumptions per-SSHWS-category {mean, sd} loss inputs (persisted)
│       │     countyOverrides   per-(stormId, geoid) exposed-fraction overrides (persisted)
│       │     useEffectiveScope hook combining selection + scope filters
│       ├── lib/                formatting (currency, percent, count)
│       ├── styles/tokens.css   design tokens
│       └── types/contracts.ts  canonical enums (mirror of docs/CONTRACTS.md)
└── mockdata/
    ├── cedents.json              Cedent → Chain → Programme tree (primary)
    ├── exposure_facts/<id>.json  ExposureFactNormalized[] per programme
    ├── ied_industry.csv          RMS IED denominator (intentional gaps)
    ├── treaty_metadata.json      admin treaty rows (auto-saved by /api/admin)
    ├── edm_linkage.json          fs_display_id → (serverName, edmDatabaseName)
    ├── dataset_groups.json       seed for legacy in-memory group store
    ├── sql_servers.example.json  multi-host SQL registry template
    ├── sql_servers.json          (local only — real hosts/creds; gitignored if present)
    ├── hazard_tornado_grid.json  pre-baked SPC + climatology hazard grid
    ├── hazard_hail_grid.json
    ├── hazard_wildfire_grid.json
    └── geo/                      country/CRESTA features (state+county = Mapbox tilesets)
```

## Stack (pinned)

| Layer | Pin | Notes |
|---|---|---|
| Frontend | React 18, TypeScript 5, Vite 5 | dev port 5173, `/api` proxied to 8000 |
| Map | Mapbox GL JS v3 + vector tilesets | state + county; no GeoJSON shipped |
| Data fetching | TanStack Query v5 | hooks live in `frontend/src/api/hooks.ts` only |
| Client state | Zustand (+ persist middleware) | one store per concern; user inputs persisted |
| Resizable panes | react-resizable-panels v2 | persisted layout per shape key |
| Frontend tests | Vitest + Testing Library | `npx vitest run` (34) |
| Backend | Python 3.12, FastAPI, Pydantic v2, openpyxl | uvicorn dev on 8000 |
| Backend tests | pytest + httpx | `pytest -q` (~107) |
| Multi-EDM SQL | pyodbc (optional extra `[sql]`) | hybrid/sqlserver providers || Storms (historical) | stdlib `urllib` + lru_cache | IBTrACS NA fetch → 3 indexes (tracks + Rmax + R64 quads) |
| Storms (live) | stdlib `urllib` | NHC CurrentStorms.json + IBTrACS replay |
| Marine + alerts | stdlib `urllib` | NDBC `latest_obs.txt`, NWS `api.weather.gov`, JPL MUR SST via ERDDAP CSV |
| County reference | stdlib `urllib` + lru_cached us-atlas TopoJSON | centroids + curated + synthetic per-county stats |
| Hazard grids | pre-baked JSON | offline-built by `scripts/build_*_grid.py`; pyshp is dev-only |

**Not shipped in prod:** pandas, pytest, httpx, pyshp — `backend/pyproject.toml`
keeps them in `[dev]` extras; `api/requirements.txt` lists only the runtime
deps (`fastapi`, `pydantic`, `pydantic-settings`, `openpyxl`) so the Vercel
function stays small.

## Boundaries

- **Frontend never imports a data client.** Only `src/api/*` knows about
  fetch / TanStack Query. Components consume typed hooks (`useCedents`,
  `useMapData`, `useDetailData`, `usePivotData`, `useErtJobStatus`,
  `useProgrammeStatus`, etc.).
- **Backend services depend only on `providers/base.ExposureDataProvider`.**
  The concrete provider is chosen at startup by `DATA_PROVIDER` env
  (`mock` | `hybrid` | `sqlserver` | `databricks`).
- **Calculations live once, in `services/calculations.py` + `grouping.py`.**
  Map, detail, pivot, and Excel export all call the same functions.
- **Hurricane impact + hazards live in their own services** but follow the
  same "build once, render in many surfaces" pattern.
- **Single source of effective scope** — `frontend/src/state/useEffectiveScope.ts`
  is the only place that decides "what programmes are we operating on."

## Multi-EDM data plane (hundreds of pre-aggregated DBs)

Each programme already carries an `EDMRef` (`serverName` + `edmDatabaseName`).
Facts are **pre-aggregated ERT cuts** (same shape as `mockdata/exposure_facts/*`),
not location-level EDM dumps — still large when many deals are open at once.

| Piece | Role |
|---|---|
| `providers/fact_cache.py` | Process-wide LRU + TTL cache, single-flight loads per `datasetId` |
| `providers/parallel_load.py` | Bounded thread-pool fan-out for multi-deal scopes |
| `providers/connection_registry.py` | Map `serverName` → host/creds; one pool slot per (server, database) |
| `providers/sqlserver.py` | Catalog from `cedents.json`; facts from SQL (or mock fallback in `hybrid`) |
| `providers/sql_row_map.py` | ERT / camelCase column mapping → `ExposureFactNormalized` |
| `GET/POST /api/admin/cache*` | Stats, warmup, invalidate |
| `GET /api/admin/connections` | Registered SQL hosts (+ optional `?probe=true`) |

**Load path:** request → resolve programme/chain/portfolio dataset ids →
`get_facts_for_datasets` (parallel) → cache hit or load mock JSON / SQL
`ee_exposure_facts` or `{edm}__EVOLUTION` → calc services.

**Recommended demo setup:** `DATA_PROVIDER=hybrid`, copy
`mockdata/sql_servers.example.json` → `sql_servers.json`, point live hosts at
real EDMs; unregistered servers keep using mock fact files. Call
`POST /api/admin/cache/warmup` once before the walkthrough.

## Routing

The frontend uses a **path-based router** (no react-router) backed by
`window.location.pathname` + `popstate`:

- `/` (default) → `<Shell />` (the map workbench)
- `/admin/programmes` → `<AdminProgrammes />` (treaty metadata admin)

The Programmes admin page is intentionally **not linked from the header
nav** — power-user URL only. Re-link if you want it surfaced.

## Env vars

### `backend/.env`

| Var | Default | Purpose |
|---|---|---|
| `DATA_PROVIDER` | `mock` | `mock` \| `hybrid` \| `sqlserver` \| `databricks` |
| `MOCK_DATA_DIR` | `../mockdata` | catalog + mock fact fixtures |
| `FACT_CACHE_MAX_DATASETS` | `256` | LRU cap on cached EDMs |
| `FACT_CACHE_TTL_SECONDS` | `3600` | `0` = no time expiry |
| `FACT_LOAD_MAX_WORKERS` | `16` | parallel multi-EDM loads |
| `SQLSERVER_SERVERS_FILE` | `../mockdata/sql_servers.json` | multi-host registry |
| `SQLSERVER_SERVERS_JSON` | — | inline registry JSON |
| `SQLSERVER_DEFAULT_USER` / `PASSWORD` / `DRIVER` | — | defaults for registry entries |
| `SQLSERVER_EVOLUTION_TABLE_PATTERN` | `{edm}__EVOLUTION` | fact table name pattern |
| `SUPPORT_ERROR_EMAIL` | `support@example.invalid` | error report recipient |
| `EMAIL_TRANSPORT` | `noop` | `noop` \| `smtp` \| `graph` |
| `EXPORT_MAX_ROWS` | `100000` | over → `413 EXPORT_TOO_LARGE` |
| `CORS_ALLOW_ORIGINS` | `http://localhost:5173,http://localhost:4173` | comma-separated |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | smtp transport only |

### `frontend/.env`

| Var | Example | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | API root (same-origin in prod) |
| `VITE_MAPBOX_TOKEN` | `pk.…` | **build-time** — restart `npm run dev` after changing |

## Map geometry

State + county polygons come from **two Mapbox vector tilesets**
(referenced in `frontend/src/components/Map/MapView.tsx`):

- `bermuda1023.tdub0xmgbp11` — states, source-layer `fa8d0f12ddc097d30cfe`,
  feature key `STATE` (2-digit FIPS).
- `bermuda1023.wnwbodo0p98t` — counties, source-layer
  `b2e6c22804c918d996b3`, feature key `GEOID` (5-digit FIPS).

`frontend/src/components/Map/fipsToUsps.ts` translates FIPS ↔ our
`geographyId` convention (`US-FL`, `US-FL-12086`). Coloring is via Mapbox
`feature-state` keyed by `promoteId` on each source.

Auto-level: a single `COUNTY_THRESHOLD = 4.0` constant in `MapView.tsx`
drives (a) which layer is visible, (b) which level the API fetches at,
(c) which layer the hover/click handlers query. Keep them in sync.

Hazard / hurricane / live-storm layers add their own GeoJSON sources +
fill/line/circle layers on top, all inserted **below `county-line`** so
impact outlines stay visible.

## Layer-stacking gotcha

When the user toggles a hazard chip (Tornado / Hail / Wildfire), the
hazard layer's effect hides `state-fill` and `county-fill` so the two
choropleths don't fight each other visually. Turning the chip off restores
them. The TIV feature-state is left untouched, so the exposure view comes
back immediately when the hazard layer goes away.

## Gotchas (learned the hard way)

1. **Vite env vars are baked at build time.** Setting `VITE_MAPBOX_TOKEN`
   in Vercel after the deploy doesn't update the live bundle. Trigger a
   redeploy. Verify scope is "Production".
2. **`npm run preview` does not proxy `/api`.** Only `npm run dev` does.
   In prod the same-origin `/api` works via Vercel rewrites.
3. **PostCSS config climbs parent dirs.** We ship an empty
   `frontend/postcss.config.js` so Vite doesn't accidentally pick up a
   Tailwind config from `C:\Users\…\` and emit weird CSS.
4. **Mapbox GL JS doesn't watch container resizes.** A `ResizeObserver`
   in `MapView.tsx` calls `map.resize()` after panel collapse/drag.
5. **Pydantic `use_enum_values=True`** returns raw strings, not enum
   instances. Coerce back to the enum when you need `.value` or `==`
   against members (see `_segment_for_market_share`).
6. **In-memory state on serverless** — the ERT job registry **and** the
   fact cache won't survive between Vercel lambda invocations. Acceptable
   for the mock demo; for multi-EDM SQL use a long-lived API host (see
   `DEPLOY.md` + `MULTI_EDM.md`). Persist jobs in KV/Redis when needed.
7. **CRLF warnings on `git add`** on Windows are harmless line-ending
   normalisation. The repo doesn't ship a `.gitattributes`; add one if
   it bothers you.
8. **Mapbox `interpolate` color expression silently fails** if the first
   stop pair is malformed (e.g. missing input value). The cone fills
   stayed invisible for a while because of this — use the `step` form
   for hard breaks, or build `interpolate` from `legend.palette + legend.stops`
   so the legend and the layer can't diverge.
9. **`addLayer(layer, beforeId)` throws** if `beforeId` doesn't exist
   yet. Guard with `map.getLayer('county-line') ? 'county-line' : undefined`
   when inserting hurricane / hazard layers below the county outline.
10. **Live overlays (SST / alerts / buoys) need `setLayoutProperty('visibility', ...)`
    per render** — paint properties like `'fill-opacity': data ? 0.95 : 0`
    evaluate at layer-creation time when data is null and bake to 0,
    permanently invisible.
11. **Hazard grids carry `stepDeg` metadata** in the JSON payload — the
    frontend uses it to size each square-fill polygon. Hard-coding 0.2°
    in the renderer will leave gaps / overlaps when a build script changes
    the resolution.
12. **Single source of effective scope** — `frontend/src/state/useEffectiveScope.ts`
    is the only place that decides "what programmes are we operating on"
    (selection ∪ scope-filter ∪ portfolio fallback). Map, pivot, export,
    hurricane impact, live storm all consume it — never reimplement that
    logic per component.
