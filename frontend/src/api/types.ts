/**
 * Wire shapes for analytical endpoints. Mirrors backend Pydantic models
 * (camelCase JSON). Enums come from ../types/contracts (the CONTRACTS.md mirror).
 */

import type {
  AggregationLevel,
  CombinationMethod,
  CurrencyCode,
  ErtStatus,
  JobStatus,
  Measure,
  MetricKey,
  Peril,
  PortfolioScope,
  YoyStatus,
} from "../types/contracts";
import type { ApiWarning } from "./client";

/* ─── Datasets ─── */
export interface Dataset {
  datasetId: string;
  serverName: string;
  edmDatabaseName: string;
  treatyYear: number;
  currency: CurrencyCode;
  ertStatus: ErtStatus;
  availableGranularity: AggregationLevel[];
  isIncludedInPortfolio: boolean;
  lastGeneratedAt?: string | null;
  cedentName?: string | null;
  programmeName?: string | null;
  exposureDataCutoffDate?: string | null;
  priorExposureDataCutoffDate?: string | null;
}

export interface DatasetListResponse {
  datasets: Dataset[];
}

export interface ExpectedTableStatus {
  tableType: string;
  name: string;
  exists: boolean;
  rowCount: number;
}

export interface DatasetStatusResponse {
  datasetId: string;
  ertStatus: ErtStatus;
  tables: ExpectedTableStatus[];
  warnings: ApiWarning[];
}

/* ─── Dataset groups ─── */
export interface DatasetGroupMember {
  datasetId: string;
  peril: Peril;
}

export interface DatasetGroupCreate {
  groupName: string;
  currency: CurrencyCode;
  combinationMethod?: CombinationMethod;
  members: DatasetGroupMember[];
  cedentName?: string;
  programmeName?: string;
  yearOfAccount?: number;
  distinctSegmentsConfirmed?: boolean;
  notes?: string;
}

export interface DatasetGroupCreated {
  datasetGroupId: string;
  warnings: ApiWarning[];
}

export interface DatasetGroup {
  datasetGroupId: string;
  groupName: string;
  currency: CurrencyCode;
  combinationMethod: CombinationMethod;
  members: DatasetGroupMember[];
  distinctSegmentsConfirmed: boolean;
  createdAt: string;
  cedentName?: string | null;
  programmeName?: string | null;
  yearOfAccount?: number | null;
  notes?: string | null;
}

export interface DatasetGroupListResponse {
  datasetGroups: DatasetGroup[];
}

/* ─── Exposure filters ─── */
export interface ExposureFilters {
  peril: Peril;
  occupancy: string[];
  distanceToCoast: string[];
  geocoding: string[];
  construction: string[];
  numberOfStories: string[];
  yearBuilt: string[];
}

/* ─── Map ─── */
export interface MapRequest {
  // Pick exactly one. Programme = single year; chain auto-pairs latest+prior;
  // cedent unions all chains. datasetId/datasetGroupId remain as legacy escape hatches.
  programmeId?: string | null;
  chainId?: string | null;
  /** Multi-chain combination — used for office-level selection. */
  chainIds?: string[];
  cedentId?: string | null;
  datasetId?: string | null;
  datasetGroupId?: string | null;
  portfolioScope?: PortfolioScope;
  aggregationLevel: AggregationLevel;
  metric: MetricKey;
  filters?: Partial<ExposureFilters>;
  /** Override the chain's auto-prior with a specific programme. */
  comparisonProgrammeId?: string | null;
  comparisonDatasetId?: string | null;
  /** Top-of-page peril multi-select. Empty / contains "ALL" → no filter. */
  perils?: Peril[];
  currencyAssumption?: Record<string, number> | null;
  /** When true, color by YoY change of the selected metric. */
  yoyMode?: boolean;
}

