/**
 * User-input damage-ratio assumptions, by Saffir-Simpson category.
 *
 * The underwriter enters a mean damage ratio and a standard deviation per
 * category; the impact panel applies those to each county's TIV (and per-
 * programme TIV) to produce a projected loss + a low/high band:
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

/** Saffir-Simpson key. 0 = Tropical Storm; -1 = Tropical Depression. */
export type Sshws = -1 | 0 | 1 | 2 | 3 | 4 | 5;

export interface CategoryAssumption {
  mean: number;   // %
  sd: number;     // %
}

export interface DamageAssumptionsState {
  byCategory: Record<Sshws, CategoryAssumption>;
  set: (cat: Sshws, partial: Partial<CategoryAssumption>) => void;
  reset: () => void;
}

// Sensible starting values — order-of-magnitude industry shape so the panel
// has SOMETHING to show on first load. The user is expected to overwrite.
const DEFAULTS: Record<Sshws, CategoryAssumption> = {
  [-1]: { mean: 0.0, sd: 0.0 },     // TD
  [0]:  { mean: 0.5, sd: 0.3 },     // TS
  [1]:  { mean: 1.5, sd: 1.0 },     // Cat 1
  [2]:  { mean: 4.5, sd: 2.0 },     // Cat 2
  [3]:  { mean: 10.0, sd: 4.0 },    // Cat 3
  [4]:  { mean: 22.0, sd: 7.0 },    // Cat 4
  [5]:  { mean: 40.0, sd: 12.0 },   // Cat 5
};

export const useDamageAssumptionsStore = create<DamageAssumptionsState>()(
  persist(
    (set) => ({
      byCategory: { ...DEFAULTS },
      set: (cat, partial) =>
        set((state) => ({
          byCategory: {
            ...state.byCategory,
            [cat]: { ...state.byCategory[cat], ...partial },
          },
        })),
      reset: () => set({ byCategory: { ...DEFAULTS } }),
    }),
    {
      name: "ee-damage-assumptions",
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

export interface LossBand {
  mean: number;
  low: number;
  high: number;
  drMean: number;   // decimal 0..1
  drSd: number;     // decimal 0..1
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
  const low = tiv * Math.max(0, drMean - drSd);
  const high = tiv * Math.min(1, drMean + drSd);
  return { mean: meanLoss, low, high, drMean, drSd };
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
  for (const band of live) {
    const slice = applyCategory(tiv * band.areaFraction * scale, band.category, byCategory);
    mean += slice.mean;
    low += slice.low;
    high += slice.high;
  }
  const base = tiv * scale;
  return {
    mean,
    low,
    high,
    drMean: base > 0 ? mean / base : 0,
    drSd: base > 0 ? Math.max(0, (high - mean) / base) : 0,
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
