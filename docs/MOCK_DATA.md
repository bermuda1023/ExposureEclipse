# MOCK_DATA — fixtures + scenario coverage

Everything `MockExposureDataProvider` (and the hybrid/SQL providers' catalog)
read lives under `mockdata/`. The frontend never reads these directly — it
goes through `/api/*`.

Facts load **lazily** per `datasetId` into the process-wide `FactCache`
(not all files at process start). See [`MULTI_EDM.md`](./MULTI_EDM.md).

## Files

```
mockdata/
├── cedents.json              ← Cedent → Chain → Programme tree (primary catalog)
├── dataset_groups.json       ← seed for the in-memory group store (usually [])
├── datasets.json             ← legacy flat dataset list (kept for back-compat)
├── ied_industry.csv          ← RMS IED denominator (intentional gaps)
├── exposure_facts/
│   └── <datasetId>.json      ← ExposureFactNormalized[] per programme's EDM
├── treaty_metadata.json      ← admin treaty rows (auto-saved by /api/admin)
├── edm_linkage.json          ← fs_display_id → (serverName, edmDatabaseName)
├── sql_servers.example.json  ← multi-host SQL registry template
├── sql_servers.json          ← local registry (create from example; do not commit secrets)
├── hazard_tornado_grid.json  ← {stepDeg, cells[{lat,lon,raw}]}, climatology blend
├── hazard_hail_grid.json     ← same shape
├── hazard_wildfire_grid.json ← same shape
├── fund_returns.json         ← fund-analysis demo series (if enabled)
└── geo/                      ← tiny country + CRESTA features only
                                 (state + county come from Mapbox tilesets,
                                  not GeoJSON)
```

## Cedents in the v1 fixture

| Cedent | Region | Offices | Notes |
|---|---|---|---|
| Farmers Group | Nationwide | BDA + NYC | BDA chain has 2025/2026/2027 multi-peril (WS+EQ+CS); NYC has 2026/2027 FL-only WS |
| AcmeRe Holdings | Nationwide | BDA | 2026 = `ERT_PARTIAL` (demo scenario) |
| Zenith Insurance | California | NYC | CA-heavy EQ; 2026/2027 |
| Coastal Re | Southeast | NYC | FL-dominant hurricane QS; 2026/2027 |
| Munich Risk | Southeast | LON | EUR currency, only 2027 → demonstrates "NEW" YoY |
| Sample Client AG | Nationwide | LON | `ERT_NOT_FOUND` scenario |
| Designed To Fail Co. | Test | BDA | EDM name contains "AlwaysFails" → jobs service simulates failure |

Total: 7 cedents · 10 chains · ~15 programmes · ~19 EDM fact files · ~42k fact rows · ~47 MB on disk.

Largest files (Farmers BDA multi-year multi-peril) are ~10k rows / ~12 MB each —
representative of a rich pre-aggregated cut, not a raw location dump.

## Required scenarios (each must be reachable)

| Scenario | Trigger | Expected |
|---|---|---|
| ERT Ready | most Farmers / Zenith / Coastal programmes | green Ready badge, full map |
| ERT Partial | AcmeRe 2026 | `WARN_ERT_TABLES_PARTIAL` |
| ERT Not Found | Sample Client 2027 | `WARN_ERT_NOT_FOUND`, Run ERT offered |
| Failed ERT job | Designed-To-Fail 2027 + Run ERT | job status `failed` + technical report + `email_sent=true` |
| County unavailable | view county for a state with no county data | state fallback + `WARN_COUNTY_DATA_UNAVAILABLE` |
| IED denominator missing | market share on `US-FL-12086` | `null` + `WARN_IED_DENOMINATOR_MISSING` |
| Currency mismatch | mix USD + EUR (e.g. cedent-level Munich + others) | `WARN_CURRENCY_MISMATCH` |
| Filters return no rows | overconstrained filters | empty features + `WARN_FILTERS_RETURN_NO_ROWS` |
| Prior-year missing | first-year programme (Munich 2027) | YoY status = `NEW` |
| Multi-peril aggregation | Farmers BDA chain | `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` math + warning |
| Hurricane historical overlay | Hurricanes button + filters | NOAA IBTrACS tracks coloured by Saffir-Simpson |
| Hurricane impact engine | click a storm on the map | wind cone + county roll-up + per-programme breakdown |
| Live storm replay | Hurricanes button → replay row (no active storms) | bundle with cones + alerts + buoys + SST |
| Hazard overlay | "Risk: Tornado" / "Hail" chip | hazard surface; exposure choropleth hides while active |
| Treaty admin | URL `/admin/programmes` | editable table + CSV import + EDM auto-suggest |
| Cache warmup | `POST /api/admin/cache/warmup` | facts land in process cache (see `/api/admin/cache`) |

## Generator + build scripts

`backend/scripts/` carries idempotent Python — run with the project's `.venv`.

| Script | What it does |
|---|---|
| `generate_extra_facts.py` | Builds fact files for new programmes (states + counties + dimension variety; deterministic). |
| `merge_farmers_bda.py` | Collapses per-peril Farmers BDA fact files (WS/EQ/CS) into one multi-peril file per year. |
| `backfill_county_rows.py` | Ensures every state with TIV has ≥1 county row (drill-down isn't empty). |
| `build_geo.py` | Pulls `us-atlas` topojson → GeoJSON. Historical; no longer needed since the frontend uses Mapbox vector tilesets. |
| `build_tornado_grid.py` | Reads SPC SVRGIS shapefile (pyshp) → KDE → climatology blend → `hazard_tornado_grid.json`. |
| `build_hail_grid.py` | Same for the SPC hail shapefile. |
| `build_wildfire_grid.py` | Reads WFIGS perimeters CSV → acres-weighted KDE → `hazard_wildfire_grid.json`. |
| `_climatology.py` | Smooth Gaussian anchors (Brooks/Tippett/Cintineo) used by the tornado + hail builds. |
| `_pop_bias.py` | Per-city deflator + local-spike smoother. **Unused** in the shipped pipeline (the climatology blend replaces it) but kept for reference; see `docs/CALCULATIONS.md` § Hazard climatology blend. |

Re-running any of them is safe.

## ExposureFactNormalized shape

See `docs/DATA_MODEL.md` § ExposureFactNormalized. The mock validates rows
into Pydantic models **on first load of that dataset** (cache miss) — schema
drift surfaces on first request for that EDM, not necessarily at process start.

## IED denominator

`mockdata/ied_industry.csv` — columns:
`geographyLevel,geographyId,occupancySegment,industryTIV,currency,sourceYear`

The file is hand-tuned to include realistic state-level totals plus
intentional gaps (e.g. `US-FL-12086` omitted) to keep the
`WARN_IED_DENOMINATOR_MISSING` scenario live.

## Treaty metadata + EDM linkage

`mockdata/treaty_metadata.json` is a list of treaty rows (one per
FS-display-ID layer). `mockdata/edm_linkage.json` maps each `fsDisplayId`
to `{serverName, edmDatabaseName}` so the admin page can show the linked
EDM. Both are auto-saved by `/api/admin/programmes/edm-links` and the
`/import` endpoint — drop a CSV into the admin page UI and the metadata
file gets replaced atomically.

## SQL server registry (hybrid / sqlserver)

`sql_servers.example.json` documents the multi-host map. Copy to
`sql_servers.json` and fill real hosts. Never commit production passwords.
Details: [`MULTI_EDM.md`](./MULTI_EDM.md).

## Hazard grids

Each `mockdata/hazard_*_grid.json` is `{stepDeg, cells: [{lat, lon, raw}]}`.
`raw` units differ per peril (see each peril's `legend.unit` on the API
response). The frontend uses `stepDeg` to size each fill polygon — never
hard-code 0.2°.

Tornado + hail have ~15-21k cells; wildfire has ~17k cells at the finer
0.15° step. All three exclude ocean / sea cells (climatology surface only
fires over land; WFIGS perimeters are only land-fire records).

## Adding a new programme

1. Pick a `datasetId` (e.g. `ds-newco-bda-2027`).
2. Add the programme entry under the appropriate cedent/chain in
   `mockdata/cedents.json` (or create a new cedent/chain). Include a full
   `edm` block (`serverName`, `edmDatabaseName`, `currency`, `ertStatus`, …).
3. Generate or hand-write `mockdata/exposure_facts/<datasetId>.json` —
   `ExposureFactNormalized[]` with country + state + at least one county
   row per state (otherwise drill-in is empty).
4. (Optional) Add IED rows for new geographies in `ied_industry.csv` to
   give the market-share metric a denominator.
5. Restart is **not** required for new fact files if the process already
   knows the programme from `cedents.json` — but new catalogue entries need
   a provider reload (restart uvicorn / clear provider singleton).
6. First map request for that `datasetId` loads and caches the facts.
   Optional: `POST /api/admin/cache/warmup` with that id.
