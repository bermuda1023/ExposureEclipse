# Exposure Eclipse — Guide for Internal Software Developers

**Audience:** engineers evaluating, reviewing, or extending this codebase —
including people skeptical of “AI-built” software.

**Purpose of this document:** explain *what this is*, *how it is put together*,
*what is real vs demo*, *how to verify claims*, and *where the sharp edges are*
so you can form an independent technical judgment.

---

## 1. What you are looking at (one paragraph)

**Exposure Eclipse** is a web workbench for **property catastrophe reinsurance
underwriters**. It turns **pre-aggregated ERT/EDM exposure cuts** into:

- Mapbox choropleth (state/county TIV and related metrics)
- Pivot + detail panels
- Excel export
- Historical hurricane impact (IBTrACS wind-field cones)
- Live/replay storm context (NHC, NWS, NDBC, SST)
- Tornado/hail (and wildfire data) hazard overlays
- Deterministic excess-of-loss layer calc (API ready; UI later)

It is **not** a full production RMS replacement. It is a **product prototype /
demo** with deliberately hard boundaries (provider ABC, canonical enums,
traceable math) so real EDMs can be wired without rewriting the UI.

---

## 2. Why this exists (business framing)

Underwriters already live in ERT Excel dumps and EDM SQL. The pain this demo
targets:

| Pain | What the app does |
|---|---|
| Static ERT workbooks | Interactive map + pivot over the same cut shape |
| Multi-deal portfolio views hard to assemble | Cedent → office → chain → programme tree + portfolio mode |
| Peril double-counting traps | Default `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` |
| “Where did this number come from?” | Warnings, currency, dataset traceability on the wire |
| Many EDMs on many SQL hosts | `EDMRef` + connection registry + lazy/parallel fact load |

If you are reviewing for “can we bring this inside,” evaluate it as a
**front door on ERT cuts**, not as a new cat model.

---

## 3. Honest scope: demo vs production-ready

| Area | Status | Notes |
|---|---|---|
| UI workbench (map, pivot, detail, export) | **Demo-ready** | Real UX patterns for underwriters |
| Domain contracts (enums, warnings, calc rules) | **Strong** | Documented; FE/BE mirrored; tested |
| Mock fact fixtures | **Complete for scenarios** | ~20 EDMs, intentional edge cases |
| Multi-EDM data plane (cache, parallel, SQL provider) | **Scaffolded + tested** | Ready to point at real hosts |
| Live SQL against firm EDMs | **Needs your network + registry** | `hybrid` / `sqlserver` modes |
| Auth / SSO / RBAC | **Out of scope** | Explicitly deferred for this demo |
| Durable job queue / audit / APM | **Not built** | In-memory jobs; health is basic |
| Vercel deploy | **Works for mock demo** | Fact cache is process-local (see DEPLOY) |

**Bottom line for reviewers:** treat the **architecture and contracts** as the
asset. Treat **mock data + local/Vercel demo** as the proof. Treat **SQL wiring**
as configuration + validation work, not a greenfield rewrite.

---

## 4. How the system works (request path)

```
┌─────────────┐     HTTP /api/*      ┌──────────────────┐
│  React SPA  │ ───────────────────► │  FastAPI routers │
│  (Vite)     │ ◄─────────────────── │  (thin)          │
└─────────────┘   JSON + warnings    └────────┬─────────┘
                                              │
                     pure functions           │ Depends(get_provider)
              ┌───────────────────────────────┼──────────────────────┐
              ▼                               ▼                      ▼
     services/calculations.py        ExposureDataProvider      services/*
     services/grouping.py            (mock | hybrid | sql)     hurricanes, hazards…
                                              │
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
                  FactCache (LRU/TTL)   ConnectionRegistry    mockdata/*.json
                  parallel_load         (serverName → host)   exposure_facts/
                         │                    │
                         └──────── SQL EDM DBs (pre-agg tables/views) ─┘
```

### 4.1 Frontend rules

