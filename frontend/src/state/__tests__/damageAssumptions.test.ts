import { describe, expect, it } from "vitest";
import { DEFAULTS, applyCategory, migrateDamageAssumptions } from "../damageAssumptions";

const OLD = {
  [-1]: { mean: 0.0, sd: 0.0 },
  [0]: { mean: 0.5, sd: 0.3 },
  [1]: { mean: 1.5, sd: 1.0 },
  [2]: { mean: 4.5, sd: 2.0 },
  [3]: { mean: 10.0, sd: 4.0 },
  [4]: { mean: 22.0, sd: 7.0 },
  [5]: { mean: 40.0, sd: 12.0 },
};

describe("trained damage defaults", () => {
  it("rise with category", () => {
    const means = [0, 1, 2, 3, 4, 5].map((c) => DEFAULTS[c as 0].mean);
    expect(means).toEqual([...means].sort((a, b) => a - b));
  });

  it("move an untouched pre-calibration table to the trained defaults", () => {
    const out = migrateDamageAssumptions({ byCategory: OLD, model: "custom" }, 0);
    expect(out.byCategory).toEqual(DEFAULTS);
  });

  it("keep a table the underwriter edited", () => {
    const edited = { ...OLD, [3]: { mean: 12, sd: 5 } };
    const out = migrateDamageAssumptions({ byCategory: edited, model: "kcc" }, 0);
    expect(out.byCategory[3]).toEqual({ mean: 12, sd: 5 });
    expect(out.model).toBe("kcc");
  });

  it("price a Cat 4 slice with the trained band", () => {
    const band = applyCategory(1_000_000, 4, DEFAULTS);
    expect(band.mean).toBeCloseTo(146_000);
    expect(band.low).toBeCloseTo(51_000);
    expect(band.high).toBeCloseTo(241_000);
  });
});
