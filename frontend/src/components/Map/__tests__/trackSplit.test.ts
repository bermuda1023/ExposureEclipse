import { describe, expect, it } from "vitest";
import { segmentsAvoidingAntimeridian } from "../trackSplit";

describe("segmentsAvoidingAntimeridian", () => {
  it("splits a step across 180° into two pieces", () => {
    const parts = segmentsAvoidingAntimeridian([
      { lon: 178, lat: 10 },
      { lon: 179.5, lat: 10 },
      { lon: -179.5, lat: 11 },
      { lon: -178, lat: 11 },
    ]);
    expect(parts).toEqual([
      [{ lon: 178, lat: 10 }, { lon: 179.5, lat: 10 }],
      [{ lon: -179.5, lat: 11 }, { lon: -178, lat: 11 }],
    ]);
  });
});
