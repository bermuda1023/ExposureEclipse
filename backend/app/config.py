"""Env-driven settings. All knobs from docs/STACK_AND_SETUP.md live here."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    data_provider: Literal["mock", "sqlserver", "databricks"] = "mock"
    mock_data_dir: str = "../mockdata"

    support_error_email: str = "support@example.invalid"
    email_transport: Literal["smtp", "graph", "noop"] = "noop"

    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_user: str | None = None
    smtp_pass: str | None = None

    export_max_rows: int = 100_000

    # Vite dev :5173 (proxied), Vite preview :4173 (direct, needs CORS).
    cors_allow_origins: str = "http://localhost:5173,http://localhost:4173"

    sqlserver_conn: str | None = None
    databricks_host: str | None = None
    databricks_token: str | None = None
    databricks_warehouse_id: str | None = None

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
