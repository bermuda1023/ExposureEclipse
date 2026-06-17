# PROJECT_STRUCTURE — Repo Layout & Conventions

> Target layout for the v1 prototype. Create directories as phases need them; don't
> scaffold empty trees. The boundary that matters most: **frontend never imports a data
> client; all data access lives behind a backend provider.**

## Top level

```
ExposureEclipse/
├── CLAUDE.md                 # agent operating manual (auto-loaded)
├── README.md                 # human entry point + reading order
├── docs/                     # the specification pack (the contract)
├── frontend/                 # React + TS + Vite app
├── backend/                  # FastAPI app
├── mockdata/                 # JSON/CSV fixtures for MockExposureDataProvider
└── .env.example              # (per app, see STACK_AND_SETUP.md)
```

## Backend

```
backend/
├── app/
│   ├── main.py                 # FastAPI app, router registration, CORS
│   ├── config.py               # env-driven settings (Pydantic BaseSettings)
│   ├── api/                    # routers — thin, validate + delegate
│   │   ├── datasets.py
│   │   ├── dataset_groups.py
│   │   ├── exposures.py        # /map /detail /pivot
│   │   ├── ert_jobs.py
│   │   └── exports.py
│   ├── models/                 # Pydantic request/response models (mirror CONTRACTS.md)
│   │   ├── enums.py            # ⭐ the canonical enums, matching docs/CONTRACTS.md
│   │   ├── dataset.py
│   │   ├── exposure.py
│   │   ├── jobs.py
│   │   └── warnings.py
│   ├── providers/              # data access abstraction
│   │   ├── base.py             # ExposureDataProvider interface (ABC)
│   │   ├── mock.py             # MockExposureDataProvider (v1)
│   │   ├── sqlserver.py        # v1 phase 2
│   │   └── databricks.py       # v2 placeholder
│   ├── services/
│   │   ├── calculations.py     # all formulas from CALCULATION_RULES.md
│   │   ├── grouping.py         # dataset group combination (max-across-perils etc.)
│   │   ├── warnings.py         # warning generation
│   │   ├── export_excel.py     # workbook builder
│   │   ├── jobs.py             # background job registry + lifecycle
│   │   └── email.py            # EmailService abstraction
│   └── ert/
│       └── expected_tables.py  # ExpectedERTTable registry (configurable names)
└── tests/
    ├── test_calculations.py    # ⭐ heaviest coverage
    ├── test_grouping.py
    ├── test_api_*.py
    ├── test_jobs.py
    └── test_export.py
```

### Provider rule
`api/*` and `services/*` depend only on `providers/base.ExposureDataProvider`. The concrete
provider is chosen by `DATA_PROVIDER` env at startup (factory in `config.py`/`main.py`).
Calculations operate on the normalized shape (`ExposureFactNormalized`, see DATA_MODEL.md),
so they are identical regardless of provider.

## Frontend

```
frontend/
├── index.html
├── vite.config.ts             # /api proxy
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/                   # typed API client — the ONLY place that calls backend
│   │   ├── client.ts
│   │   ├── datasets.ts
│   │   ├── exposures.ts
│   │   ├── groups.ts
│   │   ├── jobs.ts
│   │   └── exports.ts
│   ├── types/
│   │   └── contracts.ts       # ⭐ TS unions/consts matching docs/CONTRACTS.md
│   ├── state/                 # Zustand stores (selection, filters, view grain)
│   ├── components/
│   │   ├── layout/            # header, shell, warnings panel
│   │   ├── DatasetSelector/
│   │   ├── MetricSelector/
│   │   ├── Map/               # Mapbox wrapper, choropleth layer, tooltip
│   │   ├── DetailPanel/
│   │   ├── Pivot/
│   │   ├── DatasetGroups/
│   │   ├── ErtStatus/
│   │   └── ExportButton/
│   ├── lib/                   # formatting (currency, %, big numbers), helpers
│   └── tests/
└── e2e/                        # Playwright (golden-path UAT script)
```

### Frontend rule
No file outside `src/api/` knows the transport. Components consume typed hooks
(`useMapData`, `useDatasetStatus`, …) backed by TanStack Query. The app must not contain
any branch that behaves differently for "mock vs real" — it only sees API responses.

## Mock data

```
mockdata/
├── datasets.json              # DatasetRegistry rows (mirrors MOCK_DATA_SPEC.md)
├── dataset_groups.json
├── exposure_facts/            # normalized facts per dataset
│   ├── Re_BER_27_Farmers_HU_EDM_01.json
│   └── …
├── ied_industry.csv           # RMS IED industry TIV (with intentional gaps)
└── geo/                       # GeoJSON for country/state/county/CRESTA (see MAPBOX_SPEC)
```

## Naming conventions

- **Enum values on the wire:** `UPPER_SNAKE_CASE` (see CONTRACTS.md).
- **JSON fields & TS:** `camelCase`. **Python internal:** `snake_case`; serialize to
  `camelCase` at the API boundary (Pydantic alias generator).
- **GeographyId:** `US`, `US-FL`, `US-FL-12086` (FIPS county), `CRESTA-<scheme>`.
- **Mock EDM names:** follow `MOCK_DATA_SPEC.md` (`Re_BER_27_Farmers_HU_EDM_01`).
- **Tests:** name by behavior, e.g. `test_yoy_returns_new_when_prior_missing`.
