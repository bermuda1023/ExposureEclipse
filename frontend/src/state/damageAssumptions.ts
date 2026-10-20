/**
 * User-input damage-ratio assumptions, by Saffir-Simpson category.
 *
 * The underwriter enters a mean damage ratio and a standard deviation per
 * category; the impact panel applies those to each county's TIV (and per-
 * programme TIV) to produce a projected loss + a low/high band. The
 * PCS-calibrated model instead uses an asymmetric empirical holdout range.
 *
 *   loss_mean = TIV × mean
 *   loss_low  = TIV × max(0, mean − sd)
 *   loss_high = TIV × min(1, mean + sd)
 *
 * Both values in percent (0..100). The store is persisted to localStorage
 * so the user's assumptions survive a reload.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { CurveSetInfo, LossSegment } from "../api/industryLoss";

/** Saffir-Simpson key. 0 = Tropical Storm; -1 = Tropical Depression. */
export type Sshws = -1 | 0 | 1 | 2 | 3 | 4 | 5;

export interface CategoryAssumption {
  mean: number;   // %
  sd: number;     // %
  /** Multiplicative bounds on mean loss for the calibrated holdout range. */
  lowFactor?: number;
  highFactor?: number;
}

export interface DamageAssumptionsState {
  byCategory: Record<Sshws, CategoryAssumption>;
  /** custom = the numbers below. Otherwise a Form V-1 vendor curve. */
  model: DamageModel;
  set: (cat: Sshws, partial: Partial<CategoryAssumption>) => void;
  setModel: (model: DamageModel) => void;
  reset: () => void;
}

export type DamageModel = "custom" | "pcs" | "air" | "kcc" | "rms";
export type VendorModel = "air" | "kcc" | "rms";

/** The backend's default calibrated curve set, blended across segments by the
 *  industry book mix: insured DR at each land-wind band midpoint. */
export interface CalibratedCurve {
  id: string;
  label: string;
  bandMid: number[];   // land mph
  dr: number[];        // decimal 0..1
  windFactor: number;
  windExponent: number;
  windFloor: number;
  sigmaLogEvent: number;
  panelBand: {
    lowFactor: number;
    highFactor: number;
    cohortEvents: string[];
    cohortCovered: number;
    scorableEvents: number;
    allEventCoverage: number;
    suppliedEvents: number;
    basis: string;
  };
}

/** Florida Commission Form V-1 Part A, building damage / building exposure.
 *  1-minute sustained mph. Unmitigated reference structures (wood, masonry,
 *  manufactured, concrete), surge off. AIR 2019, KCC 2023, RMS 21.0. */
export const FORM_V1: readonly {
  lo: number;
  hi: number;
  air: number;
  kcc: number;
  rms: number;
}[] = [
  { lo: 41, hi: 50, air: 0.05, kcc: 0.11, rms: 0.13 },
  { lo: 51, hi: 60, air: 0.12, kcc: 0.26, rms: 0.33 },
  { lo: 61, hi: 70, air: 0.46, kcc: 0.73, rms: 1.43 },
  { lo: 71, hi: 80, air: 0.96, kcc: 1.68, rms: 3.22 },
  { lo: 81, hi: 90, air: 1.89, kcc: 3.79, rms: 6.97 },
  { lo: 91, hi: 100, air: 3.55, kcc: 7.66, rms: 14.7 },
  { lo: 101, hi: 110, air: 7.34, kcc: 14.6, rms: 25.4 },
  { lo: 111, hi: 120, air: 20.6, kcc: 26.1, rms: 44.6 },
  { lo: 121, hi: 130, air: 32.8, kcc: 32.6, rms: 57.5 },
  { lo: 131, hi: 140, air: 42.1, kcc: 43.5, rms: 76.6 },
  { lo: 141, hi: 150, air: 54.2, kcc: 52.4, rms: 85.5 },
  { lo: 151, hi: 160, air: 61.8, kcc: 60.8, rms: 90.0 },
  { lo: 161, hi: 170, air: 71.7, kcc: 72.1, rms: 93.9 },
];

const KT_TO_MPH = 1.15078;

export const DAMAGE_MODEL_LABEL: Record<DamageModel, string> = {
  custom: "Custom",
  pcs: "PCS-calibrated",
  air: "AIR",
  kcc: "KCC",
  rms: "RMS",
};

