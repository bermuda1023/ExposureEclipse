"""Live flood overlay — endpoint + service tests.

Every test drives a fixture rather than the network. That is not just for
determinism: on a quiet day the live feed carries no moderate-or-worse
flooding at all (a probe on 2026-08-08 found 406 gauges with a single `action`
and zero minor/moderate/major), so the severity paths simply cannot be
exercised against production data.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import live_flood
from app.services.weather_alerts import AlertFeedUnavailable, WeatherAlert

client = TestClient(app)


def _alert(
    *,
    aid: str = "urn:oid:1",
    event: str = "Flash Flood Warning",
    severity: str = "Severe",
    area: str = "Houston, TN; Stewart, TN",
    geometry: dict | None = None,
) -> WeatherAlert:
    return WeatherAlert(
        alert_id=aid,
        event=event,
        headline=f"{event} for somewhere",
        severity=severity,
        urgency="Immediate",
        certainty="Observed",
        sent_at="2026-08-08T12:00:00Z",
        expires_at="2026-08-08T18:00:00Z",
        areas_affected=area,
        geometry=geometry,
    )


def _box(w: float, s: float, e: float, n: float) -> dict:
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


@pytest.fixture(autouse=True)
def _clear_cache():
    """The flood cache is module-level; without this a fixture from one test
    would satisfy the next test's request and mask a real regression."""
    live_flood._CACHE.clear()
    yield
    live_flood._CACHE.clear()


def _patch(monkeypatch, alerts: list[WeatherAlert]) -> dict[str, int]:
    calls = {"n": 0}

    def fake(*, bbox=None, states=None, event_filter=None):
        calls["n"] += 1
        # Mirror the real client's contract: it applies the event filter itself.
        return [a for a in alerts if event_filter is None or a.event in event_filter]

    monkeypatch.setattr(live_flood, "fetch_active_alerts", fake)
    return calls


def test_active_returns_only_polygon_bearing_alerts(monkeypatch) -> None:
    _patch(monkeypatch, [
        _alert(aid="a", geometry=_box(-90, 35, -89, 36)),
        _alert(aid="b", event="Coastal Flood Advisory", severity="Minor", geometry=None),
    ])
    r = client.get("/api/flood/active")
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["counts"] == {"alerts": 1, "zoneOnly": 1}
    assert [f["properties"]["alertId"] for f in j["alerts"]["features"]] == ["a"]
    # A zone-coded alert that vanished with no explanation would understate the
    # event; the count alone is not enough, the user needs the reason.
    assert any("zone-coded" in n for n in j["notes"])


def test_min_severity_filters_below_the_floor(monkeypatch) -> None:
    _patch(monkeypatch, [
        _alert(aid="sev", severity="Severe", geometry=_box(-90, 35, -89, 36)),
        _alert(aid="min", event="Flood Advisory", severity="Minor",
               geometry=_box(-80, 30, -79, 31)),
    ])
    both = client.get("/api/flood/active?minSeverity=Unknown").json()
    assert both["counts"]["alerts"] == 2

    live_flood._CACHE.clear()
    severe = client.get("/api/flood/active?minSeverity=Severe").json()
    assert [f["properties"]["alertId"] for f in severe["alerts"]["features"]] == ["sev"]
    # Filtered-out alerts must not resurface as "zone only" — that count means
    # "had no geometry", and conflating the two would misreport the feed.
    assert severe["counts"]["zoneOnly"] == 0


def test_severity_rank_accompanies_severity(monkeypatch) -> None:
    """The map ramp interpolates on the numeric twin, so it has to agree with
    the string the panel displays."""
    _patch(monkeypatch, [
        _alert(aid="a", severity="Extreme", geometry=_box(-90, 35, -89, 36)),
    ])
    p = client.get("/api/flood/active").json()["alerts"]["features"][0]["properties"]
    assert p["severity"] == "Extreme"
    assert p["severityRank"] == live_flood.SEVERITY_RANK["Extreme"] == 4


def test_affected_states_parsed_from_area_description(monkeypatch) -> None:
    _patch(monkeypatch, [
        _alert(aid="a", area="Houston, TN; Stewart, TN", geometry=_box(-90, 35, -89, 36)),
        _alert(aid="b", area="Baxter, AR", geometry=_box(-92, 36, -91, 37)),
    ])
    states = client.get("/api/flood/active").json()["affectedStates"]
    assert {s["state"]: s["alertCount"] for s in states} == {"TN": 1, "AR": 1}


def test_area_description_without_state_code_is_ignored(monkeypatch) -> None:
    """areaDesc is free text. A trailing token that isn't a 2-letter code must
    not become a phantom state in the roll-up."""
    _patch(monkeypatch, [
        _alert(aid="a", area="The Florida Keys", geometry=_box(-82, 24, -81, 25)),
    ])
    assert client.get("/api/flood/active").json()["affectedStates"] == []


def test_repeat_request_is_served_from_cache(monkeypatch) -> None:
    calls = _patch(monkeypatch, [_alert(aid="a", geometry=_box(-90, 35, -89, 36))])
    client.get("/api/flood/active")
    client.get("/api/flood/active")
    assert calls["n"] == 1, "second identical request should not re-hit NWS"


def test_cached_list_still_honours_each_severity_floor(monkeypatch) -> None:
    """The floor filters the cached list rather than keying it, so switching
    chips must not re-fetch — but must also never serve the Severe-only list to
    an unfiltered caller, which would silently hide live alerts."""
    calls = _patch(monkeypatch, [
        _alert(aid="sev", severity="Severe", geometry=_box(-90, 35, -89, 36)),
        _alert(aid="min", event="Flood Advisory", severity="Minor",
               geometry=_box(-80, 30, -79, 31)),
    ])
    assert client.get("/api/flood/active?minSeverity=Severe").json()["counts"]["alerts"] == 1
    assert client.get("/api/flood/active?minSeverity=Unknown").json()["counts"]["alerts"] == 2
    assert calls["n"] == 1, "changing the floor should re-filter, not re-fetch"


