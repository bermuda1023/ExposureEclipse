import { apiGet, apiPost } from "./client";

export type LossSegment = "RESIDENTIAL" | "COMMERCIAL" | "AUTO";
export const LOSS_SEGMENTS: LossSegment[] = ["RESIDENTIAL", "COMMERCIAL", "AUTO"];

export interface LossBand {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface CurveSetInfo {
  id: string;
  label: string;
  kind: "vendor" | "calibrated";
  bandsMphLo: number[];
  segments: Partial<Record<LossSegment, number[]>>;
  windFactor: number;
  deductible: Partial<Record<LossSegment, number>>;
  sigmaLogCounty: number;
  sigmaLogEvent: number;
  createdAt: string | null;
}

export interface DamageCurvesResponse {
  defaultId: string;
  curveSets: CurveSetInfo[];
}

export interface TivSource {
  kind: "supplied" | "book";
  year: number | null;
  file: string | null;
  currency: string;
  asOfDate: string | null;
}

export interface ActualsBasis {
  total: number;
  bySegment: Record<LossSegment, number>;
  /** Reported loss not placed in any county (PCS "County Not Available"). */
  unallocated: number;
  claimsBySegment: Partial<Record<LossSegment, number>> | null;
  states: string[];
  asOfDate: string | null;
  source: string | null;
  includesFlood: boolean | null;
  includesSurge: boolean | null;
  includesNfip: boolean | null;
  includesLae: boolean | null;
  eventDate: string | null;
  /** Present when the reported loss was scaled to the TIV valuation date. */
  onLevel?: OnLevelInfo | null;
}

export interface OnLevelInfo {
  eventDate: string;
  targetDate: string;
  reportedTotal: number;
  reportedBySegment: Record<LossSegment, number>;
  factor: number | null;
  factorBySegment: Record<LossSegment, number | null>;
  rowsByQuantityLevel: Record<string, number>;
  adjustments: Array<{ stormId: string; geographyId: string; segment: string; factor: number; reason: string; lossEffect: number }>;
  indicesBuiltAt: string | null;
  latestMonth: string;
  method: string;
}

export function actualsBasisLabel(a: ActualsBasis): string {
  const parts: string[] = [];
  const flag = (value: boolean | null, label: string) => {
    if (value === true) parts.push(`incl. ${label}`);
    else if (value === false) parts.push(`excl. ${label}`);
  };
  flag(a.includesFlood, a.includesNfip === false ? "private flood" : "flood");
  flag(a.includesNfip, "NFIP");
  flag(a.includesLae, "LAE");
  return parts.join(" · ");
}

export interface IndustryLossResponse {
  stormId: string;
  stormName: string;
  year: number;
  trackSource: "ibtracs" | "live";
  currency: string;
  multiplier: number;
  curveSet: {
    id: string;
    label: string;
    kind: string;
    windFactor: number;
    deductible: Partial<Record<LossSegment, number>>;
    sigmaLogCounty: number;
    sigmaLogEvent: number;
  };
  tivSource: TivSource;
  formula: string;
  summary: {
    total: LossBand;
    bySegment: Record<LossSegment, LossBand & { tiv: number }>;
    countiesWithLoss: number;
  };
  actuals: ActualsBasis | null;
  counties: Array<
    LossBand & {
      geographyId: string;
      geoid: string;
      name: string;
      state: string;
      maxWindKt: number;
      exposedFraction: number;
      segments: Record<LossSegment, { tiv: number; loss: number; dr: number }>;
    }
  >;
  notes: string[];
}

export interface BacktestCountyRow {
  geographyId: string;
  name: string | null;
  state: string;
  segment: LossSegment;
  actual: number;
  modelled: number;
  tiv: number;
  modelledDr: number;
  impliedDr: number | null;
  maxWindKt: number | null;
  logError: number | null;
  inWindField: boolean;
}

export interface BacktestResponse {
  stormId: string;
  stormName: string;
  year: number;
  currency: string;
  curveSet: { id: string; label: string; kind: string };
  tivSource: TivSource;
  onLevel: OnLevelInfo | null;
  total: { actual: number; modelled: number; ratio: number | null; logError: number | null };
  segments: Record<
    LossSegment,
    {
      actual: number;
      modelled: number;
      ratio: number | null;
      logError: number | null;
      countiesScored: number;
      countyLogRms: number | null;
      countyLogMedian: number | null;
      shareOfActualInWindField: number | null;
    }
  >;
  counties: BacktestCountyRow[];
  unreportedCounties: Array<{ geographyId: string; name: string; state: string; modelled: number; maxWindKt: number }>;
  footprintMisses: Array<{ geographyId: string; segment: LossSegment; actual: number }>;
  exposureGaps: Array<{ geographyId: string; segment: LossSegment; actual: number }>;
  missingTivCounties: number;
}

export const fetchDamageCurves = () => apiGet<DamageCurvesResponse>("/damage-curves");

export const fetchIndustryLoss = (
  stormId: string,
  body: { curveSetId?: string | null; multiplier?: number; exposedFraction?: Record<string, number> },
) => apiPost<IndustryLossResponse>(`/hurricanes/${encodeURIComponent(stormId)}/industry-loss`, body);

export const fetchBacktest = (stormId: string, curveSetId?: string | null) =>
  apiGet<BacktestResponse>(
    `/industry-losses/${encodeURIComponent(stormId)}/backtest`,
    curveSetId ? { curveSetId } : undefined,
  );
