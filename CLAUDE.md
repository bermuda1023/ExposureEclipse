# CLAUDE.md — Exposure Eclipse Agent Operating Manual

> This file is auto-loaded into context. It is the **canonical entry point** for any
> agent or developer building Exposure Eclipse. Read it fully before writing code.
> When in doubt, this file and `docs/CONTRACTS.md` win over prose elsewhere.

## What you are building

**Exposure Eclipse** (internal nickname: *Risk Reaper* — never use in UI/docs) is a
web-based **Property Cat exposure management workbench**. It turns existing ERT/EDM
exposure outputs into an interactive map + pivot analysis platform: select EDMs, view
TIV/location counts geographically, compare a deal vs the loaded portfolio, compute
client market share vs RMS IED industry TIV, analyze year-over-year movement, group
multiple peril EDMs into one programme, and export the exact filtered view to Excel.

**V1 = mock-data prototype.** Prove the UI, API contracts, calculations, warnings, and
exports with mock data. Do **not** connect to SQL Server until the mock contract is stable.

## Your role

Act as a senior full-stack engineer + solution architect + data engineer + QA engineer.
Optimize for **accuracy and traceability**, then UX, then everything else.

## The 12 hard rules (do not violate)

1. **Frontend never touches data sources.** No SQL Server, Databricks, stored procedures,
   or internal tables from the frontend — ever. Frontend → FastAPI → Provider → data.
2. **Mock data first.** Build against `MockExposureDataProvider`. Same API contract the
   SQL provider will satisfy later. The frontend must not know which provider served it.
3. **Never sum TIV across peril EDMs by default.** Default group combination is
   `MAX_ACROSS_PERILS_AT_VIEW_GRAIN`. Summing is allowed **only** when the user explicitly
   marks EDMs as distinct exposure segments (`SUM_DISTINCT_SEGMENTS`).
4. **Max-across-perils is computed at the *current viewed grain*** — every active grouping
   dimension in the current view. See `docs/CALCULATION_RULES.md`.
5. **Never silently mix currencies.** Block or warn. Currency appears in every tooltip,
   panel, and export. See `WARN_CURRENCY_MISMATCH` / `WARN_CURRENCY_ASSUMED`.
6. **Every displayed number is traceable** to: source dataset(s) → filters → formula →
   currency → warnings. If you can't trace it, don't show it.
7. **Do not guess business logic.** If ambiguous, pick a *safe* default, label it as an
   assumption (in code comment + UI warning where user-facing), and continue. Log it in
   `docs/OPEN_QUESTIONS.md` if it needs sign-off.
8. **Do not hardcode** SQL table names, the support email, or the Mapbox token. All come
   from config (`docs/STACK_AND_SETUP.md`) or the `ExpectedERTTable` registry.
9. **Excel export accuracy > formatting.** Numbers must match the screen/API exactly.
10. **Use canonical enums from `docs/CONTRACTS.md`** for metrics, statuses, methods,
    warnings, errors, perils. No ad-hoc string literals on either side of the wire.
11. **Graceful degradation, never fabrication.** Missing county data → show state +
    `WARN_COUNTY_DATA_UNAVAILABLE`. Never invent geography or fill denominators.
12. **Build incrementally** following `docs/IMPLEMENTATION_PLAN.md`. Each phase has a
    Definition of Done; don't start phase N+1 until phase N's DoD passes.

## Golden path (the workflow the product exists to serve)

Select server → treaty year → (filter) → refresh EDM list → pick current EDM →
pick prior EDM (YoY) → set currency → check ERT status → (Run/Rerun ERT if needed) →
load analysis → map by metric → hover tooltip → click geography → detail panel →
create dataset group (WS/EQ/CS) → see max-across-perils warning → pivot → export Excel.

If a change breaks this path, it's wrong regardless of how clean it is.

## Tech stack (pinned in `docs/STACK_AND_SETUP.md`)

- **Frontend:** React 18 + TypeScript 5 + Vite, Mapbox GL JS v3, TanStack Query,
  Zustand, a pivot/data grid (see OPEN_QUESTIONS), Vitest + Testing Library + Playwright.
- **Backend:** Python 3.12 + FastAPI + Pydantic v2, pandas, openpyxl/xlsxwriter, pytest.
- **Dev ports:** frontend `5173`, backend `8000` (`/api` proxied).