// Trained on 15 PCS county-estimate events (Irma 2017 to Milton 2024) against
// the supplied industry TIV, on the same wind bands this panel receives:
// mockdata/damage_assumptions/sshws_calibrated.json, built by
// backend/scripts/train_category_damage.py --no-ts-field --fix-ts 0.04.
// Insured basis (PCS: after deductibles, private flood in, NFIP out), so they
// apply to TIV, not ground-up. The categories are this app's modelled marine
// wind, which runs hot over land, so they sit below textbook ground-up curves.
// SD is the lognormal SD from leave-one-storm-out error on a storm's summed loss.
// ASSUMPTION: TS is held at the tropical-storm-field fit (2,706 counties);
// Cat 5 has no data and keeps the KCC shape scaled by the Cat 4 fit.
export const DEFAULTS: Record<Sshws, CategoryAssumption> = {
  [-1]: { mean: 0.0, sd: 0.0 },     // TD
  [0]:  { mean: 0.04, sd: 0.06 },   // TS
  [1]:  { mean: 1.0, sd: 1.4 },     // Cat 1
  [2]:  { mean: 1.4, sd: 1.6 },     // Cat 2
  [3]:  { mean: 3.3, sd: 2.5 },     // Cat 3
  [4]:  { mean: 14.6, sd: 9.5 },    // Cat 4
  [5]:  { mean: 28.2, sd: 18.3 },   // Cat 5
};

// The hand-set starting values before calibration. A stored table still equal
// to these was never edited, so it moves to the trained defaults.
const PRE_CALIBRATION_DEFAULTS: Record<Sshws, CategoryAssumption> = {
  [-1]: { mean: 0.0, sd: 0.0 },
  [0]:  { mean: 0.5, sd: 0.3 },
  [1]:  { mean: 1.5, sd: 1.0 },
  [2]:  { mean: 4.5, sd: 2.0 },
  [3]:  { mean: 10.0, sd: 4.0 },
  [4]:  { mean: 22.0, sd: 7.0 },
  [5]:  { mean: 40.0, sd: 12.0 },
};

function sameTable(
  a: Partial<Record<Sshws, CategoryAssumption>> | undefined,
  b: Record<Sshws, CategoryAssumption>,
): boolean {
  if (!a) return false;
  return (Object.keys(b) as unknown as Sshws[]).every(
    (k) => a[k]?.mean === b[k].mean && a[k]?.sd === b[k].sd,
  );
}

export function migrateDamageAssumptions(
  persisted: unknown,
  version: number,
): Pick<DamageAssumptionsState, "byCategory" | "model"> {
  const state = (persisted ?? {}) as Partial<DamageAssumptionsState>;
  const byCategory = state.byCategory;
  const model = state.model ?? "custom";
  if (version < 1 && (!byCategory || sameTable(byCategory, PRE_CALIBRATION_DEFAULTS))) {
    return { byCategory: { ...DEFAULTS }, model };
  }
  return { byCategory: { ...DEFAULTS, ...(byCategory ?? {}) }, model };
}

