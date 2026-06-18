# MOCK_DATA — fixtures + scenario coverage

Everything `MockExposureDataProvider` reads lives under `mockdata/`. The
frontend never reads these directly — it goes through `/api/*`.

## Files

```
mockdata/
├── cedents.json              ← Cedent → Chain → Programme tree (primary)
├── dataset_groups.json       ← seed for the in-memory group store (usually [])
├── ied_industry.csv          ← RMS IED denominator (intentional gaps)
├── exposure_facts/
│   └── <datasetId>.json      ← ExposureFactNormalized[] per programme's EDM
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

Total: 7 cedents · 10 chains · ~15 programmes · ~20 EDM fact files.

## Required scenarios (each must be reachable)

| Scenario | Trigger | Expected |
|---|---|---|
| ERT Ready | select most Farmers/Zenith/Coastal programmes | green Ready badge, full map |
| ERT Partial | AcmeRe 2026 | `WARN_ERT_TABLES_PARTIAL` |
| ERT Not Found | Sample Client 2027 | `WARN_ERT_NOT_FOUND`, Run ERT offered |
| Failed ERT job | Designed-To-Fail 2027 + Run ERT | job status `failed` + technical report + `email_sent=true` |
| County unavailable | view county for a state with no county data | state fallback + `WARN_COUNTY_DATA_UNAVAILABLE` |
| IED denominator missing | market share on `US-FL-12086` | `null` + `WARN_IED_DENOMINATOR_MISSING` |
| Currency mismatch | mix USD + EUR (e.g. cedent-level Munich + others) | `WARN_CURRENCY_MISMATCH` |
| Filters return no rows | overconstrained filters | empty features + `WARN_FILTERS_RETURN_NO_ROWS` |
| Prior-year missing | first-year programme (Munich 2027) | YoY status = `NEW` |
| Multi-peril aggregation | Farmers BDA chain | `MAX_ACROSS_PERILS_AT_VIEW_GRAIN` math + warning |
| Hurricane overlay | toolbar toggle | NOAA HURDAT2 tracks colored by Saffir-Simpson |

## Generator scripts

`backend/scripts/` carries idempotent Python that regenerates derived fixtures.
Run with the project's `.venv`.

| Script | What it does |
|---|---|
| `generate_extra_facts.py` | Builds fact files for new programmes (states + counties + dimension variety; deterministic). |
| `merge_farmers_bda.py` | Collapses per-peril Farmers BDA fact files (WS/EQ/CS) into one multi-peril file per year. |
| `backfill_county_rows.py` | Ensures every state with TIV has ≥1 county row (drill-down isn't empty). |
| `build_geo.py` | Pulls `us-atlas` topojson → GeoJSON. Historical; no longer needed since the frontend uses Mapbox vector tilesets. Kept for the SQL-provider transition. |

Re-running any of them is safe.

## ExposureFactNormalized shape

See `docs/DATA_MODEL.md §ExposureFactNormalized`. The mock validates rows
into Pydantic models on load — schema drift surfaces immediately at startup.

## IED denominator

`mockdata/ied_industry.csv` — columns:
`geographyLevel,geographyId,occupancySegment,industryTIV,currency,sourceYear`

The file is hand-tuned to include realistic state-level totals plus
intentional gaps (e.g. `US-FL-12086` omitted) to keep the
`WARN_IED_DENOMINATOR_MISSING` scenario live.

## Adding a new programme

1. Pick a `datasetId` (e.g. `ds-newco-bda-2027`).
2. Add the programme entry under the appropriate cedent/chain in
   `mockdata/cedents.json` (or create a new cedent/chain).
3. Generate or hand-write `mockdata/exposure_facts/<datasetId>.json` —
   `ExposureFactNormalized[]` with country + state + at least one county row
   per state (otherwise drill-in is empty).
4. (Optional) Add IED rows for new geographies in `ied_industry.csv` to
   give the market-share metric a denominator.
5. Restart uvicorn — the mock provider eager-loads on init.
