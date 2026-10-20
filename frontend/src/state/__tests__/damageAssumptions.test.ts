import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  applyCategory,
  blendCalibratedCurve,
  calibratedLandMph,
  calibratedPercent,
  effectiveAssumptions,
  migrateDamageAssumptions,
} from "../damageAssumptions";
import type { CurveSetInfo } from "../../api/industryLoss";

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
    expect(out.model).toBe("pcs");
  });

  it("maps a stored vendor curve onto PCS-calibrated", () => {
    const out = migrateDamageAssumptions({ model: "rms" }, 1);
    expect(out.model).toBe("pcs");
    expect(migrateDamageAssumptions({ model: "custom" }, 1).model).toBe("custom");
  });

  it("price a Cat 4 slice with the trained band", () => {
    const band = applyCategory(1_000_000, 4, DEFAULTS);
    expect(band.mean).toBeCloseTo(146_000);
    expect(band.low).toBeCloseTo(51_000);
    expect(band.high).toBeCloseTo(241_000);
  });
});

const BANDS = [41, 51, 61, 71, 81, 91, 101, 111, 121, 131, 141, 151, 161];

function calibratedSet(over: Partial<CurveSetInfo> = {}): CurveSetInfo {
  return {
    id: "calibrated-test",
    label: "Test",
    kind: "calibrated",
    bandsMphLo: BANDS,
    segments: {
      RESIDENTIAL: BANDS.map((_, i) => 0.01 * (i + 1)),
      COMMERCIAL: BANDS.map((_, i) => 0.03 * (i + 1)),
    },
    windFactor: 0.8,
    windExponent: 0,
    windFloor: 0,
    deductible: {},
    sigmaLogCounty: 1.7,
    sigmaLogEvent: 1.0,
    createdAt: null,
    fit: { bookMix: { RESIDENTIAL: 0.5, COMMERCIAL: 0.5 }, sigmaLogPanel: 1 },
    ...over,
  };
}

describe("PCS-calibrated curve", () => {
  it("blends segments by book mix", () => {
    const curve = blendCalibratedCurve(calibratedSet())!;
    expect(curve.bandMid[0]).toBe(45.5);
    expect(curve.dr[0]).toBeCloseTo(0.02);
    expect(curve.dr[12]).toBeCloseTo(0.26);
  });

  it("ignores vendor sets", () => {
    expect(blendCalibratedCurve(calibratedSet({ kind: "vendor" }))).toBeNull();
  });

  it("matches the backend land transform", () => {
    const flat = blendCalibratedCurve(calibratedSet())!;
    expect(calibratedLandMph(flat, 100)).toBeCloseTo(80);
    const shaped = blendCalibratedCurve(calibratedSet({ windExponent: -0.36, windFloor: 0.91 }))!;
    const ref = 64 * 1.15078;
    expect(calibratedLandMph(shaped, ref)).toBeCloseTo(0.8 * ref);
    // Strong winds hit the floor instead of decaying without limit.
    expect(calibratedLandMph(shaped, 150)).toBeCloseTo(0.8 * 150 * 0.91);
  });

  it("interpolates between band midpoints and is zero at 39 mph land", () => {
    const curve = blendCalibratedCurve(calibratedSet())!;
    expect(calibratedPercent(curve, 39 / 0.8)).toBe(0);
    expect(calibratedPercent(curve, 45.5 / 0.8)).toBeCloseTo(2);
    expect(calibratedPercent(curve, 50.5 / 0.8)).toBeCloseTo(3);
  });

  it("prices speed bins and takes SD from the event spread", () => {
    const curve = blendCalibratedCurve(calibratedSet())!;
    const bins = [{ mphLo: 91, mphHi: 100, category: 1, areaFraction: 1 }];
    const out = effectiveAssumptions("pcs", DEFAULTS, bins, curve);
    const mean = calibratedPercent(curve, 95.5);
    expect(out[1].mean).toBeCloseTo(mean);
    expect(out[1].sd).toBeCloseTo(mean * Math.sqrt(Math.E - 1));
  });

  it("keeps the loss band off zero when the all-storm sigma is wider than the mean", () => {
    const curve = blendCalibratedCurve(calibratedSet({
      sigmaLogEvent: 1.03,
      fit: { bookMix: { RESIDENTIAL: 0.5, COMMERCIAL: 0.5 }, sigmaLogPanel: 0.2746 },
    }))!;
    const out = effectiveAssumptions("pcs", DEFAULTS, null, curve);
    expect(out[4].sd).toBeLessThan(out[4].mean);
    expect(out[4].mean - out[4].sd).toBeGreaterThan(0);
  });

  it("falls back to the typed table without a curve", () => {
    expect(effectiveAssumptions("pcs", DEFAULTS, null, null)).toBe(DEFAULTS);
  });
});
