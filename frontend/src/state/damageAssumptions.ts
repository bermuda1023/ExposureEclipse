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
  const a = byCategory[cat] ?? { mean: 0, sd: 0 };
  const drMean = Math.max(0, Math.min(1, a.mean / 100));
  const drSd = Math.max(0, a.sd / 100);
  const meanLoss = tiv * drMean;
  const low = tiv * Math.max(0, drMean - drSd);
  const high = tiv * Math.min(1, drMean + drSd);
  return { mean: meanLoss, low, high, drMean, drSd };
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
