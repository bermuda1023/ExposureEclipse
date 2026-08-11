"""Unit tests for the invest probe + invest-aware bundle path.

Mocks atcf_adecks._download_adeck so we don't hit NHC's FTP during tests.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import atcf_adecks, invests


def _adeck_row(tech: str, tau: int, lat_t: int, lon_t: int,
               init: str, wind: int = 40) -> str:
    return (
        f"AL, 91, {init}, 03, {tech:>4}, {tau:>3}, "
        f"{lat_t:>3}N, {lon_t:>4}W, {wind:>3}, 1005, LO\n"
    )


def _fresh_cycle_str() -> str:
    """Current UTC hour rounded to previous 6-hour cycle boundary."""
    now = datetime.now(timezone.utc)
    hh = (now.hour // 6) * 6
    return now.replace(hour=hh, minute=0, second=0, microsecond=0).strftime("%Y%m%d%H")


def _stale_cycle_str() -> str:
    """A cycle from 5 days ago — should be filtered as stale."""
    stale = datetime.now(timezone.utc) - timedelta(days=5)
    hh = (stale.hour // 6) * 6
    return stale.replace(hour=hh, minute=0, second=0, microsecond=0).strftime("%Y%m%d%H")


@pytest.fixture(autouse=True)
def _clear_invests_cache() -> None:
    invests.clear_cache()
    atcf_adecks._download_adeck.cache_clear()


def test_probe_returns_invest_from_fresh_adeck(monkeypatch: pytest.MonkeyPatch) -> None:
    cycle = _fresh_cycle_str()
    fake_adeck = (
        _adeck_row("CARQ", 0, 245, 780, cycle, wind=40)
        + _adeck_row("AVNO", 12, 250, 785, cycle)
        + _adeck_row("AVNO", 24, 255, 790, cycle)
    ).encode()

    def _fake_download(basin: str, cy: int, year: int) -> bytes | None:
        # Only respond for the exact invest slot we're seeding.
        if basin.lower() == "al" and cy == 91:
            return fake_adeck
        return None

    monkeypatch.setattr(atcf_adecks, "_download_adeck", _fake_download)

    result = invests.fetch_active_invests()
    ids = {i.atcf_id for i in result}
    year = datetime.now(timezone.utc).year
    assert f"AL91{year}" in ids
    hit = next(i for i in result if i.atcf_id == f"AL91{year}")
    # CARQ TAU=0 position: 24.5N, -78.0W.
    assert hit.lat == pytest.approx(24.5)
    assert hit.lon == pytest.approx(-78.0)
    assert hit.intensity_kt == 40
    assert hit.name == "Invest AL91"


def test_probe_filters_stale_adecks(monkeypatch: pytest.MonkeyPatch) -> None:
    stale = _stale_cycle_str()
    stale_payload = (
        _adeck_row("CARQ", 0, 245, 780, stale) + _adeck_row("AVNO", 12, 250, 785, stale)
    ).encode()

    monkeypatch.setattr(
        atcf_adecks, "_download_adeck",
        lambda basin, cy, year: stale_payload if (basin.lower(), cy) == ("al", 92) else None,
    )
    assert invests.fetch_active_invests() == []


def test_is_invest_id_recognises_90s_cy() -> None:
    assert invests.is_invest_id("AL912026")
    assert invests.is_invest_id("EP992024")
    assert not invests.is_invest_id("AL092024")
    assert not invests.is_invest_id("AL152024")
    assert not invests.is_invest_id("garbage")


def test_storms_list_includes_invests(monkeypatch: pytest.MonkeyPatch) -> None:
    cycle = _fresh_cycle_str()
    fake_adeck = (
        _adeck_row("CARQ", 0, 245, 780, cycle) + _adeck_row("AVNO", 12, 250, 785, cycle)
    ).encode()
    monkeypatch.setattr(
        atcf_adecks, "_download_adeck",
        lambda basin, cy, year: fake_adeck if (basin.lower(), cy) == ("al", 93) else None,
    )
    client = TestClient(app)
    r = client.get("/api/live/storms")
    assert r.status_code == 200
    body = r.json()
    assert "invests" in body
    ids = {row["stormId"] for row in body["invests"]}
    year = datetime.now(timezone.utc).year
    assert f"AL93{year}" in ids
