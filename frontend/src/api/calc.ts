/** Layer-loss (XOL) scenario calc — POST /api/calc/layers. */

import { apiPost } from "./client";

export interface LayerTermsIn {
  deductible: number;
  limit: number;
  share?: number;
  name?: string;
}

export interface ScenarioIn {
  grossLoss?: number;
  tiv?: number;
  damageRatio?: number;
  label?: string;
}

export interface LayerOutcome {
  name: string | null;
  deductible: number;
  limit: number;
  share: number;
  lossToLayer: number;
  cededLoss: number;
  exhausted: boolean;
}

export interface ScenarioResult {
  label: string | null;
  tiv: number | null;
  damageRatio: number | null;
  groundUpLoss: number;
  layers: LayerOutcome[];
  totalCeded: number;
  cedentNetLoss: number;
}

export interface LayerCalcResponse {
  scenarios: ScenarioResult[];
}

export const runLayerCalc = (body: {
  layers: LayerTermsIn[];
  scenarios?: ScenarioIn[];
  sweepTiv?: number;
}) => apiPost<LayerCalcResponse>("/calc/layers", body);
