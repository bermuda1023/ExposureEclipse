/** Fund-analysis endpoints — portfolio optimization. */

import { apiGet, apiPost } from "./client";

export type AssetKind = "hedge_fund" | "reference";

export interface FundAsset {
  id: string;
  name: string;
  kind: AssetKind;
  strategy: string;
  manager: string;
  minInvestment: number;
  aumMillions: number | null;
  fees: string;
  lockup: string;
  inception: string;
  nMonths: number;
  annualisedReturn: number;
  annualisedVol: number;
  source: string;
  warning: string | null;
}

export interface AssetsResponse {
  asOf: string;
  note: string;
  assets: FundAsset[];
}

export interface AssumptionOverrideIn {
  assetId: string;
  annualisedReturn?: number | null;
  annualisedVol?: number | null;
  correlationCap?: number | null;
}

export interface MaxWeightIn {
  assetId: string;
  maxWeight: number;
}

export interface MinInvestmentOverrideIn {
  assetId: string;
  minInvestment: number;
}

export interface CurrentInvestmentIn {
  assetId: string;
  amount: number;
}

export interface PerAssetBenchmarkIn {
  assetId: string;
  benchmarkAssetId: string;
}

export interface OptimizeRequest {
  assetIds: string[];
  newCapital: number;
  currentInvestments: CurrentInvestmentIn[];
  noSell: boolean;
  /** Default true: only deploy new capital; keep current holdings fixed. */
  allocateNewCapitalOnly: boolean;
  /** Default true: haircut expected returns by mgmt fee. */
  netOfFees: boolean;
  historyWindowStart: string | null;
  benchmarkAssetId: string;
  perAssetBenchmarks: PerAssetBenchmarkIn[];
  riskFreeRate: number;
  respectMinInvestment: boolean;
  overrides: AssumptionOverrideIn[];
  maxWeights: MaxWeightIn[];
  minInvestmentOverrides: MinInvestmentOverrideIn[];
  samples: number;
}

export interface PortfolioPoint {
  weights: Record<string, number>;
  annualisedReturn: number;
  expectedReturn?: number;
  annualisedVol: number;
  sharpe: number;
  sortino: number;
  informationRatio: number;
  trackingError: number;
  maxDrawdown: number;
  violatesMinInvestment: string[];
}

export interface AssetSeries {
  assetId: string;
  months: string[];
  returns: number[];
  equity: number[];
  drawdown: number[];
  maxDrawdown: number;
}

export interface CustomPortfolioRequest {
  weights: Record<string, number>;
  riskFreeRate: number;
  totalCapital: number;
  respectMinInvestment: boolean;
  historyWindowStart: string | null;
  benchmarkAssetId?: string;
  netOfFees?: boolean;
  overrides: AssumptionOverrideIn[];
  minInvestmentOverrides: MinInvestmentOverrideIn[];
}

export interface CustomPortfolioResponse {
  portfolio: PortfolioPoint;
  equityMonths: string[];
  equity: number[];
  drawdown: number[];
  benchMonths: string[];
  benchEquity: number[];
  benchDrawdown: number[];
  benchMaxDrawdown: number;
  benchName: string;
}

export interface AssetStat {
  assetId: string;
  nMonths: number;
  annualisedReturn: number;
  annualisedVol: number;
  minMonth: string;
  maxMonth: string;
  empiricalReturn: number;
  empiricalVol: number;
  isOverridden: boolean;
  informationRatio: number;
  trackingError: number;
  benchmarkAssetId: string;
  benchmarkName: string;
}

export interface OptimizeResponse {
  stats: AssetStat[];
  correlation: Record<string, Record<string, number>>;
  overlapMonths: Record<string, Record<string, number>>;
  frontier: PortfolioPoint[];
  maxSharpe: PortfolioPoint;
  maxSortino: PortfolioPoint;
  maxInformationRatio: PortfolioPoint;
  minVariance: PortfolioPoint;
  minDrawdown: PortfolioPoint;
  totalCapital: number;
  newCapital: number;
  currentTotal: number;
  currentInvestments: Record<string, number>;
  riskFreeRate: number;
  benchmarkAssetId: string;
  benchmarkName: string;
  assetSeries: AssetSeries[];
  historyWindowStart: string | null;
  effectiveWindowMonths: number;
}

