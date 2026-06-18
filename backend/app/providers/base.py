"""ExposureDataProvider — the boundary between API/services and the data source.

Per CLAUDE.md rule 1: routers/services depend ONLY on this ABC. Mock and SQL
providers satisfy the same shape; the frontend cannot tell them apart.

Calculations operate on the normalized `ExposureFactNormalized` shape so the
calc service is identical regardless of provider.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..models.cedent import Cedent, Programme, ProgrammeChain
from ..models.dataset import (
    DatasetGroup,
    DatasetGroupCreate,
    DatasetStatusResponse,
)
from ..models.enums import AggregationLevel
from ..models.exposure import ExposureFactNormalized, IEDIndustryRow


class ExposureDataProvider(ABC):
    """Abstract contract every provider (mock, sqlserver, databricks) must satisfy."""

    # ───── Cedent → Chain → Programme tree (the primary navigation entity) ─────

    @abstractmethod
    def list_cedents(self) -> list[Cedent]:
        """Return the full cedent → chain → programme tree."""

    @abstractmethod
    def get_cedent(self, cedent_id: str) -> Cedent | None:
        """Fetch one cedent (with its chains+programmes) by id, or None."""

    @abstractmethod
    def get_chain(self, chain_id: str) -> ProgrammeChain | None:
        """Fetch one chain (with its programmes) by id, or None."""

    @abstractmethod
    def get_programme(self, programme_id: str) -> Programme | None:
        """Fetch one programme by id, or None."""

    @abstractmethod
    def get_programme_by_dataset_id(self, dataset_id: str) -> Programme | None:
        """Look up a programme by the legacy fact-file dataset_id."""

    # ───── ERT-status (per programme, keyed by the underlying dataset_id) ─────

    @abstractmethod
    def get_dataset_status(self, dataset_id: str) -> DatasetStatusResponse:
        """ERT-table status for one programme's EDM (drives the ERT badge)."""

    # ───── Dataset groups (kept for ad-hoc combinations beyond cedent/chain) ─────

    @abstractmethod
    def list_dataset_groups(self) -> list[DatasetGroup]:
        """Return all persisted dataset groups."""

    @abstractmethod
    def get_dataset_group(self, dataset_group_id: str) -> DatasetGroup | None:
        """Fetch one group by id, or None."""

    @abstractmethod
    def create_dataset_group(self, payload: DatasetGroupCreate) -> DatasetGroup:
        """Persist a new dataset group. Provider may validate currency consistency, etc."""

    # ───── Fact rows + denominators ─────

    @abstractmethod
    def get_facts_for_dataset(self, dataset_id: str) -> list[ExposureFactNormalized]:
        """All normalized fact rows for one programme's underlying EDM."""

    @abstractmethod
    def get_portfolio_facts(self) -> list[ExposureFactNormalized]:
        """All facts across every programme whose EDM is loaded in the portfolio (v1)."""

    @abstractmethod
    def get_ied_industry(self) -> list[IEDIndustryRow]:
        """RMS IED industry-TIV rows. May have intentional geography gaps."""

    # ───── Geometry availability ─────

    @abstractmethod
    def get_geometry_availability(self) -> set[str]:
        """Set of `geographyId` values renderable on the map.

        Production frontends render via Mapbox vector tilesets that cover every
        US state + county; this set is consulted to flag fact rows that
        reference geographies the tileset doesn't have (synthetic or non-canonical
        ids → `WARN_MAP_GEOMETRY_MISSING`).
        """
