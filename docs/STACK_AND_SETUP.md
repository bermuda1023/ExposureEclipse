# STACK_AND_SETUP — Versions, Config, Commands

> Pinned choices so the build is reproducible. Where a choice is still open it is marked
> **[OPEN]** and tracked in `OPEN_QUESTIONS.md` — pick the recommended default and note it.

## Frontend

| Concern | Choice |
|---|---|
| Language | TypeScript 5.x |
| Framework | React 18.x |
| Build/dev server | Vite 5.x (port **5173**) |
| Map | Mapbox GL JS v3.x (`mapbox-gl`) |
| Server state / fetching | TanStack Query v5 (`@tanstack/react-query`) |
| Client state | Zustand |
| HTTP | `fetch` wrapper or `axios` |
| Pivot/data grid | **[OPEN]** — recommend AG Grid Community (MIT) for grid; `react-pivottable` for quick pivot. Confirm licensing. |
| Excel (client trigger only) | Server generates the file; client just downloads the stream |
| Unit tests | Vitest + React Testing Library |
| E2E | Playwright |
| Lint/format | ESLint + Prettier |

## Backend

| Concern | Choice |
|---|---|
| Language | Python 3.12 |
| Framework | FastAPI (latest) + Uvicorn (port **8000**) |
| Validation/models | Pydantic v2 |
| Data wrangling | pandas |
| Excel generation | openpyxl (or XlsxWriter) |
| SQL Server (v1 phase 2) | pyodbc / SQLAlchemy — behind provider, not imported elsewhere |
| Background jobs (v1) | in-process `asyncio` task registry + job store (in-memory or SQLite). No external broker in v1. |
| Email | abstracted `EmailService`; SMTP or MS Graph **[OPEN]** |
| Dep management | uv or Poetry (pick one, commit lockfile) |
| Tests | pytest + httpx AsyncClient |
| Lint/format | ruff + black |

## API base & proxy

- Backend serves under `/api/*` on `:8000`.
- Vite dev proxies `/api` → `http://localhost:8000`.
- All responses JSON except `/api/exports/excel` (xlsx stream).

## Environment variables

Use a single `.env` per app. **Never hardcode** tokens, emails, or connection strings.

### Frontend (`frontend/.env`, Vite requires `VITE_` prefix)

| Var | Example | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | API root |
| `VITE_MAPBOX_TOKEN` | `pk.xxx` | Mapbox GL JS token **[OPEN: provisioning]** |

### Backend (`backend/.env`)

| Var | Example | Purpose |
|---|---|---|
| `DATA_PROVIDER` | `mock` | `mock` \| `sqlserver` \| `databricks` |
| `MOCK_DATA_DIR` | `../mockdata` | Fixture location for mock provider |
| `SUPPORT_ERROR_EMAIL` | `support@…` | Error report recipient — **config only, never hardcoded** |
| `EMAIL_TRANSPORT` | `smtp` | `smtp` \| `graph` \| `noop` (dev) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | If SMTP |
| `EXPORT_MAX_ROWS` | `100000` | Triggers `WARN_EXPORT_TOO_LARGE` / `EXPORT_TOO_LARGE` |
| `SQLSERVER_CONN` | — | v1 phase 2 only |
| `DATABRICKS_*` | — | v2 only |

Provide `.env.example` in each app with every key (no secrets).

## Commands

```bash
# Backend
cd backend
uv sync                 # or: poetry install
uv run uvicorn app.main:app --reload --port 8000
uv run pytest

# Frontend
cd frontend
npm install
npm run dev             # http://localhost:5173
npm run test            # vitest
npm run test:e2e        # playwright
npm run build

# One-shot dev (optional): a root script / docker-compose may run both.
```

## Definition of "runs locally"

`backend` starts on 8000, `frontend` on 5173, mock datasets list, map renders, and the
golden path (CLAUDE.md) is walkable end to end. See `DEFINITION_OF_DONE.md`.
