import { describe, expect, it } from "vitest";
import {
  radarAgeBetween,
  radarAgeMin,
  radarCovers,
  radarLoopAges,
  radarTileUrl,
} from "../radarChoice";

describe("NEXRAD composite", () => {
  it("covers the Gulf and not Japan, Hawaii, or Europe", () => {
    expect(radarCovers(26, -90)).toBe(true);
    expect(radarCovers(18.2, -66.5)).toBe(true);
    expect(radarCovers(26, 140)).toBe(false);
    expect(radarCovers(21, -157)).toBe(false);
    expect(radarCovers(48, 10)).toBe(false);
    expect(radarCovers(64, -150)).toBe(false);
  });

  it("builds the latest mosaic and a 5-minute offset", () => {
    expect(radarTileUrl(0, 3)).toBe(
      "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?r=3",
    );
    expect(radarTileUrl(10, 3)).toContain("nexrad-n0q-900913-m10m/");
    expect(radarTileUrl(90, 1)).toContain("nexrad-n0q-900913-m55m/");
    expect(radarAgeMin(0)).toBe(0);
    expect(radarAgeMin(10)).toBe(10);
  });

  it("steps the hour forward and clamps to the live offsets", () => {
    expect(radarLoopAges()).toEqual([50, 40, 30, 20, 10, 0]);
    const newest = Date.parse("2026-10-08T02:00:00Z");
    expect(radarAgeBetween(newest, Date.parse("2026-10-08T01:40:00Z"))).toBe(20);
    expect(radarAgeBetween(newest, Date.parse("2026-10-08T00:00:00Z"))).toBe(55);
    expect(radarAgeBetween(newest, newest)).toBe(0);
  });
});
