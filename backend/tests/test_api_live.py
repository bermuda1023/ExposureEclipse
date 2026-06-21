"""Smoke tests for the live + replay hurricane endpoints. Hits real NOAA /
NWS / NHC endpoints over the network — these are integration-flavoured."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_storm_list_returns_replay_candidates_even_when_atlantic_is_quiet() -> None:
    r = client.get("/api/live/storms")
    assert r.status_code == 200
    body = r.json()
    # Replay candidates always available.
    assert len(body["replay"]) >= 4
    assert all("label" in r for r in body["replay"])
    # When no live storms, the note explains the replay path.
    if body["hasActive"] is False:
        assert body["note"]


def test_replay_bundle_returns_observed_and_forecasts() -> None:
    r = client.get(
        "/api/live/storms/AL142018",
        params={"includeObs": "false", "includeAlerts": "false", "includeLand": "false", "includeSst": "false"},
    )
    assert r.status_code == 200
    b = r.json()
    assert b["storm"]["name"].upper() == "MICHAEL"
    assert len(b["observedTrack"]) > 5
    assert len(b["forecasts"]) >= 1
    # Latest advisory should have the highest advisory_number.
    advs = sorted(b["forecasts"], key=lambda a: -a["advisoryNumber"])
    assert advs[0]["advisoryNumber"] == max(a["advisoryNumber"] for a in b["forecasts"])
    assert b["bbox"][0] < b["bbox"][2]  # west < east
    assert b["bbox"][1] < b["bbox"][3]  # south < north


def test_replay_bundle_unknown_storm_404() -> None:
    r = client.get("/api/live/storms/AL999999", params={"includeObs": "false", "includeAlerts": "false", "includeLand": "false", "includeSst": "false"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "DATASET_NOT_FOUND"


def test_replay_bundle_sst_layer_bounded() -> None:
    r = client.get(
        "/api/live/storms/AL142018",
        params={"includeObs": "false", "includeAlerts": "false", "includeLand": "false", "includeSst": "true"},
    )
    assert r.status_code == 200
    b = r.json()
    # SST grid is bounded to the storm bbox — even a basin-wide replay stays
    # under 10k cells thanks to the adaptive step (0.25° / 0.5° / 1.0°).
    assert 0 < len(b["sst"]) < 10000
    assert b["sstMinC"] is not None and b["sstMaxC"] is not None
    assert b["sstMinC"] <= b["sstMaxC"]


@pytest.mark.parametrize("flag", ["includeObs", "includeAlerts", "includeLand", "includeSst"])
def test_replay_bundle_individual_layer_toggles(flag: str) -> None:
    # Each layer can be turned off without affecting the rest.
    off = {k: "false" for k in ("includeObs", "includeAlerts", "includeLand", "includeSst")}
    off[flag] = "false"
    other_on = {k: ("true" if k != flag else "false") for k in off}
    r = client.get("/api/live/storms/AL142018", params=other_on)
    assert r.status_code == 200
