# Exposure Eclipse

Web-based **Property Cat exposure management workbench** for reinsurance
underwriters. Turns ERT/EDM exposure outputs into an interactive Mapbox
choropleth + pivot + Excel-export pipeline, overlays historical hurricane
tracks with asymmetric wind-field cones (NOAA IBTrACS), runs deterministic
layered-loss scenarios, supplies a tornado / hail hazard climatology
(SPC SVRGIS + Brooks/Tippett/Cintineo blend), and provides NHC-style
live-storm forecasts with NWS alerts, NDBC marine obs, and JPL MUR SST
overlays.

**V1 is a mock-data prototype with a multi-EDM data plane.** Default mode
serves fixtures through `MockExposureDataProvider`. The same
`ExposureDataProvider` contract supports `hybrid` / `sqlserver` modes for
pre-aggregated cuts across many EDM databases (lazy cache + parallel load).

> **Internal engineers / code review:** start with
> [`docs/FOR_INTERNAL_DEVELOPERS.md`](docs/FOR_INTERNAL_DEVELOPERS.md) —
> what is real vs demo, how to verify, and how to evaluate AI-assisted code
> without rubber-stamping it.

## Repo layout

```
CLAUDE.md         ← operating manual + hard rules (read before coding)
README.md         ← you are here
docs/             ← full spec pack (see Reading order)
api/              ← Vercel Python entrypoint (re-exports backend FastAPI app)
backend/          ← FastAPI + providers + calc/export/jobs/IBTrACS + hazards + live
frontend/         ← React + TypeScript + Vite + Mapbox GL JS
mockdata/         ← cedents.json + exposure_facts/ + hazard_*_grid.json +
                    treaty_metadata.json + ied_industry.csv + sql_servers.example.json
vercel.json       ← single-deploy config
```

## Reading order

