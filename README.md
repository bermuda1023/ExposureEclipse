# Exposure Eclipse

Web-based **Property Cat exposure management workbench** for reinsurance.
Turns ERT/EDM exposure outputs into an interactive Mapbox choropleth + pivot
+ Excel export, with NOAA HURDAT2 hurricane tracks as an optional overlay.

V1 is a **mock-data prototype** — proves the UI, API contracts, calculations,
warnings, and exports against fixtures. The mock provider satisfies the same
`ExposureDataProvider` ABC the future SQL provider will satisfy.

## Repo

```
CLAUDE.md         ← operating manual (read first)
README.md         ← you are here
docs/             ← lean spec pack
api/              ← Vercel Python entrypoint (re-exports backend FastAPI app)
backend/          ← FastAPI + provider + calc/export/jobs/hurdat2
frontend/        	 React + TypeScript + Vite + Mapbox GL JS
mockdata/         ← cedents.json + exposure_facts/*.json + ied_industry.csv
vercel.json       ← single-deploy config
```

## Reading order

1. `CLAUDE.md` — operating manual + 10 hard rules + the data model.
2. `docs/DATA_MODEL.md` — Cedent → Office → Chain → Programme.
3. `docs/CONTRACTS.md` ⭐ — canonical enums (mirrored backend ↔ frontend).
4. `docs/API.md` — endpoints + request/response shapes.
5. `docs/CALCULATIONS.md` — the math (max-across-perils, YoY, market share).
6. `docs/ARCHITECTURE.md` — directory layout, stack, env vars, gotchas.
7. `docs/MOCK_DATA.md` — what's in the fixtures and how to extend them.
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

## Deploy (Vercel — single project)

```bash
npm i -g vercel
vercel link
# In Vercel dashboard, set for Production scope:
#   VITE_MAPBOX_TOKEN, DATA_PROVIDER=mock, SUPPORT_ERROR_EMAIL
vercel --prod
```

Full walkthrough + serverless caveats in `docs/DEPLOY.md`. Note: changing
`VITE_*` env vars in Vercel requires a **redeploy** to take effect — Vite
bakes them into the bundle at build time.

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest -q     # 72 passing
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

- **Hurricane landfall-impact view** — click a historical hurricane path,
  apply the storm's recorded Rmax (radius of maximum winds), highlight every
  county the wind field touches over land, and roll up TIV inside those
  counties.
- **Portfolio view** — TIV + exposure breakdown by county × cedent ×
  programme, suitable for stress-testing against historical storm footprints.
- **SQL Server provider** behind the same `ExposureDataProvider` ABC.
