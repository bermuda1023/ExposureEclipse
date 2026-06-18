# DEPLOY — Vercel (single project: SPA + Python serverless)

The repo is wired for Vercel: one project, one domain, same-origin `/api`,
no CORS plumbing.

## Files that wire it

| File | Purpose |
|---|---|
| `vercel.json` | Rewrites `/api/*` to the serverless function; rest of routes serve `frontend/dist`. Bundles `mockdata/**` into the function. |
| `api/index.py` | Vercel Python entrypoint. Adds `backend/` to `sys.path`, sets `MOCK_DATA_DIR`, re-exports `app.main:app`. |
| `api/requirements.txt` | Runtime deps only — `fastapi`, `pydantic`, `pydantic-settings`, `openpyxl`. No pandas, no pytest, no httpx. Keeps cold-start lean. |
| `frontend/.env.production` | `VITE_API_BASE_URL=/api`. Template only — real values come from Vercel env. |

## One-time setup

```bash
npm i -g vercel        # if not already installed
vercel link            # link the local repo to a Vercel project
```

## Required Vercel env vars (Production scope)

| Var | Value |
|---|---|
| `VITE_MAPBOX_TOKEN` | your Mapbox public token (e.g. `pk.eyJ1Ijoi…`) — **build-time** |
| `DATA_PROVIDER` | `mock` |
| `SUPPORT_ERROR_EMAIL` | any address (noop transport in v1) |

Set these in **Project → Settings → Environment Variables** with scope
**Production** (and Preview if you want preview deploys to work too).

## Deploy

```bash
vercel               # preview build
vercel --prod        # production
```

## The Vite-env-var gotcha (most common deploy issue)

`VITE_*` env vars are **read at build time**, not runtime. So:

- If you set `VITE_MAPBOX_TOKEN` AFTER the first deploy, the existing
  bundle has an empty token and you'll see the data-table fallback.
- Fix: trigger a redeploy (push any commit, or click ⋯ → Redeploy in the
  Vercel dashboard).
- Verify the env var is in the **Production** scope (not just Preview).
- Confirm post-deploy: `curl https://<deploy>.vercel.app/assets/MapView-*.js
  | grep -c "pk.eyJ"` — expect `1`.

## Serverless caveats

The current code keeps a couple of things in-process. On Vercel each request
may land on a different lambda, so:

1. **ERT job lifecycle** (`backend/app/services/jobs.py`) — submit on lambda
   A, poll status on lambda B → can look "missing". For the demo this just
   means the queued→running→completed animation might glitch. Fix when
   needed: persist the registry in Vercel KV.
2. **Dataset-group create endpoint** — same in-memory issue. No user-facing
   surface today; the cedent/office model replaced the group-create UI.

Everything else (cedent tree, map, detail, pivot, export, hurricanes) reads
from disk fixtures and is stateless across requests.

## Cold-start cost

First request after idle hits the lambda cold:
- Parse `cedents.json` + every fact file (~50ms)
- HURDAT2 endpoint only: fetch + parse ~2–3 s (once per cold start, then
  `lru_cache` makes subsequent calls instant)

Subsequent warm calls are sub-100ms.

## Alternative: Render / Fly / Cloud Run

Vercel is the lowest-friction option for this stack. If you outgrow it (need
persistent in-process state, longer-running jobs, websockets), the same code
runs unchanged on any Python host — `backend/app/main.py` is a plain FastAPI
app. Frontend can stay on Vercel (or move with the backend) and just point
`VITE_API_BASE_URL` at the API origin (then re-enable CORS in
`backend/app/config.py`).

## Local dev still works exactly the same

```bash
cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000
cd frontend && npm run dev    # http://localhost:5173 with /api proxy
```

The dev proxy lives in `frontend/vite.config.ts`. `npm run preview` doesn't
proxy — it's for inspecting the built bundle only.
