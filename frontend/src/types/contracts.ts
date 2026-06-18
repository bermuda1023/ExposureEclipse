/**
 * Canonical enums — single source of truth on the FRONTEND side.
 *
 * ⭐ MIRRORED from docs/CONTRACTS.md. If you add/change a value here you MUST
 * update docs/CONTRACTS.md AND backend/app/models/enums.py in the same change.
 * No ad-hoc string literals on either side of the wire (CLAUDE.md rule 10).
 *
 * Wire format: UPPER_SNAKE_CASE string literals. Encoded as TS `const` objects
 * plus string-literal union types — gives us both runtime lists (for selects)
 * and compile-time exhaustiveness.
 */

/* ─────────── §1 — Metric keys ─────────── */
export const MetricKey = {
  TIV: "TIV",
  LOCATION_COUNT: "LOCATION_COUNT",
  DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY: "DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY",
  GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO: "GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO",
  SELECTED_DEAL_GEOGRAPHY_CONCENTRATION: "SELECTED_DEAL_GEOGRAPHY_CONCENTRATION",
  CLIENT_MARKET_SHARE: "CLIENT_MARKET_SHARE",
  YOY_CHANGE: "YOY_CHANGE",
} as const;
export type MetricKey = (typeof MetricKey)[keyof typeof MetricKey];

/* ─────────── §1b — Raw ERT measures ─────────── */
export const Measure = {
  TIV: "TIV",
  BUILDING: "BUILDING",
  CONTENTS: "CONTENTS",
  BI: "BI",
  EXPLIM_GR: "EXPLIM_GR",
  EXPLIM_NET: "EXPLIM_NET",
  LOCATION_COUNT: "LOCATION_COUNT",
  ACCOUNT_COUNT: "ACCOUNT_COUNT",
  INVALID_TIV: "INVALID_TIV",
  INVALID_COUNT: "INVALID_COUNT",
} as const;
export type Measure = (typeof Measure)[keyof typeof Measure];

/* ─────────── §2 — Aggregation / geography levels ─────────── */
export const AggregationLevel = {
  COUNTRY: "COUNTRY",
  STATE: "STATE",
  COUNTY: "COUNTY",
  CRESTA: "CRESTA",
} as const;
export type AggregationLevel = (typeof AggregationLevel)[keyof typeof AggregationLevel];

/* ─────────── §3 — ERT status ─────────── */
export const ErtStatus = {
  ERT_NOT_FOUND: "ERT_NOT_FOUND",
  ERT_PARTIAL: "ERT_PARTIAL",
  ERT_READY: "ERT_READY",
  ERT_READY_PRIOR_RUN_DETECTED: "ERT_READY_PRIOR_RUN_DETECTED",
  ERT_ERROR: "ERT_ERROR",
} as const;
export type ErtStatus = (typeof ErtStatus)[keyof typeof ErtStatus];

/* ─────────── §4 — Dataset group combination methods ─────────── */
export const CombinationMethod = {
  MAX_ACROSS_PERILS_AT_VIEW_GRAIN: "MAX_ACROSS_PERILS_AT_VIEW_GRAIN", // default (CLAUDE.md rule 3)
  SUM_DISTINCT_SEGMENTS: "SUM_DISTINCT_SEGMENTS",
  SELECTED_EDM_AS_BASE: "SELECTED_EDM_AS_BASE",
  KEEP_PERILS_SEPARATE: "KEEP_PERILS_SEPARATE",
  CUSTOM: "CUSTOM",
} as const;
export type CombinationMethod = (typeof CombinationMethod)[keyof typeof CombinationMethod];

/* ─────────── §5 — Peril codes ─────────── */
export const Peril = {
  EQ: "EQ",
  WS: "WS",
  CS: "CS",
  FL: "FL",
  FR: "FR",
  TR: "TR",
  ALL: "ALL",
} as const;
export type Peril = (typeof Peril)[keyof typeof Peril];

/* ─────────── §6 — Occupancy segment roll-up ─────────── */
export const OccupancySegment = {
  RESIDENTIAL: "RESIDENTIAL",
  COMMERCIAL: "COMMERCIAL",
  INDUSTRIAL: "INDUSTRIAL",
  UNKNOWN: "UNKNOWN",
} as const;
export type OccupancySegment = (typeof OccupancySegment)[keyof typeof OccupancySegment];

/* ─────────── §7 — Background job status (lowercase on wire) ─────────── */
export const JobStatus = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/* ─────────── §8 — Portfolio scope ─────────── */
export const PortfolioScope = {
  ALL_LOADED_DATASETS: "ALL_LOADED_DATASETS", // v1 default
  BOUND_DEALS: "BOUND_DEALS",
  CUSTOM: "CUSTOM",
} as const;
export type PortfolioScope = (typeof PortfolioScope)[keyof typeof PortfolioScope];

/* ─────────── §9 — YoY status ─────────── */
export const YoyStatus = {
  NEW: "NEW",
  REMOVED: "REMOVED",
  NA: "NA",
  OK: "OK",
} as const;
export type YoyStatus = (typeof YoyStatus)[keyof typeof YoyStatus];

