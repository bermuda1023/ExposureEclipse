"""Unit tests for the NHC GTWO KML parser + /gtwo endpoint.

Uses hand-crafted KML fixtures — no network. Verifies the chance-bucket
mapping (low < 40% ≤ medium < 60% ≤ high) and the graceful-degradation
behaviour when the upstream is unreachable.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import nhc_gtwo


def _kml_area(name: str, percent: int | None, coords: str,
              style_url: str | None = None) -> str:
    desc = (
        f"<description>Formation chance through 5 days...{percent} percent "
        f"(Medium)</description>" if percent is not None else ""
    )
    style = f"<styleUrl>{style_url}</styleUrl>" if style_url else ""
    return f"""
    <Placemark>
      <name>{name}</name>
      {desc}
      {style}
      <Polygon><outerBoundaryIs><LinearRing>
        <coordinates>{coords}</coordinates>
      </LinearRing></outerBoundaryIs></Polygon>
    </Placemark>
    """


def _kml_doc(placemarks: str) -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        f"{placemarks}"
        "</Document></kml>"
    ).encode()


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    nhc_gtwo.clear_cache()


def test_parser_extracts_percent_and_bucket_from_description() -> None:
    coords = "-75.0,25.0 -70.0,25.0 -70.0,30.0 -75.0,30.0 -75.0,25.0"
    payload = _kml_doc(
        _kml_area("Area 1", 20, coords)
        + _kml_area("Area 2", 50, coords)
        + _kml_area("Area 3", 80, coords)
    )
    areas = nhc_gtwo._parse_gtwo(payload, "atl", 5)
    assert len(areas) == 3
    assert areas[0].chance_pct == 20
    assert areas[0].chance_bucket == "low"
    assert areas[1].chance_pct == 50
    assert areas[1].chance_bucket == "medium"
    assert areas[2].chance_pct == 80
    assert areas[2].chance_bucket == "high"


def test_parser_closes_open_rings() -> None:
    # Open ring — last point ≠ first. Parser should auto-close it.
    coords = "-75.0,25.0 -70.0,25.0 -70.0,30.0 -75.0,30.0"
    payload = _kml_doc(_kml_area("Open", 40, coords))
    areas = nhc_gtwo._parse_gtwo(payload, "atl", 5)
    assert len(areas) == 1
    assert areas[0].ring[0] == areas[0].ring[-1]


def test_parser_falls_back_to_style_url() -> None:
    coords = "-75.0,25.0 -70.0,25.0 -70.0,30.0 -75.0,30.0 -75.0,25.0"
    payload = _kml_doc(_kml_area("No desc", None, coords, style_url="#40percent"))
    areas = nhc_gtwo._parse_gtwo(payload, "atl", 5)
    assert len(areas) == 1
    assert areas[0].chance_pct == 40
    assert areas[0].chance_bucket == "medium"


def test_gtwo_endpoint_smoke_returns_empty_when_upstream_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Force both 2-day + 5-day KML fetches to fail.
    monkeypatch.setattr(nhc_gtwo, "_download_kml", lambda url: None)
    client = TestClient(app)
    r = client.get("/api/live/gtwo?basin=atl")
    assert r.status_code == 200
    body = r.json()
    assert body["twoDay"] == []
    assert body["fiveDay"] == []
    assert body["note"]   # explanation surfaced


def test_gtwo_endpoint_parses_both_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    two_kml = _kml_doc(
        _kml_area("2d1", 30, "-75.0,25.0 -70.0,25.0 -70.0,30.0 -75.0,30.0 -75.0,25.0")
    )
    five_kml = _kml_doc(
        _kml_area("5d1", 70, "-80.0,20.0 -70.0,20.0 -70.0,30.0 -80.0,30.0 -80.0,20.0")
    )

    def _fake_download(url: str) -> bytes | None:
        if "2d0" in url:
            return two_kml
        if "5d0" in url:
            return five_kml
        return None

    monkeypatch.setattr(nhc_gtwo, "_download_kml", _fake_download)
    client = TestClient(app)
    r = client.get("/api/live/gtwo?basin=atl")
    body = r.json()
    assert len(body["twoDay"]) == 1
    assert body["twoDay"][0]["chancePct"] == 30
    assert body["twoDay"][0]["chanceBucket"] == "low"
    assert len(body["fiveDay"]) == 1
    assert body["fiveDay"][0]["chancePct"] == 70
    assert body["fiveDay"][0]["chanceBucket"] == "high"
    assert body["note"] is None


def test_gtwo_endpoint_rejects_unknown_basin() -> None:
    client = TestClient(app)
    r = client.get("/api/live/gtwo?basin=zz")
    assert r.status_code == 422
