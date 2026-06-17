# Product Requirements — Exposure Eclipse

> Feature requirements for v1/v2. Enum values, formulas, and API shapes are defined once in
> `CONTRACTS.md`, `CALCULATION_RULES.md`, and `API_SPEC.md` — this doc references them rather
> than re-specifying.

## 1. Summary

A web app for Property Cat underwriters and property management to visually analyze deal- and
portfolio-level exposure, concentration, market share, and YoY movement via maps, tooltips,
detail drilldowns, pivot slicing, and Excel exports. Consumes existing SQL ERT outputs; data
layer must be swappable to Databricks/Spark without a frontend rewrite.

## 2. Users
Primary: Property Cat underwriters, property management. Future: cat modeling, portfolio
managers, management, SRS/Front Sheet users.

## 3. V1 capabilities (must support)

- EDM database selection from SQL Server (mock first).
- Optional treaty-year / name filtering for EDM lists.
- Manual current + prior-year EDM selection.
- Manual currency per dataset.
- ERT output detection (status badge).
- Run/Rerun ERT button → **async** job (never locks UI).
- Dataset registry; dataset groups (combine EDMs into one programme).
- Mapbox GL JS choropleth; global with detail where data exists.
- Map metric selector; explanatory hover tooltips; click → detail panel.
- Deal vs portfolio comparison; RMS IED market share; YoY via manual prior DB.
- Pivot-style slice-and-dice; Excel export.
- Subtle data-quality warnings panel.
- Smart friendly+technical error handling; configurable error email.

## 4. V2 capabilities
Front Sheet/SRS integration; smart business search (Front Sheet ID, programme, cedent,
broker, year, office, underwriter, product class, status); EDM↔Front Sheet linkage;
bound/quoted/written status; signed share; QBE net market share; automatic prior-year
matching; bound-deal portfolio; Databricks/Spark; performance; saveable views; permissions;
audit trail.

## 5. Dataset selection

**V1 controls:** server selector; treaty-year input; name filter; refresh EDM list;
current EDM; prior EDM; currency per dataset; ERT status indicator. **V2:** replace technical
DB selection with smart business search over SRS/Front Sheet metadata.

## 6. ERT routine

The app may run the existing SQL routine that generates standardized ERT outputs inside the
selected EDM. Procedure name/params are **not finalized** (`OPEN_QUESTIONS.md`); likely
inputs: treaty year, name filter, EDM name, aggregation level, currency, peril, show-lookup
flag, exposure metric (TIV), current/prior cutoff dates, output table names. Run **only**
when outputs are missing/partial/stale or explicitly requested — never on every open.

## 7. ERT output detection

Statuses (`CONTRACTS.md §3`): `ERT_NOT_FOUND`, `ERT_PARTIAL`, `ERT_READY`,
`ERT_READY_PRIOR_RUN_DETECTED`, `ERT_ERROR`. Expected table names are **configurable**
(`ExpectedERTTable`), not hardcoded.

## 8. Dataset groups

Select multiple EDMs; name the group; assign peril labels; choose a combination method; set/
confirm currency; save/reload; analyze as one programme.

## 9. Group combination

Default **`MAX_ACROSS_PERILS_AT_VIEW_GRAIN`** (avoids double-counting). Methods + exact math
in `CONTRACTS.md §4` and `CALCULATION_RULES.md`. Must warn that summing across peril EDMs may
double-count unless EDMs are distinct exposure segments.

## 10. Geography

Levels: country, state, county, CRESTA. Day-one reality: US generally state-level, non-US
country-level; US county is the target. Missing county → show state/country + warning.

## 11. Map measures
The seven `MetricKey`s in `CONTRACTS.md §1`.

## 12. Tooltips
Values **and** explanations: geography name, aggregation level, TIV, location count, the
three share metrics (clearly distinguished), client market share, YoY, currency, active major
filters. Example in `MAPBOX_SPEC.md`.

## 13. Detail side panel
Summary; deal vs portfolio; market share; peril; occupancy; distance to coast; geocoding;
stories; construction; YoY; raw/summary table; export action. Shape in `API_SPEC.md`.

## 14. Pivot / slice-and-dice
True drag/drop pivot if practical (rows, columns, measures, filters, group/sort, export);
otherwise a simplified pivot builder first. Must use the **same** calc rules as map/detail.

## 15. Excel export

Accuracy first, basic formatting only. **Required tabs:** Summary; Filters Used; Dataset
Metadata; Data Quality Warnings; Map Data; Geography Summary; Deal vs Portfolio; Market
Share; YoY Comparison; Peril; Occupancy; Distance to Coast; Geocoding; Stories; Construction;
Pivot Output; Raw Aggregated Data. **Must include:** current/prior dataset, dataset group +
combination method, currency + assumptions, filters, timestamp, warnings, calculation labels.
Formatting: bold headers, frozen header row, currency/percent formats. Numbers must match the
screen/API exactly. Over `EXPORT_MAX_ROWS` → `EXPORT_TOO_LARGE`.

## 16. Data-quality warnings

Subtle but visible panel (and in exports). Codes in `CONTRACTS.md §10`: county unavailable,
currency assumed, currency mismatch, IED denominator missing, prior not selected, aggregation
mismatch, group max-across-perils, ERT partial/not-found, map geometry missing, no rows,
export too large.

## 17. Error handling
Friendly + technical, configurable error email. Envelope and codes in `ERROR_HANDLING.md` /
`CONTRACTS.md §11`.