export const useDamageAssumptionsStore = create<DamageAssumptionsState>()(
  persist(
    (set) => ({
      byCategory: { ...DEFAULTS },
      model: "custom",
      set: (cat, partial) =>
        set((state) => ({
          byCategory: {
            ...state.byCategory,
            [cat]: { ...state.byCategory[cat], ...partial },
          },
        })),
      setModel: (model) => set({ model }),
      reset: () => set({ byCategory: { ...DEFAULTS }, model: "custom" }),
    }),
    {
      name: "ee-damage-assumptions",
      version: 1,
      // persist merges the returned fields over the live store (actions included).
      migrate: (persisted, version) =>
        migrateDamageAssumptions(persisted, version) as DamageAssumptionsState,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

// ─────────────────────────── pure-function helpers ───────────────────────────

/** Map sustained wind (kt) → Saffir-Simpson category key. */
export function categoryForWind(windKt: number): Sshws {
  if (windKt >= 137) return 5;
  if (windKt >= 113) return 4;
  if (windKt >= 96) return 3;
  if (windKt >= 83) return 2;
  if (windKt >= 64) return 1;
  if (windKt >= 34) return 0;
  return -1;
}

export interface SpeedBin {
  mphLo: number;
  mphHi: number;
  category: number;
  areaFraction: number;
  maxWindKt?: number;
}

const REF_MARINE_MPH = 64 * KT_TO_MPH;
const ZERO_DAMAGE_MPH = 39;

/** Same transform as backend damage_curves.land_mph. */
export function calibratedLandMph(curve: CalibratedCurve, marineMph: number): number {
  if (marineMph <= 0) return 0;
  const shape = curve.windExponent ? (marineMph / REF_MARINE_MPH) ** curve.windExponent : 1;
  return curve.windFactor * marineMph * Math.max(curve.windFloor, shape);
}

/** Insured DR (%) at one marine wind speed, linear between band midpoints. */
export function calibratedPercent(curve: CalibratedCurve, marineMph: number): number {
  const mph = calibratedLandMph(curve, marineMph);
  const mids = curve.bandMid;
  if (mph <= ZERO_DAMAGE_MPH || mids.length === 0) return 0;
  if (mph <= mids[0]) return (100 * curve.dr[0] * (mph - ZERO_DAMAGE_MPH)) / (mids[0] - ZERO_DAMAGE_MPH);
  for (let i = 0; i < mids.length - 1; i++) {
    if (mph <= mids[i + 1]) {
      const t = (mph - mids[i]) / (mids[i + 1] - mids[i]);
      return 100 * (curve.dr[i] * (1 - t) + curve.dr[i + 1] * t);
    }
  }
  return 100 * curve.dr[mids.length - 1];
}

// ASSUMPTION: the supplied industry book's TIV mix, used when a curve file
// predates the bookMix field.
const DEFAULT_BOOK_MIX: Record<LossSegment, number> = {
  RESIDENTIAL: 0.478,
  COMMERCIAL: 0.491,
  AUTO: 0.031,
};

/** Collapse a calibrated curve set to one curve, weighting each segment by
 *  its share of the industry book. Null for vendor sets. */
export function blendCalibratedCurve(set: CurveSetInfo | null | undefined): CalibratedCurve | null {
  if (!set || set.kind !== "calibrated") return null;
  const mix = set.fit?.bookMix ?? DEFAULT_BOOK_MIX;
  const segs = (Object.keys(set.segments) as LossSegment[]).filter(
    (s) => (set.segments[s]?.length ?? 0) === set.bandsMphLo.length && (mix[s] ?? 0) > 0,
  );
  const total = segs.reduce((s, seg) => s + (mix[seg] ?? 0), 0);
  if (total <= 0) return null;
  const dr = set.bandsMphLo.map((_, b) =>
    segs.reduce((s, seg) => s + ((mix[seg] ?? 0) / total) * set.segments[seg]![b], 0),
  );
  return {
    id: set.id,
    label: set.label,
    bandMid: set.bandsMphLo.map((lo) => lo + 4.5),
    dr,
    windFactor: set.windFactor,
    windExponent: set.windExponent ?? 0,
    windFloor: set.windFloor ?? 0,
    sigmaLogEvent: set.sigmaLogEvent,
    panelBand: set.fit?.panelBand ?? {
      // Backward-compatible fallback for an older calibrated set. The shipped
      // set carries empirical factors, so production does not use this path.
      lowFactor: Math.exp(-Math.min(set.sigmaLogEvent, 0.5)),
      highFactor: Math.exp(Math.min(set.sigmaLogEvent, 0.5)),
      cohortEvents: [],
      cohortCovered: 0,
      scorableEvents: 0,
      allEventCoverage: 0,
      suppliedEvents: 0,
      basis: "fallback log-error range",
    },
  };
}

/** Asymmetric DR range from held-out wind-dominant major events. */
export function calibratedRange(
  curve: CalibratedCurve,
  meanPct: number,
): { low: number; high: number } {
  return {
    low: meanPct * curve.panelBand.lowFactor,
    high: Math.min(100, meanPct * curve.panelBand.highFactor),
  };
}

const CATEGORY_KT: Record<number, [number, number]> = {
  0: [34, 63], 1: [64, 82], 2: [83, 95], 3: [96, 112], 4: [113, 136], 5: [137, 160],
};

function calibratedCategoryMean(curve: CalibratedCurve, cat: Sshws): number {
  const range = CATEGORY_KT[cat];
  if (!range) return 0;
  const [lo, hi] = range;
  let sum = 0;
  for (let k = 0; k <= 20; k++) sum += calibratedPercent(curve, (lo + ((hi - lo) * k) / 20) * KT_TO_MPH);
  return sum / 21;
}

/** Damage ratio (%) from a Form V-1 row. Below 41 mph the table is silent. */
export function formV1Percent(model: VendorModel, mphLo: number): number {
  if (mphLo < 41) return 0;
  const row = FORM_V1.find((r) => r.lo === mphLo) ?? (mphLo > 161 ? FORM_V1[FORM_V1.length - 1] : undefined);
  return row ? row[model] : 0;
}

/** Unweighted mean of the Form V-1 rows whose midpoint sits in this category.
 *  The county loss uses the county's own mix, not this average. */
export function categoryCurveMean(model: DamageModel, cat: Sshws, curve?: CalibratedCurve | null): number {
  if (model === "custom") return 0;
  if (model === "pcs") return curve ? calibratedCategoryMean(curve, cat) : 0;
  const rows = FORM_V1.filter(
    (r) => categoryForWind(Math.round(((r.lo + r.hi) / 2) / KT_TO_MPH)) === cat,
  );
  if (rows.length === 0) return 0;
  return rows.reduce((s, r) => s + r[model], 0) / rows.length;
}

/**
 * Means the loss should use. Custom keeps the typed numbers. A vendor curve
 * uses the 10 mph mix inside each category when the impact sent speed bins,
 * otherwise the category average of the published table. SD stays the user's.
 * PCS-calibrated does the same with the backend's calibrated curve and applies
 * its empirical full-event holdout factors; without the curve it falls back
 * to the typed numbers.
 */
export function effectiveAssumptions(
  model: DamageModel | undefined,
  byCategory: Record<Sshws, CategoryAssumption>,
  speedBins?: SpeedBin[] | null,
  curve?: CalibratedCurve | null,
): Record<Sshws, CategoryAssumption> {
  if (!model || model === "custom") return byCategory;
  if (model === "pcs") {
    if (!curve) return byCategory;
    const out: Record<Sshws, CategoryAssumption> = { ...byCategory };
    for (const cat of CATEGORY_ORDER) {
      const mine = (speedBins ?? []).filter((b) => b.category === cat && b.areaFraction > 0);
      const weight = mine.reduce((s, b) => s + b.areaFraction, 0);
      const mean = weight > 0
        ? mine.reduce((s, b) => s + b.areaFraction * calibratedPercent(curve, b.mphLo + 4.5), 0) / weight
        : calibratedCategoryMean(curve, cat);
      out[cat] = {
        mean,
        sd: 0,
        lowFactor: curve.panelBand.lowFactor,
        highFactor: curve.panelBand.highFactor,
      };
    }
    return out;
  }
  const vendor: VendorModel = model;
  const out: Record<Sshws, CategoryAssumption> = { ...byCategory };
  for (const cat of CATEGORY_ORDER) {
    const mine = (speedBins ?? []).filter((b) => b.category === cat && b.areaFraction > 0);
    const weight = mine.reduce((s, b) => s + b.areaFraction, 0);
    const mean = weight > 0
      ? mine.reduce((s, b) => s + b.areaFraction * formV1Percent(vendor, b.mphLo), 0) / weight
      : categoryCurveMean(vendor, cat);
    out[cat] = { mean, sd: byCategory[cat]?.sd ?? 0 };
  }
  return out;
}

export interface LossBand {
  mean: number;
  low: number;
  high: number;
  drMean: number;   // decimal 0..1
  drSd: number;     // decimal 0..1
  bandKind: "symmetric-sd" | "holdout-range";
}

/** Apply the user's assumptions to one (TIV, max wind) → loss band. */
export function applyAssumption(
  tiv: number,
  windKt: number,
  byCategory: Record<Sshws, CategoryAssumption>,
): LossBand {
  const cat = categoryForWind(windKt);
  return applyCategory(tiv, cat, byCategory);
}

/** Same band, but the category is already known (a county wind slice). */
export function applyCategory(
  tiv: number,
  category: number,
  byCategory: Record<Sshws, CategoryAssumption>,
): LossBand {
  const a = byCategory[category as Sshws] ?? { mean: 0, sd: 0 };
  const drMean = Math.max(0, Math.min(1, a.mean / 100));
  const drSd = Math.max(0, a.sd / 100);
  const meanLoss = tiv * drMean;
  const calibrated = a.lowFactor != null && a.highFactor != null;
  const low = calibrated
    ? meanLoss * Math.max(0, a.lowFactor!)
    : tiv * Math.max(0, drMean - drSd);
  const high = calibrated
    ? Math.min(tiv, meanLoss * Math.max(0, a.highFactor!))
    : tiv * Math.min(1, drMean + drSd);
  return {
    mean: meanLoss,
    low,
    high,
    drMean,
    drSd,
    bandKind: calibrated ? "holdout-range" : "symmetric-sd",
  };
}

export interface WindSlice {
  category: number;
  areaFraction: number;
  maxWindKt?: number;
}

/**
 * Apply an underwriter's slice percents. Categories they did not touch keep
 * the model share. Anything left over is clear (not in the storm). If the
 * edited slices add up to more than the county, they are scaled down.
 */
export function resolveBandFractions<T extends WindSlice>(
  bands: T[] | undefined,
  bandPercent?: Partial<Record<string, number>> | null,
): T[] {
  const model = bands ?? [];
  if (!bandPercent || Object.keys(bandPercent).length === 0) return model;
  const cats = new Set<number>();
  for (const band of model) {
    if (band.category !== -1) cats.add(band.category);
  }
  for (const key of Object.keys(bandPercent)) {
    const cat = Number(key);
    if (cat !== -1 && Number.isFinite(cat)) cats.add(cat);
  }
  const raw: T[] = [];
  for (const cat of cats) {
    const modelBand = model.find((b) => b.category === cat);
    const pct = bandPercent[String(cat)];
    const frac = pct == null
      ? (modelBand?.areaFraction ?? 0)
      : Math.max(0, Math.min(100, pct)) / 100;
    raw.push({
      ...(modelBand ?? { category: cat, areaFraction: 0 }),
      category: cat,
      areaFraction: frac,
    } as T);
  }
  let sum = raw.reduce((s, b) => s + b.areaFraction, 0);
  const clearPct = bandPercent["-1"];
  let clear = clearPct == null ? 0 : Math.max(0, Math.min(100, clearPct)) / 100;
  if (clearPct != null && sum + clear > 1 && sum > 0) {
    const room = Math.max(0, 1 - clear);
    for (const band of raw) band.areaFraction *= room / sum;
    sum = room;
  } else if (sum > 1) {
    for (const band of raw) band.areaFraction /= sum;
    sum = 1;
    clear = 0;
  }
  const clearFrac = clearPct == null ? Math.max(0, 1 - sum) : clear;
  const out = raw.filter(
    (b) => b.areaFraction > 0.0005 || bandPercent?.[String(b.category)] != null,
  );
  if (clearFrac > 0.0005) {
    const modelClear = model.find((b) => b.category === -1);
    out.push({
      ...(modelClear ?? { category: -1, areaFraction: 0 }),
      category: -1,
      areaFraction: clearFrac,
    } as T);
  }
  return out;
}

/** The slice that covers the most of the county. Not the hottest point. */
export function representativeBand<T extends WindSlice>(bands: T[] | undefined): T | null {
  const live = (bands ?? []).filter((b) => b.category >= 0 && b.areaFraction >= 0.005);
  if (live.length === 0) return null;
  return live.reduce((best, band) => (band.areaFraction > best.areaFraction ? band : best));
}

/**
 * Loss for a county split by local wind. Each slice uses that category's
 * damage ratio. ``exposedFraction`` is an extra judgment scale on top of
 * the area split (1 = take the slices as they are). When the API didn't
 * send bands, fall back to one ratio on the whole county.
 *
 * ``drMean`` / ``drSd`` are on the full county TIV, so a county that is
 * 90% untouched shows a small effective ratio, not the eyewall ratio.
 */
export function applyWindBands(
  tiv: number,
  bands: WindSlice[] | undefined,
  exposedFraction: number,
  byCategory: Record<Sshws, CategoryAssumption>,
  fallbackWindKt: number,
  bandPercent?: Partial<Record<string, number>> | null,
): LossBand {
  const scale = Math.max(0, Math.min(1, exposedFraction));
  const resolved = resolveBandFractions(bands, bandPercent);
  const live = resolved.filter((b) => b.category >= 0 && b.areaFraction > 0);
  if (live.length === 0) {
    return applyAssumption(tiv * scale, fallbackWindKt, byCategory);
  }
  let mean = 0;
  let low = 0;
  let high = 0;
  let bandKind: LossBand["bandKind"] = "symmetric-sd";
  for (const band of live) {
    const slice = applyCategory(tiv * band.areaFraction * scale, band.category, byCategory);
    mean += slice.mean;
    low += slice.low;
    high += slice.high;
    if (slice.bandKind === "holdout-range") bandKind = "holdout-range";
  }
  const base = tiv * scale;
  return {
    mean,
    low,
    high,
    drMean: base > 0 ? mean / base : 0,
    drSd: base > 0 ? Math.max(0, (high - mean) / base) : 0,
    bandKind,
  };
}

export const CATEGORY_LABELS: Record<Sshws, string> = {
  [-1]: "TD",
  [0]: "TS",
  [1]: "Cat 1",
  [2]: "Cat 2",
  [3]: "Cat 3",
  [4]: "Cat 4",
  [5]: "Cat 5",
};

export const CATEGORY_ORDER: Sshws[] = [0, 1, 2, 3, 4, 5];