def test_upstream_outage_is_not_reported_as_no_flooding(monkeypatch) -> None:
    """An empty list from a dead feed is indistinguishable from a quiet day.
    Reporting it as 'no active flooding' is a confident all-clear during an
    event, so the outage must be stated and must never be cached."""
    def boom(*, bbox=None, states=None, event_filter=None):
        raise AlertFeedUnavailable("connection reset")

    monkeypatch.setattr(live_flood, "fetch_active_alerts", boom)
    j = client.get("/api/flood/active").json()
    assert j["counts"] == {"alerts": 0, "zoneOnly": 0}
    assert any("could not be reached" in n for n in j["notes"])
    assert not any("No active flood alerts" in n for n in j["notes"])
    assert live_flood._CACHE == {}, "an outage must not be cached as an all-clear"


def test_validation_rejects_bad_bbox_and_severity() -> None:
    assert client.get("/api/flood/active?bbox=1,2,3").status_code == 422
    assert client.get("/api/flood/active?bbox=10,0,5,9").status_code == 422
    assert client.get("/api/flood/active?minSeverity=Catastrophic").status_code == 422


# ─────────────────────── exposed TIV ───────────────────────


def test_exposure_union_does_not_double_count_overlap() -> None:
    """Adjacent flood warnings routinely overlap. The union has to count each
    location once, or the combined TIV feeding the XOL calc is inflated."""
    poly = _box(-83.0, 25.0, -80.0, 28.0)  # over Florida, hits synthetic locations
    body = {"polygons": [
        {"id": "a", "name": "Flood Warning", "geometry": poly},
        {"id": "b", "name": "Flood Warning (dup)", "geometry": poly},
    ]}
    r = client.post("/api/flood/exposure", json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    single = j["results"][0]["totalTiv"]
    assert single > 0, "fixture bbox no longer covers any synthetic locations"
    assert j["results"][1]["totalTiv"] == single
    assert j["combined"]["totalTiv"] == pytest.approx(single, rel=1e-9)
    assert j["combined"]["locationCount"] == j["results"][0]["locationCount"]


def test_exposure_flags_the_upper_bound_caveat() -> None:
    """Alert polygons are warning areas, not observed water. Reporting exposed
    TIV without saying so would overstate precision to an underwriter."""
    body = {"polygons": [{"id": "a", "geometry": _box(-83.0, 25.0, -80.0, 28.0)}]}
    j = client.post("/api/flood/exposure", json=body).json()
    assert j["synthetic"] is True
    assert "upper bound" in j["note"].lower()
    assert j["currency"]


def test_exposure_rejects_oversized_and_malformed_geometry() -> None:
    """The shared geometry guard must apply on this route too — it is the same
    grid walk the wildfire endpoint protects against."""
    from app.api.geometry_input import MAX_POLYGONS

    too_many = {"polygons": [
        {"id": str(i), "geometry": _box(-83.0, 25.0, -80.0, 28.0)}
        for i in range(MAX_POLYGONS + 1)
    ]}
    assert client.post("/api/flood/exposure", json=too_many).status_code == 422

    off_earth = {"polygons": [{"id": "a", "geometry": _box(-999.0, 25.0, -80.0, 28.0)}]}
    assert client.post("/api/flood/exposure", json=off_earth).status_code == 422

    not_a_polygon = {"polygons": [{"id": "a", "geometry": {"type": "Point", "coordinates": [0, 0]}}]}
    assert client.post("/api/flood/exposure", json=not_a_polygon).status_code == 422


def test_exposure_budget_is_charged_per_request_not_per_polygon() -> None:
    """Per-polygon budgets compose badly: many polygons each just under the
    limit pass every per-field check and the vertex cap, but measured 69s
    against a 30s function budget. The request as a whole must be priced."""
    from app.services import wildfire_exposure

    # A CONUS-wide ring sweeps in every synthetic location, so cost is driven by
    # vertex count. Size one ring at ~1/4 of the budget: a single polygon is
    # comfortably legal, four together are not.
    n_locations = len(wildfire_exposure._load_locations().locations)
    verts = max(8, (wildfire_exposure._MAX_WORK // 4) // max(1, n_locations))
    ring = [[-125.0 + (i % 2) * 59.0, 24.0 + ((i // 2) % 2) * 26.0] for i in range(verts - 1)]
    big = {"type": "Polygon", "coordinates": [[[-125.0, 24.0], *ring, [-125.0, 24.0]]]}

    one = client.post("/api/flood/exposure", json={"polygons": [{"id": "a", "geometry": big}]})
    assert one.status_code == 200, "a single ring this size must still be allowed"

    many = {"polygons": [{"id": str(i), "geometry": big} for i in range(8)]}
    r = client.post("/api/flood/exposure", json=many)
    assert r.status_code == 422
    assert "GEOMETRY_TOO_COMPLEX" in r.text


def test_flood_events_exclude_non_flood_products() -> None:
    """The filter is what keeps a hurricane or winter storm off the flood map."""
    assert "Flash Flood Warning" in live_flood.FLOOD_EVENTS
    assert "Coastal Flood Warning" in live_flood.FLOOD_EVENTS
    for other in ("Hurricane Warning", "Tornado Warning", "Winter Storm Warning",
                  "Tsunami Warning", "Hydrologic Outlook"):
        assert other not in live_flood.FLOOD_EVENTS
