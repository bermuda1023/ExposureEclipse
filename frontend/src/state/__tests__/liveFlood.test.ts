import { beforeEach, describe, expect, it } from "vitest";
import { bboxAreaDeg2, inundationBbox, MAX_INUNDATION_BBOX_DEG2 } from "../../api/flood";
import { useLiveFloodStore, type SelectedAlert } from "../liveFlood";

const alert = (id: string): SelectedAlert => ({
  id,
  name: "Flash Flood Warning",
  severity: "Severe",
  geometry: { type: "Polygon", coordinates: [[[-90, 35], [-89, 35], [-89, 36], [-90, 36], [-90, 35]]] },
});

describe("live flood store", () => {
  beforeEach(() => {
    useLiveFloodStore.setState({
      active: false, minSeverity: "Severe", selectedAlerts: [], viewBbox: null,
    });
  });

  it("defaults the floor to Severe — the practical major-flooding cut", () => {
    expect(useLiveFloodStore.getState().minSeverity).toBe("Severe");
  });

  it("toggleAlert selects then deselects the same alert", () => {
    const a = alert("urn:oid:1");
    useLiveFloodStore.getState().toggleAlert(a);
    expect(useLiveFloodStore.getState().selectedAlerts.map((x) => x.id)).toEqual(["urn:oid:1"]);
    useLiveFloodStore.getState().toggleAlert(a);
    expect(useLiveFloodStore.getState().selectedAlerts).toEqual([]);
  });

  it("raising the severity floor drops the selection", () => {
    // Otherwise an alert filtered off the map keeps feeding the combined TIV,
    // so the number moves with nothing on screen to explain it.
    useLiveFloodStore.getState().toggleAlert(alert("urn:oid:1"));
    useLiveFloodStore.getState().setMinSeverity("Extreme");
    expect(useLiveFloodStore.getState().selectedAlerts).toEqual([]);
  });

  it("turning the overlay off drops the selection", () => {
    useLiveFloodStore.getState().toggleAlert(alert("urn:oid:1"));
    useLiveFloodStore.getState().toggle();
    expect(useLiveFloodStore.getState().active).toBe(true);
    expect(useLiveFloodStore.getState().selectedAlerts).toEqual([]);
  });

  it("retainAlerts prunes an alert the feed no longer carries", () => {
    // NWS mints a new urn when an alert is updated or superseded, so after a
    // refetch the old one has no polygon left on the map: it cannot be clicked
    // off, yet it keeps contributing to the combined TIV.
    useLiveFloodStore.getState().toggleAlert(alert("urn:oid:old"));
    useLiveFloodStore.getState().toggleAlert(alert("urn:oid:live"));
    useLiveFloodStore.getState().retainAlerts(new Set(["urn:oid:live"]));
    expect(useLiveFloodStore.getState().selectedAlerts.map((a) => a.id)).toEqual(["urn:oid:live"]);
  });

  it("setViewBbox snaps outward to 0.05° and holds the tuple across a sub-snap pan", () => {
    // moveend fires continuously while panning and the bbox keys the inundation
    // query, so an unsnapped tuple would refetch the extent on every nudge.
    // Outward, never to nearest: snapping in would drop water along the edge of
    // a map the underwriter is looking straight at.
    useLiveFloodStore.getState().setViewBbox([-95.812, 29.437, -94.888, 30.213]);
    const first = useLiveFloodStore.getState().viewBbox;
    expect(first).toEqual([-95.85, 29.4, -94.85, 30.25]);
    useLiveFloodStore.getState().setViewBbox([-95.809, 29.441, -94.891, 30.209]);
    expect(useLiveFloodStore.getState().viewBbox).toBe(first);
  });

  it("setViewBbox does update once the view really moves", () => {
    useLiveFloodStore.getState().setViewBbox([-95.8, 29.45, -94.9, 30.2]);
    useLiveFloodStore.getState().setViewBbox([-90.0, 29.45, -89.0, 30.2]);
    expect(useLiveFloodStore.getState().viewBbox?.[0]).toBe(-90);
  });

  it("a continental view is past the inundation bbox cap", () => {
    // Guarded client-side because past the cap the request can only 422; the
    // panel has to say "zoom in" rather than fire and fail.
    expect(bboxAreaDeg2([-125, 24, -66, 50])).toBeGreaterThan(MAX_INUNDATION_BBOX_DEG2);
    expect(bboxAreaDeg2([-95.8, 29.4, -94.9, 30.2])).toBeLessThan(MAX_INUNDATION_BBOX_DEG2);
  });

  it("inundationBbox rejects an over-cap or antimeridian-wrapped view", () => {
    // Rejects rather than clamps: mapbox returns west > east once the view
    // crosses ±180, and there is no single honest bbox for that view — drawing
    // a substituted one would put modelled water on ground the user isn't
    // looking at.
    expect(inundationBbox([-95.85, 29.4, -94.85, 30.25])).toEqual([-95.85, 29.4, -94.85, 30.25]);
    expect(inundationBbox([-125, 24, -66, 50])).toBeNull();
    expect(inundationBbox([179.5, 51, -179.5, 52])).toBeNull();
    expect(inundationBbox(null)).toBeNull();
  });

  it("retainAlerts keeps the same array when nothing expired", () => {
    // The selection drives a map source and a POST; a fresh array on every
    // refetch would re-tile and re-request on a 60s timer for no change.
    useLiveFloodStore.getState().toggleAlert(alert("urn:oid:1"));
    const before = useLiveFloodStore.getState().selectedAlerts;
    useLiveFloodStore.getState().retainAlerts(new Set(["urn:oid:1"]));
    expect(useLiveFloodStore.getState().selectedAlerts).toBe(before);
  });
});
