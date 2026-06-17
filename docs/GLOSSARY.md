# GLOSSARY — Exposure Eclipse

Domain terms an engineer must understand to build this correctly. Keep this current; if a
term shows up in code/UI and isn't here, add it.

| Term | Definition |
|---|---|
| **Property Cat** | Property Catastrophe (re)insurance — covers losses from natural catastrophes (hurricane, earthquake, etc.). The business line these users work in. |
| **TIV** | Total Insured Value — the aggregate insured value of exposures. The core monetary measure throughout the app. |
| **EDM** | Exposure Data Module — a database (RMS) holding a client's modeled exposure for a programme. Often **one EDM per peril**. |
| **ERT** | The existing SQL routine/output that breaks an EDM into standardized exposure tables (TIV by state, peril, occupancy, distance to coast, etc.). V1 consumes ERT outputs; it does not rewrite ERT. |
| **CRESTA** | Catastrophe Risk Evaluation and Standardizing Target Accumulations — a standardized geographic zoning scheme used for cat accumulation. An aggregation level. |
| **RMS IED** | RMS Industry Exposure Database — a static reference table of **industry** TIV by geography (and occupancy). The denominator for client market share. Has county-level granularity. |
| **Market share** | Client TIV ÷ RMS IED industry TIV for the same geography (and occupancy segment where available). |
| **QBE** | The (re)insurer this tool is built for. |
| **Signed share** | The % share QBE actually wrote on a deal. Needed for *net* market share. **v2** (requires Front Sheet/SRS). |
| **Front Sheet / SRS** | QBE internal systems holding deal/programme metadata (programme ID, cedent, broker, underwriter, office, bound status, signed share). **v2** integration. |
| **Cedent** | The insurance company ceding risk to the reinsurer (the client). |
| **Broker** | Intermediary placing the reinsurance. |
| **Programme** | A client's overall placement for a treaty year — may span multiple peril EDMs. |
| **Treaty year** | The year of the reinsurance treaty/account. |
| **Year of account** | Accounting year a deal belongs to. |
| **Peril** | The catastrophe type. Real ERT codes: `EQ` Earthquake, `WS` Windstorm (US hurricane), `CS` Convective Storm (SCS), `FL` Flood, `FR` Fire, `TR` Terror. RMS aliases: `HU`≈`WS`, `SCS`≈`CS`. See `ERT_OUTPUT_FORMAT.md`. |
| **Distance to coast (DTC)** | Banded distance from the coast. Exists for all perils but only material for `WS` (storm surge + wind); the DTC cut is WS-focused. |
| **TIV components** | TIV = **Building + Contents + BI** (business interruption). ERT reports each component separately. |
| **EXPLIM_GR / EXPLIM_NET** | Exposed Limit, Gross / Net — alternative exposure bases to TIV. Summary cuts show `GR`/`NET`. |
| **PORTNAME / Portname** | The exposure-data snapshot date (`MMDDYYYY`, e.g. `09302025`) the ERT was run on; the dataset's cutoff date / portfolio label. |
| **ERT cut** | One standardized ERT output section, produced by a `CALC.Get_*` function (TIV Summary, Evolution, Construction, Year Built, Stories, Peril Details, Distance to Coast). |
| **EDM (BERxx naming)** | Proforma files are named `BER<yy>_…` (Bermuda + 2-digit treaty year). |
| **Occupancy** | Building use class; mapped (where possible) to Residential / Commercial / Industrial. |
| **Distance to coast (DTC)** | Banded distance of an exposure from the coastline — a key hurricane risk dimension. |
| **Geocoding quality** | How precisely a location was geocoded (e.g. rooftop vs ZIP centroid) — a data-quality dimension. |
| **Construction** | Building construction class (e.g. wood frame, masonry). |
| **Number of stories** | Building height dimension. |
| **Dataset** | One EDM registered in the app (see `DatasetRegistry`). |
| **Dataset group** | Multiple EDMs combined into one analytical programme (e.g. all perils of one client). |
| **Current viewed grain** | The full set of active grouping dimensions in the current view. Max-across-perils is computed at this grain. |
| **Choropleth** | A map where geographic areas are shaded by a metric value. The v1 map type. |
| **Portfolio** | In v1, all currently-loaded datasets flagged `IsIncludedInPortfolio`. In v2, bound deals. |
| **YoY** | Year-over-year comparison between a current EDM and a manually-selected prior-year EDM. |
| **Provider** | Backend data-access implementation behind one interface: Mock (v1), SQL Server (v1+), Databricks (v2). |
| **Risk Reaper** | Internal nickname only. Never use in UI, exports, or formal docs — use **Exposure Eclipse**. |
