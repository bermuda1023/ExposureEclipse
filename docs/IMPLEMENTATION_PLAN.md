# Implementation Plan — Exposure Eclipse

> Build incrementally. **Do not start a phase until the previous phase's DoD passes.** Each
> phase lists deliverables + a Definition of Done. The whole-prototype DoD is in
> `DEFINITION_OF_DONE.md`. Follow the golden path in `CLAUDE.md` as the north star.

## Phase 0 — Scaffold & contracts

**Deliverables:** repo layout (`PROJECT_STRUCTURE.md`); `frontend` (Vite+React+TS) and
`backend` (FastAPI) skeletons that start; `.env.example` per app; canonical enums encoded
in **both** `backend/app/models/enums.py` and `frontend/src/types/contracts.ts` from
`CONTRACTS.md`; `/api/health`; lint/test tooling wired.
**DoD:** both apps start (5173 / 8000); health check passes; enums compile on both sides; CI
runs lint + empty test suite.

## Phase 1 — Backend mock API

**Deliverables:** `ExposureDataProvider` interface (`providers/base.py`);
`MockExposureDataProvider` reading `/mockdata`; all endpoints in `API_SPEC.md` returning
real shapes from fixtures; calculation service (`CALCULATION_RULES.md`); warning generation;
provider chosen by `DATA_PROVIDER` env.
**DoD:** every endpoint returns spec-shaped JSON from mock data; calculation unit tests pass
(incl. the worked max-across-perils example); warnings appear where `MOCK_DATA_SPEC.md` says
they should; no calculation logic lives in routers.

## Phase 2 — Frontend app shell

**Deliverables:** layout (header, dataset/filter rail, map container, detail panel slot,
pivot area, **warnings panel**); typed API client in `src/api/`; TanStack Query hooks;
Zustand stores for selection/filters/view-grain.
**DoD:** shell renders; warnings panel displays API warnings; no component imports transport
except via `src/api/`; the app never branches on "mock vs real".

## Phase 3 — Mapbox integration

**Deliverables:** choropleth map (`MAPBOX_SPEC.md`); metric selector; aggregation-level
switch; hover tooltip **with explanations**; click → detail panel; geometry-missing handling.
**DoD:** map renders mock choropleth; changing metric re-colors; tooltip values match the
`/map` response and include formulas; clicking opens the right geography; county-unavailable
and geometry-missing degrade gracefully with warnings.

## Phase 4 — Dataset selector & ERT status

**Deliverables:** server selector, treaty-year input, name filter, refresh EDM list,
current/prior EDM selectors, currency selector per dataset, ERT status badge; mock Run/Rerun
ERT wired to background-job polling (`BACKGROUND_JOBS_SPEC.md`).
**DoD:** full selection workflow works; ERT badge reflects status; mock ERT job goes
queued→running→completed and refreshes status; a failed job shows the smart error and calls
the (noop) email service; app stays usable during a running job.

## Phase 5 — Detail side panel

**Deliverables:** summary, deal vs portfolio, market share, YoY, and breakdowns (peril,
occupancy, DTC, geocoding, stories, construction); active filters + warnings; export action.
**DoD:** panel numbers match `/detail`; all three share metrics labeled distinctly; market
share shows N/A + warning on IED gaps; YoY shows New/Removed/N/A correctly.

## Phase 6 — Dataset groups

**Deliverables:** group creation (members + peril labels), combination method selector
(default max-across-perils), currency confirmation, warnings; group-level map/detail/pivot.
**DoD:** group analyzes like one programme; default is `MAX_ACROSS_PERILS_AT_VIEW_GRAIN`;
max recomputed at the current viewed grain on drill-down; summing blocked unless distinct
segments confirmed; mixed currencies blocked; group warning shown.

## Phase 7 — Pivot workbench

**Deliverables:** simplified pivot builder first (row/2nd-row/column/measure/filters/output/
export); upgrade to drag-drop grid if practical. Pivot uses the **same** calc service.
**DoD:** pivot output matches map/detail for equivalent slices; the rows+columns set is the
view grain used for group combination; export from pivot works.

## Phase 8 — Excel export

**Deliverables:** workbook with all tabs in `PRODUCT_REQUIREMENTS.md §15`, including filters
used, dataset metadata, currency assumptions, warnings, timestamp, raw aggregated data.
**DoD:** export numbers exactly match screen/API; required tabs present; assumptions and
warnings included; over-size export returns `EXPORT_TOO_LARGE`.

---

## Phase 9 — SQL Server provider (after mock contract is stable)

`SqlServerExposureDataProvider` behind the **same** interface: EDM discovery, ERT table
detection via `ExpectedERTTable`, real ERT reads, real IED reads, current/prior comparison.
**DoD:** swapping `DATA_PROVIDER=sqlserver` requires **no** frontend changes; contract
parity tests pass against both providers.

## Phase 10 — ERT procedure execution

Wire Run/Rerun to the real stored procedure **only after name/params confirmed**
(`OPEN_QUESTIONS.md`). Must stay asynchronous; capture full failure context.

## Phase 11 — Front Sheet/SRS prep (v2)

Placeholder fields/architecture (programme ID, Front Sheet ID, office, underwriter, product
class, bound/quoted, signed share). Do not require for v1.

## Phase 12 — Databricks/Spark provider (v2)

`DatabricksExposureDataProvider` behind the same interface. Frontend unchanged.

## Cross-phase guardrails (apply every phase)

- Calculations exist once and are reused (no per-surface math).
- Enum values only from `CONTRACTS.md`.
- No hardcoded table names, support email, or Mapbox token.
- Currency always shown; never silently mixed.
- Every PR reports: files changed / what / how to run / how to test / assumptions / next step.