| # | Doc | Who |
|---|---|---|
| 0 | [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) | Formal system design (as-built + multi-EDM + PR plan) |
| 0b | [`docs/FOR_INTERNAL_DEVELOPERS.md`](docs/FOR_INTERNAL_DEVELOPERS.md) | Engineers evaluating / bringing this in |
| 1 | [`CLAUDE.md`](CLAUDE.md) | Anyone changing code (10 hard rules + data model) |
| 2 | [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Cedent → Office → Chain → Programme → EDMRef |
| 3 | [`docs/CONTRACTS.md`](docs/CONTRACTS.md) ⭐ | Canonical enums (mirrored backend ↔ frontend) |
| 4 | [`docs/API.md`](docs/API.md) | Endpoint inventory + request/response shapes |
| 5 | [`docs/CALCULATIONS.md`](docs/CALCULATIONS.md) | TIV, YoY, max-across-perils, impact, layers, hazards |
| 6 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layout, stack, multi-EDM plane, env, gotchas |
| 7 | [`docs/MULTI_EDM.md`](docs/MULTI_EDM.md) | Linking hundreds of pre-aggregated EDMs |
| 8 | [`docs/MOCK_DATA.md`](docs/MOCK_DATA.md) | Fixtures + scenario coverage |
| 9 | [`docs/DEPLOY.md`](docs/DEPLOY.md) | Vercel walkthrough + serverless caveats |
| 10 | [`docs/ERT_OUTPUT_FORMAT.md`](docs/ERT_OUTPUT_FORMAT.md) | Real ERT cut format (source schema) |
| 11 | [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Domain terminology |

## Local dev

```bash
# Backend
cd backend
python3.12 -m venv .venv          # 3.12 preferred
source .venv/bin/activate         # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000

# Frontend (second terminal)
cd frontend
npm install
npm run dev     # http://localhost:5173 (Vite proxies /api → :8000)
```

Required env vars (see `frontend/.env.example` and `backend/.env.example`):

- `VITE_MAPBOX_TOKEN` — Mapbox public token, frontend, **read at build time**.
- `DATA_PROVIDER` — `mock` (default) \| `hybrid` \| `sqlserver`.
- `SUPPORT_ERROR_EMAIL` — backend (noop transport in v1, any value).

Optional multi-EDM knobs: `FACT_CACHE_MAX_DATASETS`, `FACT_LOAD_MAX_WORKERS`,
`SQLSERVER_SERVERS_FILE` — full list in `backend/.env.example`.

## Multi-EDM (hundreds of pre-aggregated DBs)

Facts stay pre-aggregated (same shape as `mockdata/exposure_facts/*`):

- **Lazy + cached** loads per `datasetId` (LRU/TTL, single-flight)
- **Parallel fan-out** for portfolio / multi-chain / multi-deal scopes
- **Connection registry** (`serverName` → host) for SQL Server
- **`hybrid` provider** — live SQL when registered, mock files otherwise

```bash
cp mockdata/sql_servers.example.json mockdata/sql_servers.json
# edit hosts/creds; set DATA_PROVIDER=hybrid
pip install -e "backend[sql]"   # pyodbc

curl -X POST http://localhost:8000/api/admin/cache/warmup \
  -H 'content-type: application/json' \
  -d '{"inForceOnly": true}'
```

Full runbook: [`docs/MULTI_EDM.md`](docs/MULTI_EDM.md).

## Rebuilding hazard grids (one-time / when shapefile changes)

The tornado / hail / wildfire choropleths read pre-baked JSON grids from
`mockdata/hazard_*_grid.json`. To regenerate, install `pyshp` and place the
source shapefile where the script expects (see script headers):

```bash
cd backend
pip install pyshp
python scripts/build_tornado_grid.py
python scripts/build_hail_grid.py
python scripts/build_wildfire_grid.py
```

Source shapefiles (download separately):

- SPC SVRGIS — https://www.spc.noaa.gov/gis/svrgis/
- WFIGS Interagency Perimeters — https://data-nifc.opendata.arcgis.com/

Build constants (grid step, KDE sigma, climatology weight) live at the top
of each script. See `docs/CALCULATIONS.md` § Hazard climatology blend.

## Deploy (Vercel — single project)

```bash
npm i -g vercel
vercel link
# Production env: VITE_MAPBOX_TOKEN, DATA_PROVIDER=mock, SUPPORT_ERROR_EMAIL
vercel --prod
```

Full walkthrough + serverless caveats (incl. process-local fact cache) in
[`docs/DEPLOY.md`](docs/DEPLOY.md). Changing `VITE_*` in Vercel requires a
**redeploy** — Vite bakes them into the bundle at build time.

For multi-EDM SQL demos prefer a **long-lived API host** near the SQL network;
Vercel is ideal for the mock SPA demo, not for hundreds of live SQL round-trips.

## Tests

```bash
cd backend && pytest -q          # ~107 passing
cd frontend && npx vitest run    # ~34 passing
```

## Core principles (full list in `CLAUDE.md`)

- Frontend never touches data sources; everything goes through the provider.
- Mock data first; same contract hybrid/SQL providers satisfy.
- Default group combination is `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` — never sum
  across distinct perils by default.
- Currency always shown, never silently mixed.
- Every displayed number traceable; Excel export accuracy > formatting.
- Canonical enums in `docs/CONTRACTS.md`; mirrored in both
  `backend/app/models/enums.py` and `frontend/src/types/contracts.ts`.

## Planned next

- **Frontend UI for the layer-calc engine** — backend
  `POST /api/calc/layers` works; needs a "what-if" panel surface.
- **Persist hurricane assumption presets server-side** — currently per-browser
  via localStorage.
- **Wildfire surface** — backend grid live; UI chip hidden until coverage is
  broadened with USFS historical perimeters.
- **Firm bring-in** — SSO, durable cache/jobs, SQL cut validation (see
  `docs/FOR_INTERNAL_DEVELOPERS.md`).
