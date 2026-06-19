# ARCHITECTURE — repo layout, stack, key boundaries, gotchas

## Tree

```
ExposureEclipse/
├── CLAUDE.md                ← operating manual (auto-loaded)
├── README.md
├── docs/
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
│   │   ├── api/              thin routers (cedents, counties, exposures, ert_jobs, exports, hurricanes, dataset_groups, calc)
│   │   ├── models/           Pydantic v2 (cedent, exposure, dataset, jobs, warnings, enums, common)
│   │   ├── providers/        ExposureDataProvider ABC + MockExposureDataProvider
│   │   ├── services/         calculations, grouping, jobs, email, export_excel,
│   │   │                     hurdat2 (helpers), ibtracs (storms + Rmax + R64 quads),
│   │   │                     hurricane_impact (cone + asymmetric capture),
│   │   │                     county_reference, layer_calc
│   │   └── ert/              ExpectedERTTable registry
│   ├── scripts/              data-generation/merge helpers
│   └── tests/                pytest (87)
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── postcss.config.js     ← intentional: stops Vite from picking up parent-dir Tailwind configs
│   ├── .env.example
│   ├── tsconfig.json
│   └── src/
│       ├── App.tsx           renders <Shell />
│       ├── main.tsx          QueryClient + token CSS
│       ├── api/              the ONLY place that hits the backend (client, hooks, cedents, exposures, exports, hurricanes, jobs, types)
│       ├── components/
│       │   ├── layout/       Shell, Header, WarningsPanel
│       │   ├── CedentTree/   tree rail + ErtBadge + StatusBadge (BOUND/QUOTED/...)
│       │   ├── Map/          MapView, MetricSelector, PerilSelector, YoyToggle,
│       │   │                 HurricaneLayer (path + cone + R64 wash), HurricaneControls,
│       │   │                 HurricaneImpactPanel (floating), colour ramp, fipsToUsps, Tooltip
│       │   ├── DetailPanel/  DetailPanel + CountyReferenceSection + HurricaneImpactDetail (right-rail push view)
│       │   ├── Pivot/        pivot workbench
│       │   ├── ErtJob/       run/poll indicator + hook
│       │   └── ExportButton/
│       ├── state/            Zustand stores (selection, filters, view, hurricanes,
│       │                     scopeFilters, hurricaneImpact) + useEffectiveScope hook
│       ├── lib/              formatting (currency, percent, count)
│       ├── styles/tokens.css design tokens
│       └── types/contracts.ts  canonical enums (mirror of docs/CONTRACTS.md)
└── mockdata/
    ├── cedents.json          Cedent → Chain → Programme tree (primary)
    ├── exposure_facts/       one JSON per programme dataset_id
    ├── ied_industry.csv      RMS IED denominator with intentional gaps
    └── geo/                  tiny country/CRESTA features (state+county come from Mapbox tilesets)
```

## Stack (pinned)

| Layer | Pin | Notes |
|---|---|---|
| Frontend | React 18, TypeScript 5, Vite 5 | dev port 5173, `/api` proxied to 8000 |
| Map | Mapbox GL JS v3 + your **vector tilesets** | state + county; no GeoJSON shipped |
| Data fetching | TanStack Query v5 | hooks live in `frontend/src/api/hooks.ts` only |
| Client state | Zustand | one store per concern (selection / view / filters / hurricanes) |
| Resizable panes | react-resizable-panels v2 | persisted layout per shape key |
| Frontend tests | Vitest + Testing Library | `npx vitest run` |
| Backend | Python 3.12, FastAPI, Pydantic v2, openpyxl | uvicorn dev on 8000 |
| Backend tests | pytest + httpx | `pytest -q` |
| Hurricanes | stdlib `urllib` + lru_cache | live IBTrACS NA fetch, one parse → 3 indexes (tracks + Rmax + R64 quads); HURDAT2 helpers stay for category/landfall logic |
| County reference | stdlib `urllib` + lru_cached us-atlas TopoJSON parse | centroids + curated census / synthetic per-county stats |

**Not shipped in prod:** pandas, pytest, httpx — `backend/pyproject.toml` keeps
them in `[dev]` extras; `api/requirements.txt` lists only the runtime deps
(`fastapi`, `pydantic`, `pydantic-settings`, `openpyxl`) so the Vercel function
stays small.

## Boundaries

- **Frontend never imports a data client.** Only `src/api/*` knows about
  fetch / TanStack Query. Components consume typed hooks (`useCedents`,
  `useMapData`, `useDetailData`, `usePivotData`, `useErtJobStatus`,
  `useProgrammeStatus`).
- **Backend services depend only on `providers/base.ExposureDataProvider`.**
  The concrete provider is chosen at startup by `DATA_PROVIDER` env (today
  always `mock`).
- **Calculations live once, in `services/calculations.py` + `grouping.py`.**
  Map, detail, pivot, and Excel export all call the same functions. No
  per-surface math.

## Env vars

### `backend/.env`

| Var | Default | Purpose |
|---|---|---|
| `DATA_PROVIDER` | `mock` | `mock` only in v1 |
| `MOCK_DATA_DIR` | `../mockdata` | fixture location |
| `SUPPORT_ERROR_EMAIL` | `support@example.invalid` | error report recipient |
| `EMAIL_TRANSPORT` | `noop` | `noop` \| `smtp` \| `graph` |
| `EXPORT_MAX_ROWS` | `100000` | over → `413 EXPORT_TOO_LARGE` |
| `CORS_ALLOW_ORIGINS` | `http://localhost:5173,http://localhost:4173` | comma-separated |

### `frontend/.env`

| Var | Example | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | API root (same-origin in prod) |
| `VITE_MAPBOX_TOKEN` | `pk.…` | **build-time** — restart `npm run dev` after changing |

## Map geometry

State + county polygons come from **your two Mapbox vector tilesets**
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
(c) which layer the hover/click handlers query. Keep them in sync — they
shared overlapping ranges in an earlier version and produced the "county
polygons visible, state stats shown" bug.

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
6. **In-memory state on serverless** — the ERT job registry won't survive
   between Vercel lambda invocations. Acceptable for the demo; persist
   in Vercel KV when needed.
7. **CRLF warnings on `git add`** on Windows are harmless line-ending
   normalisation. The repo doesn't ship a `.gitattributes`; add one if
   it bothers you.
8. **Mapbox `interpolate` color expression silently fails** if the first
   stop pair is malformed (e.g. missing input value). The cone fills
   stayed invisible for a while because of this — we now use the `step`
   form everywhere for color ramps, matching `LINE_LAYER`.
9. **`addLayer(layer, beforeId)` throws** if `beforeId` doesn't exist
   yet. Guard with `map.getLayer('county-line') ? 'county-line' : undefined`
   when inserting hurricane layers below the county outline.
10. **Single source of effective scope.** `frontend/src/state/useEffectiveScope.ts`
    is the only place that decides "what programmes are we operating on"
    (selection ∪ scope-filter ∪ portfolio fallback). Map, pivot, export,
    hurricane impact all consume it — never reimplement that logic per
    component.
