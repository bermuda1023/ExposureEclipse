import { describe, expect, it } from "vitest";
import {
  formatStamp,
  glmCovers,
  satelliteFor,
  tileTemplate,
} from "../satelliteChoice";

describe("satelliteFor", () => {
  it("picks the nearest full disk", () => {
    expect(satelliteFor(-75).id).toBe("goes-east");
    expect(satelliteFor(-120).id).toBe("goes-west");
    expect(satelliteFor(155).id).toBe("himawari");
    expect(satelliteFor(140).product).toBe("HIMAWARI-true-color");
    expect(satelliteFor(10).id).toBe("meteosat");
    // 170°W is closer to GOES-West (137°W) than to Himawari (141°E).
    expect(satelliteFor(-170).id).toBe("goes-west");
  });

  it("says Meteosat is infrared", () => {
    expect(satelliteFor(8).note).toMatch(/infrared/i);
    expect(satelliteFor(8).note).toMatch(/Not true color/);
  });
});

describe("glmCovers", () => {
  it("covers the Atlantic and not Japan or Europe", () => {
    expect(glmCovers(25, -80)).toBe(true);
    expect(glmCovers(26, 155)).toBe(false);
    expect(glmCovers(48, 10)).toBe(false);
    expect(glmCovers(70, -70)).toBe(false);
  });
});

describe("tile urls", () => {
  it("pins a RealEarth stamp into the XYZ path", () => {
    expect(tileTemplate("G19-ABI-FD-true-color", "20261008.005021")).toBe(
      "https://realearth.ssec.wisc.edu/tiles/G19-ABI-FD-true-color/20261008/005021/{z}/{x}/{y}.png",
    );
    expect(tileTemplate("glmgroupdensity", null)).toBe(
      "https://realearth.ssec.wisc.edu/tiles/glmgroupdensity/{z}/{x}/{y}.png",
    );
    expect(tileTemplate("glmgroupdensity", "nope")).toBe(
      "https://realearth.ssec.wisc.edu/tiles/glmgroupdensity/{z}/{x}/{y}.png",
    );
  });

  it("formats the stamp for the panel", () => {
    expect(formatStamp("20261008.005021")).toBe("2026-10-08 00:50 UTC");
    expect(formatStamp(null)).toBeNull();
  });
});
