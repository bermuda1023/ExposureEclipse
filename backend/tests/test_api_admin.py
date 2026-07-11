"""Admin surface: shared-token gate on mutating routes + write-path fallback."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services import treaty_metadata
from app.services.treaty_metadata import EDMLink, load_linkage, save_linkage


client = TestClient(app)


# ───────────────────────── X-Admin-Token gate ─────────────────────────


@pytest.fixture
def admin_token(monkeypatch: pytest.MonkeyPatch) -> str:
    """Set ADMIN_TOKEN for the duration of a test (settings cache rebuilt)."""
    monkeypatch.setenv("ADMIN_TOKEN", "s3kr1t")
    get_settings.cache_clear()
    yield "s3kr1t"
    get_settings.cache_clear()


def test_mutating_admin_routes_401_without_token(admin_token: str) -> None:
    resp = client.post("/api/admin/cache/warmup", json={})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHORIZED"

    resp = client.put(
        "/api/admin/programmes/NOPE/edm-link",
        json={"serverName": "S", "edmDatabaseName": "D"},
    )
    assert resp.status_code == 401

    resp = client.delete("/api/admin/cache")
    assert resp.status_code == 401


def test_mutating_admin_routes_reject_wrong_token(admin_token: str) -> None:
    resp = client.post(
        "/api/admin/cache/warmup", json={}, headers={"X-Admin-Token": "wrong"}
    )
    assert resp.status_code == 401


def test_mutating_admin_routes_accept_valid_token(admin_token: str) -> None:
    resp = client.post(
        "/api/admin/cache/warmup",
        json={"inForceOnly": True},
        headers={"X-Admin-Token": admin_token},
    )
    assert resp.status_code == 200

    # Read-only admin routes stay open even when the token is set.
    resp = client.get("/api/admin/cache")
    assert resp.status_code == 200
    resp = client.get("/api/admin/programmes")
    assert resp.status_code == 200


def test_admin_routes_open_when_token_unset() -> None:
    """Local-dev default (ADMIN_TOKEN unset) keeps the current open behavior."""
    get_settings.cache_clear()
    resp = client.post("/api/admin/cache/warmup", json={"inForceOnly": True})
    assert resp.status_code == 200


# ───────────────────────── write-path fallback ─────────────────────────


def test_save_linkage_falls_back_to_tmp_overlay_when_mockdata_readonly(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """On a read-only mockdata dir (Vercel), writes land in the tmp overlay
    and are read back on load."""
    primary = tmp_path / "mockdata"
    primary.mkdir()
    overlay = tmp_path / "overlay"
    monkeypatch.setattr(treaty_metadata, "_mockdata_dir", lambda: primary)
    monkeypatch.setattr(treaty_metadata, "_overlay_dir", lambda: overlay)

    primary.chmod(0o555)  # read-only — write_text must raise OSError
    try:
        save_linkage(
            {"FS-1": EDMLink(fs_display_id="FS-1", server_name="SRV", edm_database_name="EDM_DB")}
        )
    finally:
        primary.chmod(0o755)

    assert (overlay / "edm_linkage.json").exists()
    assert not (primary / "edm_linkage.json").exists()
    links = load_linkage()
    assert links["FS-1"].server_name == "SRV"
    assert links["FS-1"].edm_database_name == "EDM_DB"


def test_save_linkage_prefers_primary_and_clears_stale_overlay(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    primary = tmp_path / "mockdata"
    primary.mkdir()
    overlay = tmp_path / "overlay"
    overlay.mkdir()
    (overlay / "edm_linkage.json").write_text('{"FS-STALE": {}}', encoding="utf-8")
    monkeypatch.setattr(treaty_metadata, "_mockdata_dir", lambda: primary)
    monkeypatch.setattr(treaty_metadata, "_overlay_dir", lambda: overlay)

    save_linkage(
        {"FS-2": EDMLink(fs_display_id="FS-2", server_name="SRV2", edm_database_name="DB2")}
    )

    assert (primary / "edm_linkage.json").exists()
    assert not (overlay / "edm_linkage.json").exists()  # stale copy removed
    links = load_linkage()
    assert set(links) == {"FS-2"}
