"""Data-access providers. The concrete one is chosen by `DATA_PROVIDER` env."""

from __future__ import annotations

from functools import lru_cache

from ..config import get_settings
from .base import ExposureDataProvider


@lru_cache(maxsize=1)
def get_provider() -> ExposureDataProvider:
    """Factory — returns the configured provider as a process-wide singleton.

    Caching matters: the mock provider holds in-memory state (e.g. created
    dataset groups) that would otherwise vanish when FastAPI re-resolves the
    `Depends(get_provider)` dependency on each request. Tests that need a
    fresh provider can clear the cache via :func:`get_provider.cache_clear`.
    """
    settings = get_settings()
    if settings.data_provider == "mock":
        from .mock import MockExposureDataProvider  # local import to avoid cold-load cost

        return MockExposureDataProvider(settings.mock_data_dir)
    if settings.data_provider == "sqlserver":  # pragma: no cover — v1 phase 2
        raise NotImplementedError("SqlServerExposureDataProvider lands in Phase 9.")
    if settings.data_provider == "databricks":  # pragma: no cover — v2
        raise NotImplementedError("DatabricksExposureDataProvider lands in Phase 12.")
    raise ValueError(f"Unknown DATA_PROVIDER: {settings.data_provider!r}")


__all__ = ["ExposureDataProvider", "get_provider"]