export const fetchFundAssets = () =>
  apiGet<AssetsResponse>("/fund-analysis/assets");

export const optimizePortfolio = (req: OptimizeRequest) =>
  apiPost<OptimizeResponse>("/fund-analysis/optimize", req);

export const scoreCustomPortfolio = (req: CustomPortfolioRequest) =>
  apiPost<CustomPortfolioResponse>("/fund-analysis/custom", req);

export interface RescoreIrRequest {
  assetIds: string[];
  perAssetBenchmarks: PerAssetBenchmarkIn[];
  defaultBenchmarkAssetId: string;
  historyWindowStart: string | null;
}

export interface RescoreIrRow {
  assetId: string;
  informationRatio: number;
  trackingError: number;
  benchmarkAssetId: string;
  benchmarkName: string;
}

export interface RescoreIrResponse {
  rows: RescoreIrRow[];
}

export const rescoreIr = (req: RescoreIrRequest) =>
  apiPost<RescoreIrResponse>("/fund-analysis/rescore-ir", req);

export interface RobustnessRequest {
  assetIds: string[];
  currentInvestments: CurrentInvestmentIn[];
  respectMinInvestment: boolean;
  noSell: boolean;
  allocateNewCapitalOnly?: boolean;
  netOfFees?: boolean;
  overrides: AssumptionOverrideIn[];
  maxWeights: MaxWeightIn[];
  minInvestmentOverrides: MinInvestmentOverrideIn[];
  /** New dollars to deploy (added to current holdings). */
  newCapital: number;
  samplesPerScenario: number;
}

export interface RobustnessRow {
  assetId: string;
  selectionFrequency: number;
  medianWeight: number;
  medianWeightWhenSelected: number;
  maxWeight: number;
  scenariosSelected: string[];
  totalScenarios: number;
  classification: "core" | "situational" | "peripheral";
}

export interface RobustnessResponse {
  rows: RobustnessRow[];
  totalScenarios: number;
  scenarioLabels: string[];
}

export const runRobustnessScan = (req: RobustnessRequest) =>
  apiPost<RobustnessResponse>("/fund-analysis/robustness", req);

export interface RollingStatsRequest {
  assetId: string;
  benchmarkAssetId: string;
  windowMonths: number;
  historyWindowStart: string | null;
  riskFreeRate: number;
}

export interface RollingWindow {
  endMonth: string;
  cagr: number;
  vol: number;
  sharpe: number;
  correlation: number;
  informationRatio: number;
}

export interface DriftFlag {
  metric: string;
  firstHalf: number;
  secondHalf: number;
  change: number;
  severity: "minor" | "notable" | "significant";
  interpretation: string;
}

export interface RollingStatsResponse {
  assetId: string;
  benchmarkAssetId: string;
  benchmarkName: string;
  windowMonths: number;
  nMonthsTotal: number;
  windows: RollingWindow[];
  driftFlags: DriftFlag[];
  dataAdequacy: "unreliable" | "sparse" | "decent" | "strong";
  dataAdequacyMessage: string;
  fullPeriodCagr: number;
  fullPeriodVol: number;
  fullPeriodSharpe: number;
  firstHalfCagr: number;
  firstHalfVol: number;
  firstHalfSharpe: number;
  secondHalfCagr: number;
  secondHalfVol: number;
  secondHalfSharpe: number;
  benchFullCagr: number;
  benchFirstHalfCagr: number;
  benchSecondHalfCagr: number;
  alphaFull: number;
  alphaFirstHalf: number;
  alphaSecondHalf: number;
  trendSlopeCagr: number;
  trendSlopeVol: number;
  trendSlopeSharpe: number;
  splitMonth: string;
  splitNearCrisis: boolean;
  splitCrisisNote: string;
  firstHalfStart: string;
  firstHalfEnd: string;
  secondHalfStart: string;
  secondHalfEnd: string;
}

export const fetchRollingStats = (req: RollingStatsRequest) =>
  apiPost<RollingStatsResponse>("/fund-analysis/rolling-stats", req);