/* ─────────── §10 — Warning codes ─────────── */
export const WarningCode = {
  WARN_COUNTY_DATA_UNAVAILABLE: "WARN_COUNTY_DATA_UNAVAILABLE",
  WARN_CURRENCY_ASSUMED: "WARN_CURRENCY_ASSUMED",
  WARN_CURRENCY_MISMATCH: "WARN_CURRENCY_MISMATCH",
  WARN_IED_DENOMINATOR_MISSING: "WARN_IED_DENOMINATOR_MISSING",
  WARN_PRIOR_DATASET_NOT_SELECTED: "WARN_PRIOR_DATASET_NOT_SELECTED",
  WARN_AGGREGATION_LEVEL_MISMATCH: "WARN_AGGREGATION_LEVEL_MISMATCH",
  WARN_DATASET_GROUP_MAX_ACROSS_PERILS: "WARN_DATASET_GROUP_MAX_ACROSS_PERILS",
  WARN_DATASET_GROUP_SUMMED: "WARN_DATASET_GROUP_SUMMED",
  WARN_ERT_TABLES_PARTIAL: "WARN_ERT_TABLES_PARTIAL",
  WARN_ERT_NOT_FOUND: "WARN_ERT_NOT_FOUND",
  WARN_MAP_GEOMETRY_MISSING: "WARN_MAP_GEOMETRY_MISSING",
  WARN_FILTERS_RETURN_NO_ROWS: "WARN_FILTERS_RETURN_NO_ROWS",
  WARN_EXPORT_TOO_LARGE: "WARN_EXPORT_TOO_LARGE",
} as const;
export type WarningCode = (typeof WarningCode)[keyof typeof WarningCode];

export const WarningSeverity = {
  INFO: "info",
  WARN: "warn",
} as const;
export type WarningSeverity = (typeof WarningSeverity)[keyof typeof WarningSeverity];

export interface Warning {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
  context?: Record<string, unknown>;
}

/* ─────────── §11 — Error codes ─────────── */
export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  DATASET_NOT_FOUND: "DATASET_NOT_FOUND",
  DATASET_GROUP_NOT_FOUND: "DATASET_GROUP_NOT_FOUND",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  PRIOR_DB_NOT_FOUND: "PRIOR_DB_NOT_FOUND",
  IED_GEOGRAPHY_MISSING: "IED_GEOGRAPHY_MISSING",
  ERT_JOB_FAILED: "ERT_JOB_FAILED",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  EXPORT_TOO_LARGE: "EXPORT_TOO_LARGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/* ─────────── §14 — Dimension band vocabularies ─────────── */
export const GeocodingQuality = {
  COORDINATE: "Coordinate",
  STREET_PARCEL: "Street/Parcel",
  POSTAL_CODE: "Postal code",
  BLOCK_GROUP: "Block Group",
} as const;
export type GeocodingQuality = (typeof GeocodingQuality)[keyof typeof GeocodingQuality];

export const DistanceToCoastBand = {
  A_AT_COAST: "a=> At the Coast",
  B_0_TO_0_5: "b=> 0 - 0.5 Miles from Coast",
  C_0_5_TO_1: "c=> 0.5 - 1 Miles from Coast",
  D_1_TO_2: "d=> 1.0 - 2 Miles from Coast",
  E_2_TO_5: "e=> 2.0 - 5 Miles from Coast",
  F_5_TO_10: "f=> 5.0 - 10 Miles from Coast",
  G_10_PLUS: "g=> +10 Miles from Coast",
} as const;
export type DistanceToCoastBand = (typeof DistanceToCoastBand)[keyof typeof DistanceToCoastBand];

export const YearBuiltBand = {
  PRE_1930: "1930 and before",
  Y_1930_1960: "1930 to 1960",
  Y_1960_1980: "1960 to 1980",
  Y_1980_2000: "1980 to 2000",
  Y_2000_PRESENT: "2000 to Present",
  UNKNOWN: "Unknown",
} as const;
export type YearBuiltBand = (typeof YearBuiltBand)[keyof typeof YearBuiltBand];

// NumberOfStoriesBand and ConstructionClass are data-driven (OPEN_QUESTIONS #27).
// Keep as plain strings until ERT confirms the full set; do NOT hardcode.
export type NumberOfStoriesBand = string;
export type ConstructionClass = string;

/* ─────────── §12 — Currency (ISO 4217, no implicit conversion) ─────────── */
export type CurrencyCode = string; // ISO 4217, e.g. "USD"

/* ─────────── §13 — Group/grain key ─────────── */
// The set of active view dimensions ordered: [geography] + [grouping dims].
export type GrainKey = readonly string[];

/* ─────────── Exposure filter wire shape (API_SPEC.md §exposures) ─────────── */
// Lives here (not in src/api/) so non-API code can also reference the canonical
// dimension surface — e.g. the Zustand filters store, the pivot field selector.
export interface ExposureFilters {
  peril: Peril;
  occupancy: string[];
  distanceToCoast: string[];
  geocoding: string[];
  construction: string[];
  numberOfStories: string[];
  yearBuilt: string[];
}
