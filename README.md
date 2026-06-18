# Exposure Eclipse

A web-based **Property Cat exposure management workbench**. It turns existing ERT/EDM
exposure outputs into an interactive map + pivot analysis platform: select EDMs, view
TIV/location counts geographically, compare a deal vs the loaded portfolio, compute client
market share vs RMS IED industry TIV, analyze year-over-year movement, group per-peril EDMs
into one programme, and export the exact filtered view to Excel.

> **V1 is a mock-data prototype.** Prove the UI, API contracts, calculations, warnings, and
> exports against mock data before connecting to SQL Server. The frontend must **never**
> talk to a database directly — it calls the FastAPI backend, which abstracts the data source.

## Repository

```
CLAUDE.md     ← agent/developer operating manual (read first)
README.md     ← you are here
docs/         ← the specification pack (the contract)
frontend/     ← React + TypeScript + Vite + Mapbox GL JS
backend/      ← FastAPI + provider abstraction + calc/export/jobs
mockdata/     ← fixtures for the mock provider
```

## Reading order

1. `CLAUDE.md` — operating manual, hard rules, golden path.
2. `docs/PROJECT_BRIEF.md` — why this exists, users, scope.
3. `docs/PRODUCT_REQUIREMENTS.md` — what to build.
4. `docs/TECHNICAL_ARCHITECTURE.md` — how it's structured.
5. `docs/CONTRACTS.md` ⭐ — canonical enums/constants (single source of truth).
6. `docs/ERT_OUTPUT_FORMAT.md` ⭐ — the real ERT cut format (source schema for mock + SQL).
7. `docs/DATA_MODEL.md` + `docs/CALCULATION_RULES.md` — before any calculation work.
7. `docs/API_SPEC.md` — the request/response contract.
8. `docs/STACK_AND_SETUP.md` + `docs/PROJECT_STRUCTURE.md` — versions, env, layout.
9. `docs/MOCK_DATA_SPEC.md`, `MAPBOX_SPEC.md`, `BACKGROUND_JOBS_SPEC.md`, `ERROR_HANDLING.md`.
10. Build per `docs/IMPLEMENTATION_PLAN.md`; verify against `docs/DEFINITION_OF_DONE.md` and
    `docs/TEST_PLAN.md`. Don't guess `docs/OPEN_QUESTIONS.md`.

## Quickstart (once scaffolded — Phase 0)

```bash
# Backend
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend && npm install && npm run dev   # http://localhost:5173
```

Set `VITE_MAPBOX_TOKEN` (frontend) and `DATA_PROVIDER=mock` (backend). See
`docs/STACK_AND_SETUP.md` for all env vars.

## Core principles (full list in `CLAUDE.md`)

- Frontend never touches data sources; everything goes through the backend provider.
- Mock data first; same API contract the SQL provider will satisfy.
- Never sum TIV across peril EDMs by default — max-across-perils at the current viewed grain.
- Never silently mix currencies; always show currency.
- Every displayed number is traceable; Excel export accuracy > formatting.
- Use canonical enums from `docs/CONTRACTS.md`; don't hardcode table names, email, or token.

## Status

Specification pack complete. Implementation starts at Phase 0 in
`docs/IMPLEMENTATION_PLAN.md`.

## Deploying to Vercel (frontend + backend, one repo, one domain)

Vercel hosts both the static React build and the FastAPI handler as a
serverless Python function — no CORS plumbing, no second platform.

**Repo layout for deploy:**
```
vercel.json              ← routes /api/* to the Python function, /* to the SPA
api/index.py             ← Vercel Python entrypoint; re-exports FastAPI app
api/requirements.txt     ← lean runtime deps (no pandas/pytest/httpx)
backend/app/             ← unchanged source
mockdata/                ← bundled with the function via `includeFiles`
frontend/                ← Vite build → dist/ served as static
frontend/.env.production ← `VITE_API_BASE_URL=/api` (same-origin, no proxy)
```

**One-time setup:**
```bash
npm i -g vercel          # if you don't have it
vercel link              # link this repo to a Vercel project
```

**Set env vars in the Vercel dashboard (Project → Settings → Environment Variables):**
- `VITE_MAPBOX_TOKEN` — your Mapbox public token (Production scope)
- `DATA_PROVIDER` — `mock`
- `SUPPORT_ERROR_EMAIL` — any address; v1 uses the no-op email transport

**Deploy:**
```bash
vercel              # preview
vercel --prod       # production
```

**Caveats (serverless quirks of the current code):**
1. The ERT background-job lifecycle (`services/jobs.py`) keeps state in-process,
   so a job submitted on one lambda may be polled from a different one and look
   "missing". For the demo it just means the queued→running→completed animation
   might glitch. Fix when needed: persist the registry in Vercel KV.
2. The dataset-group create endpoint has the same in-memory issue, but the UI
   no longer surfaces it under the cedent/office model — so no user impact.

**Local dev still works exactly as before:**
```bash
cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000
cd frontend && npm run dev   # http://localhost:5173 (Vite proxies /api → :8000)
```
