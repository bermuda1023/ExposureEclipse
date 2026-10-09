import { describe, expect, it } from "vitest";
import { resampleWindField } from "./windGridResample";

describe("resampleWindField", () => {
  it("turns a coarse step into a blended lattice", () => {
    const cells = [];
    for (const lat of [25, 26]) {
      for (const lon of [-90, -89]) {
        cells.push({
          lat,
          lon,
          windKt: lat === 25 ? 20 : 40,
          diff: lat === 25 ? -10 : 10,
          windDirDeg: 90,
        });
      }
    }
    const painted = resampleWindField(cells, 1);
    expect(painted.step).toBeLessThanOrEqual(0.05);
    expect(painted.cells.length).toBeGreaterThan(cells.length);
    const mid = painted.cells.find(
      (c) => Math.abs(c.lat - 25.5) < 0.08 && Math.abs(c.lon + 89.5) < 0.08,
    );
    expect(mid).toBeTruthy();
    expect(mid!.windKt).toBeGreaterThan(25);
    expect(mid!.windKt).toBeLessThan(35);
    expect(Math.abs(mid!.diff ?? 0)).toBeLessThan(2);
  });
});
