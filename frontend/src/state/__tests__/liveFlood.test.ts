import { beforeEach, describe, expect, it } from "vitest";
import { useLiveFloodStore, type SelectedAlert } from "../liveFlood";

const alert = (id: string): SelectedAlert => ({
  id,
  name: "Flash Flood Warning",
  severity: "Severe",
  geometry: { type: "Polygon", coordinates: [[[-90, 35], [-89, 35], [-89, 36], [-90, 36], [-90, 35]]] },
});

describe("live flood store", () => {
  beforeEach(() => {
    useLiveFloodStore.setState({ active: false, minSeverity: "Severe", selectedAlerts: [] });
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

  it("retainAlerts keeps the same array when nothing expired", () => {
    // The selection drives a map source and a POST; a fresh array on every
    // refetch would re-tile and re-request on a 60s timer for no change.
    useLiveFloodStore.getState().toggleAlert(alert("urn:oid:1"));
    const before = useLiveFloodStore.getState().selectedAlerts;
    useLiveFloodStore.getState().retainAlerts(new Set(["urn:oid:1"]));
    expect(useLiveFloodStore.getState().selectedAlerts).toBe(before);
  });
});
