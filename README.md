# Exposure Eclipse

Web-based **Property Cat exposure management workbench** for reinsurance
underwriters. Turns ERT/EDM exposure outputs into an interactive Mapbox
choropleth + pivot + Excel-export pipeline, overlays historical hurricane
tracks with asymmetric wind-field cones (NOAA IBTrACS), runs deterministic
layered-loss scenarios, supplies a tornado / hail hazard climatology
(SPC SVRGIS + Brooks/Tippett/Cintineo blend), and provides NHC-style
live-storm forecasts with NWS alerts, NDBC marine obs, and JPL MUR SST
overlays.

**V1 is a mock-data prototype** — proves UI, API contracts, calculations,
warnings, and exports against fixtures. `MockExposureDataProvider` satisfies
the same `ExposureDataProvider` ABC the future SQL provider will satisfy.

## Repo layout

```
CLAUDE.md         ← operating manual (read first)
README.md         ← you are here
docs/             ← spec pack
api/              ← Vercel Python entrypoint (re-exports backend FastAPI app)
backend/          ← FastAPI + provider + calc/export/jobs/IBTrACS + hazards + live
frontend/         ← React + TypeScript + Vite + Mapbox GL JS
mockdata/         ← cedents.json + exposure_facts/ + hazard_*_grid.json +
                    treaty_metadata.json + ied_industry.csv
vercel.json       ← single-deploy config
```

## Reading order

1. `CLAUDE.md` — operating manual + 10 hard rules + the data model.
2. `docs/DATA_MODEL.md` — Cedent → Office → Chain → Programme.
3. `docs/CONTRACTS.md` ⭐ — canonical enums (mirrored backend ↔ frontend).
4. `docs/API.md` — endpoint inventory + request/response shapes.
5. `docs/CALCULATIONS.md` — the math (TIV aggregations, YoY, max-across-perils,
   hurricane impact, layer calc, hazard climatology blend).
6. `docs/ARCHITECTURE.md` — directory layout, stack, env vars, gotchas.
7. `docs/MOCK_DATA.md` — what's in the fixtures + how to extend them.
8. `docs/DEPLOY.md` — Vercel walkthrough.
9. `docs/ERT_OUTPUT_FORMAT.md` — real ERT cut format (source schema).
10. `docs/GLOSSARY.md` — domain terminology.

## Local dev

```bash
# Backend
cd backend
py -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# Frontend (second terminal)
cd frontend
npm install
npm run dev     # http://localhost:5173 (Vite proxies /api → :8000)
```

Required env vars (see `frontend/.env.example` and `backend/.env.example`):

- `VITE_MAPBOX_TOKEN` — Mapbox public token, frontend, **read at build time**.
- `DATA_PROVIDER=mock` — backend.
- `SUPPORT_ERROR_EMAIL` — backend (noop transport in v1, any value).

## Rebuilding hazard grids (one-time / when shapefile changes)

The tornado / hail / wildfire choropleths read pre-baked JSON grids from
`mockdata/hazard_*_grid.json`. To regenerate, install `pyshp` then drop the
source shapefile in `C:\Users\James\Downloads\`:

```bash
cd backend
.venv/Scripts/python -m pip install pyshp
.venv/Scripts/python scripts/build_tornado_grid.py
.venv/Scripts/python scripts/build_hail_grid.py
.venv/Scripts/python scripts/build_wildfire_grid.py
```

Source shapefiles (download separately):
- SPC SVRGIS — https://www.spc.noaa.gov/gis/svrgis/
- WFIGS Interagency Perimeters — https://data-nifc.opendata.arcgis.com/

Build constants (grid step, KDE sigma, climatology weight) live at the top
of each script. See `docs/CALCULATIONS.md §Hazard climatology blend` for the
methodology.

## Deploy (Vercel — single project)

```bash
npm i -g vercel
vercel link
# In Vercel dashboard, set for Production scope:
#   VITE_MAPBOX_TOKEN, DATA_PROVIDER=mock, SUPPORT_ERROR_EMAIL
vercel --prod
```

Full walkthrough + serverless caveats in `docs/DEPLOY.md`. Note: changing
`VITE_*` env vars in Vercel requires a **redeploy** — Vite bakes them into
the bundle at build time.

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest -q     # 95 passing
cd frontend && npx vitest run                       # 34 passing
```

## Core principles (full list in `CLAUDE.md`)

- Frontend never touches data sources; everything goes through the provider.
- Mock data first; same contract the SQL provider will satisfy.
- Default group combination is `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` — never sum
  across distinct perils by default.
- Currency always shown, never silently mixed.
- Every displayed number traceable; Excel export accuracy > formatting.
- Canonical enums in `docs/CONTRACTS.md`; mirrored in both
  `backend/app/models/enums.py` and `frontend/src/types/contracts.ts`.

## Planned next

- **Frontend UI for the layer-calc engine** — the backend
  `POST /api/calc/layers` works; needs a "what-if" panel surface.
- **Persist hurricane assumption presets server-side** — currently per-browser
  via localStorage.
- **SQL Server provider** behind the same `ExposureDataProvider` ABC.
- **Wildfire surface** — wildfire data is live in the backend but the UI
  chip is hidden until the 2020+ WFIGS coverage is broadened with USFS
  historical perimeters.
