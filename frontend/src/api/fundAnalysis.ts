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

export interface OptimizeRequest {
  assetIds: string[];
  newCapital: number;
  currentInvestments: CurrentInvestmentIn[];
  noSell: boolean;
  historyWindowStart: string | null;
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
  annualisedVol: number;
  sharpe: number;
  sortino: number;
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
  overrides: AssumptionOverrideIn[];
  minInvestmentOverrides: MinInvestmentOverrideIn[];
}

export interface CustomPortfolioResponse {
  portfolio: PortfolioPoint;
  equityMonths: string[];
  equity: number[];
  drawdown: number[];
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
}

export interface OptimizeResponse {
  stats: AssetStat[];
  correlation: Record<string, Record<string, number>>;
  overlapMonths: Record<string, Record<string, number>>;
  frontier: PortfolioPoint[];
  maxSharpe: PortfolioPoint;
  maxSortino: PortfolioPoint;
  minVariance: PortfolioPoint;
  minDrawdown: PortfolioPoint;
  totalCapital: number;
  newCapital: number;
  currentTotal: number;
  currentInvestments: Record<string, number>;
  riskFreeRate: number;
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