- **Only** `frontend/src/api/*` talks to the backend.
- Components use TanStack Query hooks + Zustand stores.
- **Effective scope** (which programmes are in view) is resolved **once** in
  `useEffectiveScope()` — map, pivot, export, impact all share it.
- Canonical enums: `frontend/src/types/contracts.ts` ↔ `docs/CONTRACTS.md`
  ↔ `backend/app/models/enums.py`.

### 4.2 Backend rules

- Routers do not invent math; they call **services**.
- Services do not open SQL; they take facts from the **provider**.
- All map/detail/pivot/export math runs on **`ExposureFactNormalized`** rows
  (pre-aggregated ERT-shaped facts, not location-level RMS dumps).
- Errors → standard envelope (`code`, `message`, `traceId`).
- Domain “soft failures” → **200 + `warnings[]` + nulls**, never fake zeros.

### 4.3 Multi-EDM load path (important for scale review)

1. Resolve selection → list of `datasetId`s (one per programme/EDM cut).
2. `get_facts_for_datasets` loads in **parallel** (bounded workers).
3. Each load hits **FactCache** (single-flight, LRU, optional TTL).
4. Miss → mock JSON file **or** SQL (`ee_exposure_facts` view preferred,
   else `{edm}__EVOLUTION` pattern) via **ConnectionRegistry**.
5. Calc/grouping runs in-process on the combined fact list.

**Assumption baked in:** each EDM exposes **pre-aggregated** cuts similar to
`mockdata/exposure_facts/*.json`. This is not designed to pull raw location
tables for choropleths.

---

## 5. Domain model (the thing that must stay correct)

```
Cedent (insurer)
 └── Office (BDA / NYC / LON)          ← display tier → chainIds[]
      └── ProgrammeChain               ← YoY unit (renewal lineage)
           └── Programme (treaty year) ← multi-peril; status BOUND/QUOTED/…
                └── EDMRef             ← serverName + edmDatabaseName + currency
                └── datasetId          ← fact key (file name or load key)
```

**Selection (at most one target):**

- `programmeId` | `chainId` | `chainIds[]` | `cedentId` | legacy dataset/group
- **none** → **portfolio mode**: all in-force BOUND programmes

**Default combination across multi-peril / multi-deal:**
`MAX_ACROSS_PERILS_AT_VIEW_GRAIN` — max TIV per geography (and pivot dims),
**not** sum across perils. Summing requires explicit distinct-segment confirmation.

Full detail: `docs/DATA_MODEL.md`, `docs/CALCULATIONS.md`, `docs/CONTRACTS.md`.

---

## 6. Repository map (where to look)

| Path | What lives there |
|---|---|
| `docs/FOR_INTERNAL_DEVELOPERS.md` | **This file** — onboarding + review stance |
| `CLAUDE.md` | Operating manual + hard rules (also used by AI agents) |
| `README.md` | Quick start |
| `docs/CONTRACTS.md` | ⭐ Wire enums / warning codes / money conventions |
| `docs/ARCHITECTURE.md` | Tree, stack, multi-EDM plane, env vars, gotchas |
| `docs/API.md` | Endpoint inventory |
| `docs/DATA_MODEL.md` | Entities + `ExposureFactNormalized` |
| `docs/CALCULATIONS.md` | Math for every displayed number |
| `docs/ERT_OUTPUT_FORMAT.md` | Real ERT cut ground truth |
| `docs/MOCK_DATA.md` | Fixture inventory + scenarios |
| `docs/DEPLOY.md` | Vercel + serverless caveats |
| `docs/GLOSSARY.md` | Domain vocabulary |
| `backend/app/providers/` | Data plane: mock, sqlserver, cache, registry |
| `backend/app/services/` | Pure(ish) domain services |
| `backend/app/api/` | Thin HTTP adapters |
| `frontend/src/` | SPA — never imports data clients outside `api/` |
| `mockdata/` | Catalog + fact fixtures + hazard grids |
| `backend/tests/` | pytest (~107) |
| `frontend/src/**/__tests__` | vitest |

---

## 7. How to run and how to test (do this before debating quality)

### Local

