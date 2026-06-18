# GLOSSARY — Exposure Eclipse

Domain terms an engineer must understand to build this correctly.

| Term | Definition |
|---|---|
| **Property Cat** | Property Catastrophe (re)insurance — covers losses from natural catastrophes (hurricane, EQ, etc.). |
| **TIV** | Total Insured Value — the aggregate insured value of exposures. Core monetary measure throughout the app. = Building + Contents + BI. |
| **EDM** | Exposure Data Module — an RMS database holding a client's modeled exposure. Often **one EDM per peril** historically; the v1 mock bundles multi-peril per office-year. |
| **ERT** | Existing SQL routine/output that breaks an EDM into standardized cuts (TIV by state, peril, occupancy, DTC, etc.). V1 consumes ERT outputs; does not rewrite ERT. |
| **CRESTA** | Catastrophe Risk Evaluation and Standardizing Target Accumulations — geographic zoning scheme for cat accumulation. An aggregation level. |
| **RMS IED** | RMS Industry Exposure Database — static reference of **industry** TIV by geography (and occupancy). Denominator for client market share. County-level granularity. |
| **Market share** | Client TIV ÷ RMS IED industry TIV for the same geography (and occupancy segment where available). |
| **Cedent** | The insurer ceding risk to the reinsurer. Top of the navigation tree. |
| **Region** | Short bucket label on a cedent: `Nationwide` / `California` / `Southeast`. |
| **Office** | Where the deal is written (BDA / NYC / LON). Display tier under cedent; resolves to `chainIds[]` on the API. |
| **Chain** (ProgrammeChain) | The renewal lineage for one deal slot. Unit of YoY comparison — latest year auto-pairs with prior. |
| **Programme** | A specific bound (or quoted) treaty for one year. Multi-peril by default; carries an EDMRef. |
| **EDMRef** | The SQL data-source pointer (server, db name, currency, ertStatus). Lives inside a Programme. |
| **Dataset** | Legacy term — equivalent to "the data backing one Programme's EDM" (`programme.datasetId`). The `dataset_id` is still the fact-file naming key (`mockdata/exposure_facts/<id>.json`). |
| **Dataset group** | Legacy ad-hoc combination of multiple EDMs. Mostly superseded by the cedent/office/chain model. |
| **Treaty year** | The year of the reinsurance treaty/account. |
| **Signed share** | The % share the reinsurer actually wrote on a deal. |
| **Peril** | Catastrophe type. Canonical ERT codes: `EQ` Earthquake, `WS` Windstorm (US hurricane), `CS` Convective Storm, `FL` Flood, `FR` Fire, `TR` Terror. Pre-existing RMS aliases: `HU`≈`WS`, `SCS`≈`CS`. |
| **Distance to coast (DTC)** | Banded distance from the coast. Material primarily for `WS` (storm surge + wind). |
| **EXPLIM_GR / EXPLIM_NET** | Exposed Limit, Gross / Net — alternative exposure bases to TIV. |
| **PORTNAME** | Exposure-data snapshot date (`MMDDYYYY`); the dataset's cutoff date / portfolio label. |
| **ERT cut** | One standardized ERT output section, produced by a `CALC.Get_*` function (TIV Summary, Evolution, Construction, Year Built, Stories, Peril Details, Distance to Coast). |
| **Occupancy / OccupancySegment** | Building use class; maps to `RESIDENTIAL` / `COMMERCIAL` / `INDUSTRIAL` / `UNKNOWN`. |
| **Construction / Year built / Number of stories / Geocoding quality** | Building/data dimensions used in pivots and tooltips. |
| **Current viewed grain** | The full set of active grouping dimensions in the current view. Max-across-perils is computed at this grain. |
| **Choropleth** | A map where areas are shaded by a metric value. Our v1 map type — implemented via Mapbox vector tilesets + feature-state. |
| **Portfolio** | In v1, all programmes whose EDM has fact data loaded. |
| **YoY mode** | View modifier: when on, the chosen metric's `metricValue` becomes its YoY change vs the prior period. |
| **HURDAT2** | NOAA's hurricane track database (Atlantic, 1851→). The hurricane overlay live-fetches it. |
| **Saffir-Simpson (SSHWS)** | Hurricane wind-speed scale: TD <34kt, TS 34–63, Cat 1 64–82, Cat 2 83–95, Cat 3 96–112, Cat 4 113–136, Cat 5 ≥137. |
| **Provider** | Backend data-access implementation behind `ExposureDataProvider`. Mock today; SQL Server / Databricks later. |
