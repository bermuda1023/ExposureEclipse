"""MockExposureDataProvider — JSON/CSV-fixture provider for v1.

Reads fixtures from `<mock_data_dir>/` and serves the same `ExposureDataProvider`
contract the SQL provider will eventually satisfy. Per CLAUDE.md rule 2: the
frontend cannot tell which provider served it.

Fixtures (under `mock_data_dir`):
  - `cedents.json`         — Cedent → ProgrammeChain → Programme tree (primary)
  - `dataset_groups.json`  — seed for the in-memory dataset-group store (may be `[]`)
  - `ied_industry.csv`     — RMS IED industry-TIV denominator rows
  - `exposure_facts/<datasetId>.json` — `ExposureFactNormalized[]` per programme's EDM
  - `geo/*.geojson`        — geometry; each feature carries `properties.geographyId`
"""

from __future__ import annotations

import csv
import json
import secrets
from datetime import datetime, timezone
from pathlib import Path

from ..ert.expected_tables import ALL_TABLE_TYPES, EXPECTED_ERT_TABLES, REQUIRED_TABLE_TYPES
from ..models.cedent import Cedent, Programme, ProgrammeChain
from ..models.dataset import (
    DatasetGroup,
    DatasetGroupCreate,
    DatasetStatusResponse,
    ExpectedTableStatus,
)
from ..models.enums import AggregationLevel, ErtStatus, WarningCode
from ..models.exposure import ExposureFactNormalized, IEDIndustryRow
from ..models.warnings import make_warning
from .base import ExposureDataProvider


def _resolve_mock_dir(mock_data_dir: str) -> Path:
    """Resolve `mock_data_dir` relative to the BACKEND directory if it's relative."""
    p = Path(mock_data_dir)
    if p.is_absolute():
        return p
    backend_dir = Path(__file__).resolve().parents[2]
    return (backend_dir / p).resolve()


