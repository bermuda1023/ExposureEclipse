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

export interface OptimizeRequest {
  assetIds: string[];
  totalCapital: number;
  riskFreeRate: number;
  respectMinInvestment: boolean;
  overrides: AssumptionOverrideIn[];
  samples: number;
}

export interface PortfolioPoint {
  weights: Record<string, number>;
  annualisedReturn: number;
  annualisedVol: number;
  sharpe: number;
  violatesMinInvestment: string[];
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
  minVariance: PortfolioPoint;
  totalCapital: number;
  riskFreeRate: number;
}

export const fetchFundAssets = () =>
  apiGet<AssetsResponse>("/fund-analysis/assets");

export const optimizePortfolio = (req: OptimizeRequest) =>
  apiPost<OptimizeResponse>("/fund-analysis/optimize", req);
