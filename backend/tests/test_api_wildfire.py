"""Tests for the live wildfire endpoint + service.

Network is mocked (monkeypatched ``urlopen`` / fetchers) so these are
deterministic in CI. One optional integration check hits the real WFIGS
service only when RUN_LIVE_WILDFIRE=1 is set.
"""

from __future__ import annotations

import io
import json
import os

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import live_wildfire

client = TestClient(app)


class _FakeResp:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_FakeResp":
        return self

    def __exit__(self, *a) -> None:
        return None


_FAKE_PERIMETER_GEOJSON = {
    "type": "FeatureCollection",
    "features": [
        {
            "id": 1,
            "geometry": {"type": "Polygon", "coordinates": [[[-120, 39], [-120, 40], [-119, 40], [-119, 39], [-120, 39]]]},
            "properties": {
                "poly_IncidentName": "Big Burn",
                "poly_GISAcres": 50000.0,
                "poly_IRWINID": "{IRWIN-1}",
                "poly_DateCurrent": 1_726_000_000_000,
                "attr_IncidentSize": 50000.0,
                "attr_PercentContained": 25.0,
                "attr_FireCause": "Natural",
                "attr_FireDiscoveryDateTime": 1_725_000_000_000,
                "attr_POOState": "US-CA",
                "attr_IncidentTypeCategory": "WF",
            },
        },
        {
            # Prescribed burn — must be filtered out.
            "id": 2,
            "geometry": {"type": "Polygon", "coordinates": [[[-121, 38], [-121, 39], [-120, 39], [-120, 38], [-121, 38]]]},
            "properties": {
                "poly_IncidentName": "Planned RX",
                "poly_GISAcres": 10.0,
                "attr_IncidentTypeCategory": "RX",
                "attr_POOState": "US-NV",
            },
        },
    ],
}


@pytest.fixture(autouse=True)
def _clear_caches() -> None:
    live_wildfire._PERIM_CACHE.clear()
    live_wildfire._FIRMS_CACHE.clear()


def test_perimeter_parse_filters_prescribed_and_maps_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        live_wildfire.urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeResp(json.dumps(_FAKE_PERIMETER_GEOJSON).encode()),
    )
    perims = live_wildfire.fetch_perimeters(bbox=(-125, 32, -114, 42))
    assert len(perims) == 1  # RX dropped
    fp = perims[0]
    assert fp.name == "Big Burn"
    assert fp.gis_acres == 50000.0
    assert fp.percent_contained == 25.0
    assert fp.state == "CA"  # US- prefix stripped
    assert fp.discovery_at and fp.discovery_at.endswith("Z")
    assert fp.geometry["type"] == "Polygon"


def test_firms_disabled_without_key_returns_note() -> None:
    fires, note = live_wildfire.fetch_active_fires(map_key=None, bbox=(-125, 32, -114, 42))
    assert fires == []
    assert note and "FIRMS_MAP_KEY" in note


def test_firms_parses_viirs_csv(monkeypatch: pytest.MonkeyPatch) -> None:
    csv_text = (
        "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,frp,daynight\n"
        "39.5,-120.2,330.1,0.4,0.4,2026-08-06,2112,N,h,12.3,D\n"
    )
    monkeypatch.setattr(live_wildfire, "FIRMS_SOURCES", ("VIIRS_SNPP_NRT",))
    monkeypatch.setattr(
        live_wildfire.urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeResp(csv_text.encode()),
    )
    fires, note = live_wildfire.fetch_active_fires(map_key="fake-key", bbox=(-125, 32, -114, 42))
    assert note is None
    assert len(fires) == 1
    a = fires[0]
    assert a.lat == 39.5 and a.lon == -120.2
    assert a.brightness_k == 330.1
    assert a.frp_mw == 12.3
    assert a.acquired_at == "2026-08-06T21:12:00Z"


def test_endpoint_shape_and_rollup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        live_wildfire.urllib.request,
        "urlopen",
        lambda req, timeout=0: _FakeResp(json.dumps(_FAKE_PERIMETER_GEOJSON).encode()),
    )
    r = client.get("/api/wildfire/active", params={"bbox": "-125,32,-114,42", "includeHeat": "false"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["perimeters"]["type"] == "FeatureCollection"
    assert j["counts"]["perimeters"] == 1
    assert j["affectedStates"] == [{"state": "CA", "fireCount": 1, "acres": 50000.0}]
    assert "generatedAt" in j and "attribution" in j


def test_endpoint_rejects_bad_bbox() -> None:
    r = client.get("/api/wildfire/active", params={"bbox": "1,2,3"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.skipif(os.environ.get("RUN_LIVE_WILDFIRE") != "1", reason="live network test")
def test_live_wfigs_reachable() -> None:
    perims = live_wildfire.fetch_perimeters(bbox=(-125, 32, -114, 42))
    assert isinstance(perims, list)
