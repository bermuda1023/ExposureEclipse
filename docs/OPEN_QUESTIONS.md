# Open Questions — Exposure Eclipse

> Intentionally unresolved. **Do not guess these** (CLAUDE.md rule 7). For v1 mock work,
> use the listed safe default and label the assumption; resolve before the relevant SQL
> phase. Update Status/Owner as decisions land.

Status: 🔴 open · 🟡 assumed-default-in-use · 🟢 resolved

## SQL routine (blocks Phase 10)

| # | Question | Safe default for v1 mock | Status |
|---|---|---|---|
| 1 | Actual ERT stored procedure name | mock job simulates it | 🔴 |
| 2 | Exact stored procedure parameters | use `API_SPEC` run-job inputs | 🔴 |
| 3 | Special DB context / permissions required? | n/a in mock | 🔴 |
| 4 | Do outputs overwrite existing tables? | `rerun:true` ⇒ overwrite (assumed) | 🟡 |

## ERT table names (blocks Phase 9)

The proforma `BER25_Proforma_ERT` revealed the 7 cuts and their columns
(`ERT_OUTPUT_FORMAT.md`). Cut *structure* is now known; SQL *table/proc* names are not.

| # | Question | Safe default | Status |
|---|---|---|---|
| 5 | SQL table naming rules for each cut | configurable `ExpectedERTTable.TableNamePattern` | 🔴 |
| 6 | Are names built from EDM/year/currency/peril/level? | assume yes, keep pattern configurable | 🟡 |
| 7 | Required cut list for `ERT_READY` | the 7 `CALC.Get_*` cuts (TIV_SUMMARY, EVOLUTION, …) | 🟡 |

## SQL table shapes (blocks Phase 9)

Cut **columns** are documented in `ERT_OUTPUT_FORMAT.md` from the proforma; confirm they
match the eventual SQL outputs exactly.

| # | Question | Status |
|---|---|---|
| 8 | Do SQL outputs match the proforma columns (Building/Contents/BI, EXPLIM_GR/NET, #Account, Invalid_*)? | 🟡 |
| 9 | CRESTA / county detail columns (proforma showed `No Cresta`, no county) | 🔴 |

Map all to `ExposureFactNormalized` (`DATA_MODEL.md`) — already aligned to the proforma.

## RMS IED table (blocks market share on real data)

| # | Question | Status |
|---|---|---|
| 10 | Exact table name | 🔴 |
| 11 | Geography columns + county identifier | 🔴 |
| 12 | Industry TIV / currency / source-year column names | 🔴 |
| 13 | Occupancy / segment columns | 🔴 |

## Occupancy mapping

ERT has `Occupancy` (e.g. `Permanent`) + `OccupancyGroup` (e.g. `Res-MFD`, `Res-SFD`).

| # | Question | Safe default | Status |
|---|---|---|---|
| 14 | Map `OccupancyGroup` (Res-*/Com-*/Ind-*) → RES/COM/IND segment? | prefix-map `Res-`→RESIDENTIAL etc.; keep raw group | 🟡 |
| 15 | Exclude or show unknown occupancy? | **show `UNKNOWN` separately** (never force-map) | 🟢 |
| 28 | Full `OccupancyGroup` value list (only Res-MFD/Res-SFD seen) | data-driven; don't hardcode | 🔴 |

## Pivot grid

| # | Question | Recommended default | Status |
|---|---|---|---|
| 16 | Which React pivot/grid library? | AG Grid Community (MIT) / react-pivottable | 🔴 |
| 17 | Is commercial/licensed library acceptable? | confirm before adopting paid | 🔴 |

## Error email

| # | Question | Recommended default | Status |
|---|---|---|---|
| 18 | Configured support recipient/group | `SUPPORT_ERROR_EMAIL` env, value TBD | 🔴 |
| 19 | SMTP or Microsoft Graph? | pluggable `EmailService`; `noop` in dev | 🟡 |

## Deployment / platform

| # | Question | Default for prototype | Status |
|---|---|---|---|
| 20 | Local-only or internal server? | local prototype first | 🟡 |
| 21 | Authentication expectations | none in v1 prototype | 🟡 |
| 22 | Mapbox token availability & provisioning | `VITE_MAPBOX_TOKEN`; degrade if absent | 🔴 |

## Calculation / product

| # | Question | Default | Status |
|---|---|---|---|
| 23 | Location count under max-across-perils | count from the EDM supplying the max | 🟡 |
| 24 | Currency conversion source (if assumption applied) | user-supplied rate, surfaced as warning | 🟡 |
| 25 | Portfolio definition in v1 | `IsIncludedInPortfolio` flag = `ALL_LOADED_DATASETS` | 🟢 |

## ERT format (from `BER25_Proforma_ERT` — `ERT_OUTPUT_FORMAT.md`)

| # | Question | Default | Status |
|---|---|---|---|
| 26 | Meaning of peril codes `FR` and `TR` | **resolved: `FR`=Fire, `TR`=Terror** | 🟢 |
| 27 | Full band sets for NumberOfStories & Construction (only some seen) | data-driven; don't hardcode | 🔴 |
| 29 | Default exposure basis — TIV vs EXPLIM_GR vs EXPLIM_NET? | default **TIV**; allow GR/NET toggle | 🟡 |
| 30 | Is `Distance to Coast` WS-only, or per peril? | **resolved: produced for all perils but only material for WS; DTC view defaults to WS** | 🟢 |
| 31 | Should market share / pivots use GR/NET in addition to TIV? | TIV first; GR/NET later | 🟡 |
