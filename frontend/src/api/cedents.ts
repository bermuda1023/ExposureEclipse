/**
 * Cedent / Chain / Programme wire types + fetchers.
 * Mirrors backend/app/models/cedent.py.
 */

import { apiGet } from "./client";
import type {
  AggregationLevel,
  CurrencyCode,
  ErtStatus,
  Peril,
} from "../types/contracts";

export interface EDMRef {
  serverName: string;
  edmDatabaseName: string;
  currency: CurrencyCode;
  ertStatus: ErtStatus;
  availableGranularity: AggregationLevel[];
  lastGeneratedAt?: string | null;
  exposureDataCutoffDate?: string | null;
}

export interface Programme {
  programmeId: string;
  chainId: string;
  cedentId: string;
  programmeName: string;
  treatyYear: number;
  /** Canonical list of perils carried by this programme's EDM. Drives the peril
   * multi-select's enable/disable state for the current selection. */
  perils: Peril[];
  /** Legacy single-peril label (defaults to ALL for multi-peril programmes). */
  peril: Peril;
  office: string;
  underwriter: string;
  status: string;
  layer?: string | null;
  signedShare?: number | null;
  inceptionDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
  datasetId: string;
  edm: EDMRef;
}

export interface ProgrammeChain {
  chainId: string;
  cedentId: string;
  chainName: string;
  office: string;
  defaultPeril: Peril;
  programmes: Programme[];
}

export interface Cedent {
  cedentId: string;
  cedentName: string;
  chains: ProgrammeChain[];
  notes?: string | null;
}

export interface CedentTreeResponse {
  cedents: Cedent[];
}

export const listCedents = () => apiGet<CedentTreeResponse>("/cedents");
