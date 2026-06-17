# Definition of Done — Exposure Eclipse (Mock Prototype)

> Consolidated acceptance checklist for the v1 mock prototype. Per-phase DoD lives in
> `IMPLEMENTATION_PLAN.md`. The prototype is "done" only when **all** of the following hold.

## Runs locally

- [ ] Backend starts on `:8000`; `/api/health` OK.
- [ ] Frontend starts on `:5173`.
- [ ] Mock datasets load via the API.
- [ ] README explains how to run both apps.

## Core workflow (the golden path)

- [ ] User selects current and prior datasets.
- [ ] User sets currency per dataset.
- [ ] ERT status badge appears and is correct.
- [ ] Mock Run/Rerun ERT job runs async (queued→running→completed) and refreshes status.
- [ ] A failed mock ERT job shows the smart error and calls the email service.
- [ ] Mapbox choropleth renders.
- [ ] Metric selector re-colors the map.
- [ ] Tooltips show values **and** explanations.
- [ ] Clicking a geography opens the detail side panel.
- [ ] Warnings panel works.
- [ ] A dataset group can be created and analyzed as one programme.
- [ ] Dataset group defaults to `MAX_ACROSS_PERILS_AT_VIEW_GRAIN`.
- [ ] Pivot works (at least the simplified builder) and agrees with the map/detail.
- [ ] Excel export produces a workbook with all required tabs.
- [ ] Calculation tests pass.

## Correctness & integrity

- [ ] All metrics computed by the shared calc service (no per-surface math).
- [ ] Map, detail, pivot, and export agree for equivalent slices.
- [ ] Max-across-perils matches the worked example and recomputes at the viewed grain.
- [ ] Market share shows N/A + warning on IED gaps (never a fabricated number).
- [ ] YoY New/Removed/N/A handled; no divide-by-zero.
- [ ] Currency is always shown and never silently mixed.
- [ ] Every displayed number is traceable (source → filters → formula → currency → warnings).

## Architecture guardrails

- [ ] Frontend never imports a DB/transport client outside `src/api/`.
- [ ] All data access is behind `ExposureDataProvider`; provider chosen by env.
- [ ] No app branch behaves differently for mock vs real data.
- [ ] Enum values come only from `CONTRACTS.md` (mirrored in BE enums + FE types).
- [ ] No hardcoded SQL table names, support email, or Mapbox token.

## It is NOT done if

- [ ] The frontend queries SQL directly.
- [ ] TIV is summed across peril EDMs by default.
- [ ] Currency is hidden anywhere.
- [ ] Tooltips don't explain metrics.
- [ ] Export doesn't match screen/API data.
- [ ] SQL assumptions are hardcoded before being confirmed in `OPEN_QUESTIONS.md`.
