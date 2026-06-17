# Test Plan — Exposure Eclipse

> Calculations are the highest-risk area — test them hardest, with deterministic mock
> fixtures (`MOCK_DATA_SPEC.md`) and exact expected values. Enum codes from `CONTRACTS.md`.

## Test pyramid

- **Backend unit (most coverage):** calculations, grouping, warnings, ERT status logic.
- **Backend API:** endpoint shapes, validation, error envelope, domain-outcome warnings.
- **Frontend unit:** components, hooks, formatting.
- **E2E (Playwright):** the UAT golden-path script below.
- **Contract parity (Phase 9+):** mock vs SQL provider return identical shapes.

## Calculation tests (`test_calculations.py`, `test_grouping.py`)

Each with a fixed fixture and asserted exact value:

- TIV aggregation across filters/dimensions.
- Location count aggregation.
- Deal share of portfolio in geography (+ denominator 0 → `null`).
- Geography share of total portfolio (+ total 0 → `null`).
- Selected deal geography concentration (+ deal total 0 → `null`).
- Client market share (+ IED gap → `null` + `WARN_IED_DENOMINATOR_MISSING`).
- YoY: `OK`, `NEW`, `REMOVED`, `NA` (prior 0), and prior-not-selected warning.
- YoY aggregation-level mismatch → coarser level + `WARN_AGGREGATION_LEVEL_MISMATCH`.
- Currency mismatch blocks combine/compare + `WARN_CURRENCY_MISMATCH`.
- Currency assumption applied → proceeds + `WARN_CURRENCY_ASSUMED`.
- **Max-across-perils at current viewed grain** — assert the exact FL/CA worked example in
  `CALCULATION_RULES.md`; re-assert at a finer grain (County+Occupancy) recomputes max.
- Summing across perils is rejected unless `distinctSegmentsConfirmed`.
- Location count under max = count of the EDM that supplied the max (not summed).
- Ratios computed as aggregate-then-divide (not averaged).

## Dataset / ERT tests

- EDM list filtering (server, treaty year, name, currency).
- ERT status detection: `ERT_READY` / `ERT_PARTIAL` / `ERT_NOT_FOUND` from
  `ExpectedERTTable` required set.
- Dataset group create/load; mixed-currency group → `409 CURRENCY_MISMATCH`.
- Manual currency + manual metadata behavior.

## API tests (`test_api_*.py`)

- Each endpoint returns spec-shaped JSON for valid input.
- Validation errors return the standard envelope with correct `code`/HTTP status.
- Domain outcomes (IED gap, county fallback, no-rows, failed job) return 200 + warnings.
- `metricValue` mirrors the requested `metric`.

## Map tests (frontend)

- Map renders with mock data.
- Metric selector changes coloring; level switch changes features.
- Tooltip values match the `/map` response; explanations present.
- `null` metric renders "N/A", not 0%.
- Click opens the correct detail panel.
- County-unavailable and geometry-missing warnings appear and degrade gracefully.

## Background job tests

- Job starts and returns `jobId` (202).
- Status transitions queued→running→completed.
- Failed job captures full technical detail and sets `emailSent`.
- App remains usable while a job runs.
- `EmailService` is invoked on failure (noop transport in tests).
- Duplicate concurrent job for same (server, edm) returns the existing job.

## Export tests

- File generates successfully and streams as xlsx.
- Numbers exactly match screen/API.
- Includes: filters used, dataset metadata, currency assumptions, warnings, timestamp,
  raw aggregated data, and all required tabs.
- Over `EXPORT_MAX_ROWS` → `413 EXPORT_TOO_LARGE`.

## UI tests

Dataset selector, prior selector, dataset-group workflow, filter panel, pivot grid, detail
panel, warnings panel, export action.

## UAT / E2E golden-path script (Playwright)

1. Open the app.
2. Select mock **Farmers 2027 WS** EDM.
3. View map by **TIV**.
4. Change metric to **Client Market Share**.
5. Select **Florida**.
6. Review the detail side panel (all sections, distinct share labels).
7. Create a dataset group with **WS/EQ/CS**.
8. See the **max-across-perils** warning.
9. View the group on the map.
10. Open the **pivot**, slice State × Peril, confirm it matches the map.
11. **Export** the workbook; confirm tabs + numbers match the view.

## Coverage expectations

- `services/calculations.py` and `services/grouping.py`: aim for ~100% branch coverage of
  the documented edge cases (every `null`/warning path above is hit).
