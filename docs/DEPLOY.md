# DEPLOY — Vercel (single project: SPA + Python serverless)

The repo is wired for Vercel: one project, one domain, same-origin `/api`,
no CORS plumbing.

> Multi-EDM / SQL demos: prefer a **long-lived API process** near your SQL
> network. Vercel is excellent for the **mock** product demo; process-local
> fact cache and connection pools do not survive across lambdas. See
> [`MULTI_EDM.md`](./MULTI_EDM.md) and
> [`FOR_INTERNAL_DEVELOPERS.md`](./FOR_INTERNAL_DEVELOPERS.md).

## Files that wire it

| File | Purpose |
|---|---|
| `vercel.json` | Rewrites `/api/*` to the serverless function; rest of routes serve `frontend/dist`. Bundles `mockdata/**` into the function. |
| `api/index.py` | Vercel Python entrypoint. Adds `backend/` to `sys.path`, sets `MOCK_DATA_DIR`, re-exports `app.main:app`. |
| `api/requirements.txt` | Runtime deps only — `fastapi`, `pydantic`, `pydantic-settings`, `openpyxl`. No pandas, no pytest, no httpx, no pyodbc. Keeps cold-start lean. |
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
| `DATA_PROVIDER` | `mock` (recommended on Vercel) |
| `SUPPORT_ERROR_EMAIL` | any address (noop transport in v1) |

Optional (defaults are fine for mock):

| Var | Default | Notes |
|---|---|---|
| `FACT_CACHE_MAX_DATASETS` | `256` | LRU size per lambda instance |
| `FACT_CACHE_TTL_SECONDS` | `3600` | per-instance only |
| `FACT_LOAD_MAX_WORKERS` | `16` | parallel fact loads |

Do **not** put production SQL passwords on Vercel for a firm demo unless you
have an explicit security review. Use mock fixtures publicly; hybrid/SQL on
an internal host.

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

The current code keeps several things in-process. On Vercel each request
may land on a different lambda, so:

1. **Fact cache** (`providers/fact_cache.py`) — process-local LRU. Cold start
   = empty cache. Warmup on one instance does not warm another. Acceptable
   for mock (lazy JSON is cheap enough); painful for multi-SQL.
2. **ERT job lifecycle** (`backend/app/services/jobs.py`) — submit on lambda
   A, poll status on lambda B → can look "missing". For the demo this just
   means the queued→running→completed animation might glitch. Fix when
   needed: persist the registry in Vercel KV / Redis.
3. **Dataset-group create endpoint** — same in-memory issue. No user-facing
   surface today; the cedent/office model replaced the group-create UI.
4. **SQL connection pools** — not meaningful across ephemeral lambdas; keep
   `DATA_PROVIDER=mock` on Vercel.

Everything else (cedent tree, map, detail, pivot, export, hurricanes against
mock facts) reads from bundled fixtures and is effectively stateless.

## Cold-start cost

First request after idle hits the lambda cold:

- Parse `cedents.json` only at provider init (~small). Fact files load
  **lazily** on first use of each `datasetId` (not all ~47MB up front).
- IBTrACS NA-basin CSV: fetch + parse ~2–3 s (once per cold start, then
  `lru_cache` makes subsequent calls instant). Affects only the first
  `/api/hurricanes`, `/api/hurricanes/{id}/impact`, and `/api/live/storms`
  call.
- NHC `CurrentStorms.json`: ~200 ms (similarly lru-cached).
- NWS alerts + NDBC buoys + JPL MUR SST: ~500 ms each on first call per
  bbox; lru-cached per bounding box.
- Hazard grids: read directly from `mockdata/hazard_*_grid.json` — no
  external fetch. First parse is ~150 ms; cached for the lambda lifetime.

Subsequent warm calls on the same instance are sub-100 ms for cached facts.

## Hazard grid bundling

The hazard JSON files (`mockdata/hazard_{tornado,hail,wildfire}_grid.json`)
together are ~3-4 MB. `vercel.json` already bundles `mockdata/**` into the
Python function so they ship with the deploy — no separate upload needed.
Re-bake locally (`backend/scripts/build_*_grid.py`) and commit when the
upstream shapefile updates or a tuning constant changes.

## Alternative: Render / Fly / Cloud Run / internal VM

Vercel is the lowest-friction option for the **mock SPA**. If you need:

- multi-EDM SQL with a warm fact cache
- durable ERT jobs
- longer-running exports

…run `backend/app/main.py` as a plain FastAPI service on any Python host
near the SQL network. Frontend can stay on Vercel (or move with the
backend) and point `VITE_API_BASE_URL` at the API origin (then set
`CORS_ALLOW_ORIGINS` in `backend/app/config.py`).

```bash
# Long-lived multi-EDM demo host
cd backend
pip install -e ".[dev,sql]"
export DATA_PROVIDER=hybrid
export SQLSERVER_SERVERS_FILE=../mockdata/sql_servers.json
uvicorn app.main:app --host 0.0.0.0 --port 8000
# then POST /api/admin/cache/warmup
```

## Local dev still works exactly the same

```bash
cd backend && source .venv/bin/activate && uvicorn app.main:app --port 8000
cd frontend && npm run dev    # http://localhost:5173 with /api proxy
```

The dev proxy lives in `frontend/vite.config.ts`. `npm run preview` doesn't
proxy — it's for inspecting the built bundle only.