```bash
# Backend
cd backend
python3.12 -m venv .venv   # 3.12 preferred; 3.11 works for most paths
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
# optional SQL: pip install -e ".[sql]"
uvicorn app.main:app --reload --port 8000

# Frontend (second terminal)
cd frontend
npm install
# set VITE_MAPBOX_TOKEN in frontend/.env
npm run dev                # http://localhost:5173  proxies /api → :8000
```

### Tests (the primary quality gate)

```bash
cd backend && pytest -q          # expect ~107 passed
cd frontend && npx vitest run    # expect ~34 passed
```

### Smoke the multi-EDM plane without SQL

```bash
curl -s http://localhost:8000/api/health | jq
curl -s -X POST http://localhost:8000/api/admin/cache/warmup \
  -H 'content-type: application/json' \
  -d '{"inForceOnly": true}' | jq
curl -s http://localhost:8000/api/admin/cache | jq
```

### Point at real EDMs (when network allows)

1. Copy `mockdata/sql_servers.example.json` → `mockdata/sql_servers.json`.
2. Fill hosts/creds for each `serverName` used in `cedents.json` / linkage.
3. Prefer a stable view **`ee_exposure_facts`** per EDM DB (demo column shape
   or ERT Evolution columns — both mapped in `sql_row_map.py`).
4. Set `DATA_PROVIDER=hybrid` (SQL when registered, mock otherwise).
5. Warm cache: `POST /api/admin/cache/warmup`.

---

## 8. “AI-made code” — how to review without dismissing or rubber-stamping

This repo was built with heavy AI assistance under a **written contract**
(`CLAUDE.md` + `docs/*`). That is not the same as an unreviewed chat dump.

### What is unusually good for a prototype (worth keeping)

1. **Provider boundary** — UI and calc are independent of mock vs SQL.
2. **Canonical contracts** — enums and warning codes are documented once.
3. **Calc purity** — map/pivot/export share one math path (export accuracy rule).
4. **Soft-failure design** — missing IED / partial ERT surfaces as warnings.
5. **Scenario fixtures** — intentional ERT_PARTIAL, AlwaysFails, currency mix.
6. **Automated tests** on provider, grouping, calc, API, multi-EDM cache.

### What is still demo-grade (plan for before firm production)

1. **No authentication** — intentional for this offline demo.
2. **In-memory ERT jobs / dataset groups** — break on multi-instance serverless.
3. **Process-local fact cache** — empty after every cold start on Vercel.
4. **Portfolio = union of loaded pre-agg facts in Python** — fine for
   hundreds of *pre-aggregated* EDMs with cache; not for raw location tables.
5. **Single-tenant assumptions** — no deal-level entitlements.
6. **External weather APIs** — best-effort; offline degrades gracefully-ish.

### Recommended review protocol (half-day)

| Step | Action | Pass criteria |
|---|---|---|
| 1 | Read this file + `CONTRACTS.md` + `DATA_MODEL.md` | You can explain max-across-perils |
| 2 | Run backend + frontend tests | All green |
| 3 | Trace one number: map TIV for Farmers BDA 2027 FL | Matches export sheet for same scope |
| 4 | Read `providers/base.py` + `exposures.py` `_resolve_view` | You see selection → facts → calc |
| 5 | Read `services/calculations.py` + `grouping.py` | No hidden SQL; pure reducers |
| 6 | Skim `sqlserver.py` + `fact_cache.py` | You accept/reject multi-EDM approach |
| 7 | List must-fix before internal hosting | Auth, durable cache/jobs, SQL validation |

### Red flags that are *not* present (common AI failure modes)

- Frontend does **not** embed connection strings or raw SQL.
- Money does **not** silently drop currency.
- Missing denominators do **not** become `0%` market share.
- Table names for ERT are **patterned / configurable**, not hard-coded firm secrets.
- Enums are **not** free-string spaghetti across FE/BE (contract test exists).

If you find a violation of the above, treat it as a bug — the project’s own
rules forbid it (`CLAUDE.md` “10 rules”).

---

## 9. Security & compliance notes (for bring-in discussions)

