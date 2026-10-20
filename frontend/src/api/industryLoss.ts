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
  windExponent?: number;
  windFloor?: number;
  deductible: Partial<Record<LossSegment, number>>;
  sigmaLogCounty: number;
  sigmaLogEvent: number;
  createdAt: string | null;
  fit?: {
    bookMix?: Partial<Record<LossSegment, number>>;
    panelBand?: PanelBand;
    eventRules?: Partial<Record<EventExclusionReason, { reason: string } & Record<string, unknown>>>;
    eventSet?: CalibrationEvent[];
  } | null;
}

/** Rule that keeps a supplied PCS event out of calibration (mockdata/industry_losses/event_set.json). */
export type EventExclusionReason = "noExposure" | "stalled" | "outsideFootprint";

export interface CalibrationEvent {
  stormId: string;
  name: string;
  year: number;
  included: boolean;
  reasons: EventExclusionReason[];
  mechanism: string;
  metrics: {
    pcsLoss: number;
    noTivShare: number | null;
    outsideFootprintShare: number | null;
    stallHours: number | null;
  };
}

export interface PanelBandEvent {
  stormId: string;
  name: string;
  /** True for training events (factor is held out); false for excluded events scored on the final curve. */
  trained: boolean;
  reasons: EventExclusionReason[];
  actual: number;
  model: number;
  factor: number | null;
  withinRange: boolean;
}

export interface PanelBand {
  lowFactor: number;
  highFactor: number;
  coverageTarget?: number;
  coveredEvents: number;
  scorableEvents: number;
  suppliedEvents: number;
  outsideEvents: string[];
  appliesTo?: string;
  basis: string;
  events?: PanelBandEvent[];
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
  /** Present when the source was supplied in another currency and converted on import. */
  fx?: {
    reportedCurrency: string;
    /** Units of the actuals currency per one unit of reportedCurrency. */
    fxRate: number;
    fxDate: string | null;
    fxSource: string | null;
    reportedTotal: number;
  } | null;
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
  if (a.fx) {
    parts.push(
      `from ${a.fx.reportedCurrency} at ${a.fx.fxRate}${a.fx.fxDate ? ` (${a.fx.fxDate})` : ""}`,
    );
  }
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
  claims: number | null;
  /** Under the materiality cut: scored as an upper bound, not an exact DR. */
  belowMateriality: boolean;
  evidence: CountyEvidence | null;
}

/** Observed post-event evidence for one county (ASOS, NCEI Storm Events, USGS HWMs). */
export interface CountyEvidence {
  asosMaxSustainedKt: number | null;
  asosMaxGustKt: number | null;
  /** Modelled land wind at the same stations, for a like-for-like read. */
  asosModelLandKt: number | null;
  tornadoes: number;
  maxEf: number | null;
  floodReports: number;
  surgeReports: number;
  windReports: number;
  hwmCount: number;
  hwmRiverine: number;
  hwmCoastal: number;
  hwmMaxHeightAboveGroundFt: number | null;
}

export type MissPeril = "tornado" | "flood" | "surge" | "wind" | "noEvidence";

export interface EventEvidenceSummary {
  builtAt: string | null;
  window: { start: string; end: string } | null;
  sources: Record<string, string | null>;
  windBias: {
    n: number;
    medianObsOverModel?: number;
    p25ObsOverModel?: number | null;
    p75ObsOverModel?: number | null;
    medianGustFactor?: number | null;
    medianObsOverModelAbove50Kt?: number | null;
    observedTsOutsideModel?: number;
  } | null;
  stormEventTotals: Record<string, { n: number; damage: number }> | null;
  currency: string;
  stations: number;
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
      countiesMaterial: number;
      countiesBelowMateriality: number;
      countiesAboveMaterialityCeiling: number;
      countyLogRms: number | null;
      countyLogMedian: number | null;
      shareOfActualInWindField: number | null;
    }
  >;
  counties: BacktestCountyRow[];
  unreportedCounties: Array<{ geographyId: string; name: string; state: string; modelled: number; maxWindKt: number }>;
  footprintMisses: Array<{
    geographyId: string;
    segment: LossSegment;
    actual: number;
    belowMateriality: boolean;
    evidencePeril: MissPeril | null;
  }>;
  footprintMissByPeril: Partial<Record<MissPeril, number>> | null;
  evidence: EventEvidenceSummary | null;
  materiality: { lossBelow: number; claimsBelow: number; currency: string };
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