export interface MapFeature {
  geographyId: string;
  geographyName?: string | null;
  metricValue: number | null;
  /** Prior-period value of the selected metric (when a comparison dataset is set). */
  priorMetricValue?: number | null;
  tiv: number | null;
  locationCount: number | null;
  dealShareOfPortfolioInGeography: number | null;
  geographyShareOfTotalPortfolio: number | null;
  selectedDealGeographyConcentration: number | null;
  clientMarketShare: number | null;
  yoyChange: number | null;
  yoyStatus: YoyStatus | null;
  hasGeometry: boolean;
  warnings: ApiWarning[];
}

export interface MapResponse {
  aggregationLevel: AggregationLevel;
  metric: MetricKey;
  currency: CurrencyCode;
  features: MapFeature[];
  warnings: ApiWarning[];
}

/* ─── Detail ─── */
export interface DetailRequest extends MapRequest {
  geographyId: string;
}

export interface DetailSummary {
  tiv: number | null;
  locationCount: number | null;
  dealShareOfPortfolioInGeography: number | null;
  geographyShareOfTotalPortfolio: number | null;
  selectedDealGeographyConcentration: number | null;
  clientMarketShare: number | null;
  yoyChange: number | null;
  yoyStatus: YoyStatus | null;
}

export interface BreakdownRow {
  key: string;
  tiv: number;
  locationCount: number;
}

export interface DetailResponse {
  geographyId: string;
  geographyName?: string | null;
  aggregationLevel: AggregationLevel;
  currency: CurrencyCode;
  summary: DetailSummary;
  dealVsPortfolio: { dealTiv: number; portfolioTiv: number };
  marketShare: {
    clientTiv: number | null;
    industryTiv: number | null;
    share: number | null;
    segment: string;
  };
  yoy: {
    currentTiv: number | null;
    priorTiv: number | null;
    change: number | null;
    status: YoyStatus;
  };
  breakdowns: {
    peril: BreakdownRow[];
    occupancy: BreakdownRow[];
    distanceToCoast: BreakdownRow[];
    geocoding: BreakdownRow[];
    stories: BreakdownRow[];
    construction: BreakdownRow[];
  };
  activeFilters: Record<string, unknown>;
  warnings: ApiWarning[];
}

/* ─── Pivot ─── */
export interface PivotRequest {
  programmeId?: string | null;
  chainId?: string | null;
  chainIds?: string[];
  cedentId?: string | null;
  datasetId?: string | null;
  datasetGroupId?: string | null;
  portfolioScope?: PortfolioScope;
  rows: string[];
  columns: string[];
  measures: Measure[];
  filters?: Partial<ExposureFilters>;
  comparisonProgrammeId?: string | null;
  comparisonDatasetId?: string | null;
  combinationMethod?: CombinationMethod | null;
  perils?: Peril[];
  currencyAssumption?: Record<string, number> | null;
}

export interface PivotCell {
  rowKey: string[];
  colKey: string[];
  values: Record<string, number | null>;
}

export interface PivotResponse {
  rows: string[];
  columns: string[];
  measures: Measure[];
  currency: CurrencyCode;
  cells: PivotCell[];
  rowTotals: PivotCell[];
  columnTotals: PivotCell[];
  grandTotal: Record<string, number | null>;
  warnings: ApiWarning[];
}

/* ─── ERT jobs ─── */
export interface ErtJobRunRequest {
  serverName: string;
  edmDatabaseName: string;
  treatyYear: number;
  currency: CurrencyCode;
  peril?: Peril;
  aggregationLevels: AggregationLevel[];
  rerun?: boolean;
  startedBy?: string;
}

export interface ErtJobAcceptedResponse {
  jobId: string;
  status: JobStatus;
}

export interface ErtJobError {
  message: string;
  technical: {
    serverName: string;
    databaseName: string;
    procedureName: string;
    inputParameters: Record<string, unknown>;
    timestamp: string;
    logId?: string | null;
    tablesChecked: string[];
    tablesGeneratedBeforeFailure: string[];
  };
  emailSent: boolean;
}

export interface ErtJobStatusResponse {
  jobId: string;
  status: JobStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  outputTablesGenerated: string[];
  rowsGenerated: number;
  error?: ErtJobError | null;
}

/* ─── Health ─── */
export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  dataProvider: string;
}