| Topic | Current stance |
|---|---|
| AuthN/AuthZ | None — demo only |
| Secrets | Env + `sql_servers.json` (do **not** commit real passwords) |
| PII | Exposure aggregates by geo; still commercially sensitive |
| Network | SQL hosts are firm-internal; hybrid mode needs VPN/on-prem |
| Logging | Basic; no full audit trail of who exported what |
| Dependencies | Pin via lockfiles in your pipeline; `pyodbc` optional |

**Recommendation:** host the API on an internal runtime near SQL, keep the SPA
internal, add SSO before any non-demo user access. Do not put production EDM
credentials on Vercel.

---

## 10. Decision matrix: adopt / adapt / rewrite

| If your goal is… | Recommendation |
|---|---|
| Demo for stakeholders / AI-usage showcase | **Ship as-is** (mock or hybrid) |
| Internal pilot with 10–50 real EDMs | **Adopt** shell; validate SQL map; add SSO |
| Firm-wide portfolio over hundreds of EDMs | **Adopt contracts + UI**; harden data plane (warmup service, optional warehouse, durable cache) |
| Replace RMS/ERT generation | **Out of scope** — this consumes cuts, does not own modeling |

---

## 11. Ownership boundaries (suggested)

| Team | Owns |
|---|---|
| Underwriting / exposure ops | Which EDMs, programme tree, treaty linkage |
| Data / SQL platform | ERT cut tables or `ee_exposure_facts` views, server registry |
| App engineering | FastAPI + React, calc correctness, deploy |
| Security | Auth, secrets, network path to SQL |

The **provider ABC** is the intentional seam between app engineering and data
platform. Do not bypass it from the frontend.

---

## 12. FAQ for skeptical reviewers

**Q: Is the math trustworthy?**  
A: It is explicit, documented, and unit-tested. Trust requires you to re-run
tests and spot-check one deal against a known ERT workbook. That is normal.

**Q: Did AI invent reinsurance rules?**  
A: Rules are written down in `CONTRACTS.md` / `CALCULATIONS.md`. If a rule is
wrong for your firm, fix the doc first, then the code — that is the intended
workflow.

**Q: Why Python lists instead of a warehouse?**  
A: Pre-aggregated cuts + cache fit the demo and moderate multi-EDM loads.
A warehouse is a valid next step; the normalized fact shape already looks like
a fact table.

**Q: Why Mapbox?**  
A: Vector tiles for US state/county geometry; app only sends metric payloads,
not giant GeoJSON.

**Q: Can we delete the mock provider later?**  
A: Yes. Keep the ABC; swap `DATA_PROVIDER`. Keep mock fixtures for CI.

**Q: Where do I start coding a change?**  
A: Read the task row in `CLAUDE.md` “Per-task required reading,” change the
smallest layer (usually service or provider), add/adjust a test, keep enums in
`CONTRACTS.md` first if the wire changes.

---

## 13. Document index (keep this updated)

| Doc | Role |
|---|---|
| [FOR_INTERNAL_DEVELOPERS.md](./FOR_INTERNAL_DEVELOPERS.md) | You are here |
| [../CLAUDE.md](../CLAUDE.md) | Hard rules + agent operating manual |
| [../README.md](../README.md) | Quick start |
| [CONTRACTS.md](./CONTRACTS.md) | Canonical wire contract |
| [DATA_MODEL.md](./DATA_MODEL.md) | Entities |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System structure + multi-EDM |
| [API.md](./API.md) | HTTP surface |
| [CALCULATIONS.md](./CALCULATIONS.md) | Formulas |
| [ERT_OUTPUT_FORMAT.md](./ERT_OUTPUT_FORMAT.md) | Source ERT shape |
| [MOCK_DATA.md](./MOCK_DATA.md) | Fixtures |
| [DEPLOY.md](./DEPLOY.md) | Deploy |
| [GLOSSARY.md](./GLOSSARY.md) | Terms |

---

*Last aligned with multi-EDM data plane (fact cache, parallel load, hybrid/SQL
providers, admin cache/connection endpoints). Update this file when those
boundaries change.*
