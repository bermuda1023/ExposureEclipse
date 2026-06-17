# Project Brief — Exposure Eclipse

## One sentence

Exposure Eclipse is a web-based **Property Cat exposure management workbench** that turns
existing ERT/EDM exposure outputs into interactive maps, pivot-style slicing, and Excel
exports so underwriters and property management can analyze deal- and portfolio-level
exposure, market share, and year-over-year movement.

## Names

- **Formal name (use everywhere user-facing):** Exposure Eclipse.
- **Internal nickname (never in UI/docs/exports):** Risk Reaper.

## Users

- **Primary:** Property Cat underwriters; property management.
- **Future:** cat modeling teams, portfolio managers, management, SRS/Front Sheet users.

## The pain point

Exposure data already exists, but it's trapped in static, table-heavy ERT Excel files and
SQL outputs. Those don't show *where* a deal concentrates, *how* it compares to the
portfolio, *what* the client's market share is, or *what changed* year over year — and they
can't combine the multiple per-peril EDMs a client often sends into one programme view.

Users currently can't easily: visualize exposure geographically; compare a deal to the
portfolio; see client market share vs industry TIV; do cross-deal analysis; slice/dice
dynamically; export exactly what's on screen; or group per-peril EDMs into one programme.

## V1 goal

Replicate the *useful* ERT functionality as a web app — maps, filtering, pivot, tooltips,
exports — **consuming existing SQL-generated ERT outputs without rewriting the SQL process.**
Build the **mock-data prototype first** (`IMPLEMENTATION_PLAN.md`).

## V2 direction

Integrate Front Sheet/SRS, smart business search, signed share → QBE net market share,
bound-deal-driven portfolio, and Databricks/Spark for performance. The v1 architecture is
deliberately provider-abstracted so the data source can change without a frontend rewrite.

## Non-goals for v1

Do not: rewrite/optimize the ERT SQL; fully integrate Front Sheet/SRS; implement permissions
or a formal audit trail; recommend pricing or make underwriting decisions; support Brussels
SI; or assume currencies are equal without user confirmation.

## Design principles

Accuracy, traceability, no silent double-counting, no silent currency mixing, clear
explanatory tooltips, subtle data-quality warnings, and a staged build that proves
underwriting value before scaling. (Operationalized in `CLAUDE.md` and `CONTRACTS.md`.)