## Repo layout (full tree in `docs/PROJECT_STRUCTURE.md`)

```
/frontend        React app (never imports a DB client)
/backend         FastAPI app, providers, calc, export, jobs
/backend/app/providers   mock | sqlserver(v2) | databricks(v2)
/mockdata        JSON/CSV fixtures consumed by MockExposureDataProvider
/docs            specification pack (this is the contract)
```

## How to work each task

For every implementation step, report: **files changed → what changed → how to run →
how to test → assumptions made → next recommended step.** Keep diffs small and reviewable.

## Per-task required reading (scope sub-agents to THIS — don't load the whole pack)

A sub-agent should read **only** its row + the always-load core. This keeps each agent's
context small. `CONTRACTS.md` is the shared contract; everything else is need-to-know.

| Always load (core) | `CLAUDE.md` (this file) + `docs/CONTRACTS.md` |
|---|---|
| Scaffold / config | `docs/STACK_AND_SETUP.md`, `docs/PROJECT_STRUCTURE.md` |
| Backend mock provider / data | `docs/ERT_OUTPUT_FORMAT.md`, `docs/DATA_MODEL.md`, `docs/MOCK_DATA_SPEC.md` |
| Calculations / grouping | `docs/CALCULATION_RULES.md`, `docs/DATA_MODEL.md` |
| API endpoints | `docs/API_SPEC.md` |
| Map / tooltip | `docs/MAPBOX_SPEC.md`, `docs/API_SPEC.md` |
| ERT jobs | `docs/BACKGROUND_JOBS_SPEC.md`, `docs/ERROR_HANDLING.md` |
| Excel export | `docs/PRODUCT_REQUIREMENTS.md §15`, `docs/CALCULATION_RULES.md` |
| Tests | `docs/TEST_PLAN.md` + the doc for the area under test |
| Phasing / DoD | `docs/IMPLEMENTATION_PLAN.md`, `docs/DEFINITION_OF_DONE.md` |

Don't re-explain the contract to a sub-agent in prose — point it at the file. Sub-agents
return **data/diffs/summaries**, not file dumps, to the orchestrator.

## Definition of Done

The whole prototype's DoD is in `docs/DEFINITION_OF_DONE.md`. Per-phase DoD is in
`docs/IMPLEMENTATION_PLAN.md`. Calculation correctness is non-negotiable — see
`docs/TEST_PLAN.md`.

## Document map

| File | Purpose |
|---|---|
| `docs/PROJECT_BRIEF.md` | Why this exists, users, pain point, scope boundaries |
| `docs/PRODUCT_REQUIREMENTS.md` | V1/V2 feature requirements |
| `docs/TECHNICAL_ARCHITECTURE.md` | Layers, provider interface, build strategy |
| `docs/CONTRACTS.md` ⭐ | **Canonical enums/constants — single source of truth** |
| `docs/ERT_OUTPUT_FORMAT.md` ⭐ | **Real ERT cut format (from `BER25_Proforma_ERT`) — the source schema** |
| `docs/GLOSSARY.md` | Domain terminology |
| `docs/DATA_MODEL.md` | Entities + typed fields |
| `docs/CALCULATION_RULES.md` | Formulas, edge cases, pseudocode |
| `docs/API_SPEC.md` | Endpoints, request/response, errors, status codes |
| `docs/MAPBOX_SPEC.md` | Map, layers, geometry sources, tooltips |
| `docs/MOCK_DATA_SPEC.md` | Mock datasets, fixtures, scenarios |
| `docs/BACKGROUND_JOBS_SPEC.md` | ERT async job lifecycle |
| `docs/ERROR_HANDLING.md` | Error envelope, codes, email reporting |
| `docs/STACK_AND_SETUP.md` | Versions, env vars, commands, ports |
| `docs/PROJECT_STRUCTURE.md` | Exact repo tree + conventions |
| `docs/IMPLEMENTATION_PLAN.md` | Phased build with per-phase DoD |
| `docs/TEST_PLAN.md` | Test cases + fixtures |
| `docs/DEFINITION_OF_DONE.md` | Acceptance checklist |
| `docs/OPEN_QUESTIONS.md` | Unresolved decisions (do not guess these) |