class MockExposureDataProvider(ExposureDataProvider):
    """In-memory fixture-backed provider. Mock data is static → cache on init."""

    def __init__(self, mock_data_dir: str) -> None:
        self._root = _resolve_mock_dir(mock_data_dir)
        if not self._root.exists():
            raise FileNotFoundError(
                f"MockExposureDataProvider: mock data dir not found: {self._root}"
            )

        # ── Cedent tree ──
        cedents_raw = self._load_json(self._root / "cedents.json")
        self._cedents: list[Cedent] = [Cedent.model_validate(c) for c in cedents_raw]
        # Index for fast lookups.
        self._cedent_by_id: dict[str, Cedent] = {c.cedent_id: c for c in self._cedents}
        self._chain_by_id: dict[str, ProgrammeChain] = {}
        self._programme_by_id: dict[str, Programme] = {}
        self._programme_by_dataset_id: dict[str, Programme] = {}
        for c in self._cedents:
            for ch in c.chains:
                self._chain_by_id[ch.chain_id] = ch
                for p in ch.programmes:
                    self._programme_by_id[p.programme_id] = p
                    self._programme_by_dataset_id[p.dataset_id] = p

        # ── Dataset groups (ad-hoc combinations; remain after the cedent refactor) ──
        self._dataset_groups: list[DatasetGroup] = [
            DatasetGroup.model_validate(g)
            for g in self._load_json(self._root / "dataset_groups.json", default=[])
        ]

        # ── Facts per dataset_id (legacy file naming; one file per programme's EDM) ──
        self._facts_by_dataset: dict[str, list[ExposureFactNormalized]] = {}
        facts_dir = self._root / "exposure_facts"
        if facts_dir.exists():
            for ds_id in self._programme_by_dataset_id:
                fp = facts_dir / f"{ds_id}.json"
                if fp.exists():
                    rows = self._load_json(fp, default=[])
                    self._facts_by_dataset[ds_id] = [
                        ExposureFactNormalized.model_validate(r) for r in rows
                    ]
                else:
                    self._facts_by_dataset[ds_id] = []

        # ── IED denominator ──
        self._ied: list[IEDIndustryRow] = self._load_ied(self._root / "ied_industry.csv")

        # ── Geometry availability — union of `properties.geographyId` across every GeoJSON ──
        self._geometry_ids: set[str] = self._scan_geometry(self._root / "geo")

    # ───────────────────────── loaders ─────────────────────────

    @staticmethod
    def _load_json(path: Path, *, default=None):
        if not path.exists():
            if default is not None:
                return default
            raise FileNotFoundError(f"Required mock fixture missing: {path}")
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def _load_ied(path: Path) -> list[IEDIndustryRow]:
        if not path.exists():
            return []
        rows: list[IEDIndustryRow] = []
        with path.open("r", encoding="utf-8", newline="") as f:
            lines = [ln for ln in f if not ln.lstrip().startswith("#")]
        reader = csv.DictReader(lines)
        for raw in reader:
            rows.append(
                IEDIndustryRow.model_validate(
                    {
                        "geography_level": raw["geographyLevel"],
                        "geography_id": raw["geographyId"],
                        "occupancy_segment": raw["occupancySegment"],
                        "industry_tiv": float(raw["industryTIV"]),
                        "currency": raw["currency"],
                        "source_year": int(raw["sourceYear"]) if raw.get("sourceYear") else None,
                    }
                )
            )
        return rows

    @staticmethod
    def _scan_geometry(geo_dir: Path) -> set[str]:
        ids: set[str] = set()
        if not geo_dir.exists():
            return ids
        for fp in geo_dir.glob("*.geojson"):
            try:
                with fp.open("r", encoding="utf-8") as f:
                    gj = json.load(f)
            except json.JSONDecodeError:
                continue
            for feat in gj.get("features", []) or []:
                gid = (feat.get("properties") or {}).get("geographyId")
                if gid:
                    ids.add(gid)
        return ids

    # ───────────────────────── cedent tree ─────────────────────────

    def list_cedents(self) -> list[Cedent]:
        return list(self._cedents)

    def get_cedent(self, cedent_id: str) -> Cedent | None:
        return self._cedent_by_id.get(cedent_id)

    def get_chain(self, chain_id: str) -> ProgrammeChain | None:
        return self._chain_by_id.get(chain_id)

    def get_programme(self, programme_id: str) -> Programme | None:
        return self._programme_by_id.get(programme_id)

    def get_programme_by_dataset_id(self, dataset_id: str) -> Programme | None:
        return self._programme_by_dataset_id.get(dataset_id)

    # ───────────────────────── ERT status ─────────────────────────

    def get_dataset_status(self, dataset_id: str) -> DatasetStatusResponse:
        programme = self._programme_by_dataset_id.get(dataset_id)
        # Status comes from the programme's EDMRef. We synthesize the per-cut
        # presence list from ertStatus: READY → all cuts; PARTIAL → required only;
        # NOT_FOUND → none. (Same convention the old datasets.json used via
        # `tablesPresent`; here we encode it once at the EDM level.)
        if programme is None:
            status = ErtStatus.ERT_NOT_FOUND
            present: set[str] = set()
            edm_name = dataset_id
        else:
            status = ErtStatus(programme.edm.ert_status)
            edm_name = programme.edm.edm_database_name
            if status == ErtStatus.ERT_NOT_FOUND:
                present = set()
            elif status == ErtStatus.ERT_PARTIAL:
                # Only the v1-required cuts are present; optional ones missing.
                present = set(REQUIRED_TABLE_TYPES) - {"PERIL_DETAILS"}
            else:
                present = set(ALL_TABLE_TYPES)

        table_rows = [
            ExpectedTableStatus(
                table_type=t.table_type,
                name=t.table_name_pattern.format(edm=edm_name, table_type=t.table_type),
                exists=t.table_type in present,
                row_count=(self._row_count_for_table(dataset_id, t.table_type)
                           if t.table_type in present else 0),
            )
            for t in EXPECTED_ERT_TABLES
        ]

        warnings = []
        if status == ErtStatus.ERT_NOT_FOUND:
            warnings.append(
                make_warning(WarningCode.WARN_ERT_NOT_FOUND, context={"datasetId": dataset_id})
            )
        elif status == ErtStatus.ERT_PARTIAL:
            missing = sorted(REQUIRED_TABLE_TYPES - present)
            warnings.append(
                make_warning(
                    WarningCode.WARN_ERT_TABLES_PARTIAL,
                    context={"datasetId": dataset_id, "missingTableTypes": missing},
                )
            )

        return DatasetStatusResponse(
            dataset_id=dataset_id,
            ert_status=status,
            tables=table_rows,
            warnings=warnings,
        )

    def _row_count_for_table(self, dataset_id: str, table_type: str) -> int:
        if table_type == "EVOLUTION":
            return len(self._facts_by_dataset.get(dataset_id, []))
        return 0

    # ───────────────────────── dataset groups ─────────────────────────

    def list_dataset_groups(self) -> list[DatasetGroup]:
        return list(self._dataset_groups)

    def get_dataset_group(self, dataset_group_id: str) -> DatasetGroup | None:
        return next(
            (g for g in self._dataset_groups if g.dataset_group_id == dataset_group_id), None
        )

    def create_dataset_group(self, payload: DatasetGroupCreate) -> DatasetGroup:
        new_id = f"grp-{secrets.token_hex(4)}"
        group = DatasetGroup(
            dataset_group_id=new_id,
            group_name=payload.group_name,
            currency=payload.currency,
            combination_method=payload.combination_method,
            members=list(payload.members),
            distinct_segments_confirmed=payload.distinct_segments_confirmed,
            created_at=datetime.now(timezone.utc),
            cedent_name=payload.cedent_name,
            programme_name=payload.programme_name,
            year_of_account=payload.year_of_account,
            notes=payload.notes,
        )
        self._dataset_groups.append(group)
        return group

    # ───────────────────────── facts + denominators ─────────────────────────

    def get_facts_for_dataset(self, dataset_id: str) -> list[ExposureFactNormalized]:
        return list(self._facts_by_dataset.get(dataset_id, []))

    def get_portfolio_facts(self) -> list[ExposureFactNormalized]:
        """Every programme's facts in v1 portfolio = ALL_LOADED_DATASETS. Skip
        programmes whose EDM is missing/never-loaded (ERT_NOT_FOUND with no fact
        file) so they don't pollute the portfolio denominator."""
        out: list[ExposureFactNormalized] = []
        for ds_id, facts in self._facts_by_dataset.items():
            if not facts:
                continue
            out.extend(facts)
        return out

    def get_ied_industry(self) -> list[IEDIndustryRow]:
        return list(self._ied)

    # ───────────────────────── geometry ─────────────────────────

    def get_geometry_availability(self) -> set[str]:
        """Permissive: every geographyId present in fact data is treated as
        renderable, since the Mapbox vector tilesets in production cover all
        real US state + county FIPS. Plus any extras from the tiny geo files."""
        ids: set[str] = set(self._geometry_ids)
        for facts in self._facts_by_dataset.values():
            for f in facts:
                ids.add(f.geography_id)
        return ids

    # ───────────────────────── mock-only helpers ─────────────────────────

    def is_always_fails(self, dataset_id: str) -> bool:
        """Used by the jobs service to simulate ERT_JOB_FAILED."""
        programme = self._programme_by_dataset_id.get(dataset_id)
        if programme is None:
            return False
        return "AlwaysFails" in programme.edm.edm_database_name
