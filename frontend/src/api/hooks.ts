/**
 * TanStack Query hooks — the only thing components use to read API data.
 *
 * Components MUST go through these (not raw fetch / not the api/* functions
 * directly) so cache invalidation stays consistent and we can swap providers
 * without touching the UI. CLAUDE.md rule 1.
 */

import { useMemo } from "react";
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { blendCalibratedCurve, type CalibratedCurve } from "../state/damageAssumptions";
import { listCedents } from "./cedents";
import { fetchDetail, fetchMap, fetchPivot } from "./exposures";
import { apiGet } from "./client";
import { getErtJobStatus } from "./jobs";
import {
  fetchBacktest,
  fetchDamageCurves,
  fetchIndustryLoss,
  type BacktestResponse,
  type DamageCurvesResponse,
  type IndustryLossResponse,
} from "./industryLoss";
import type { CedentTreeResponse } from "./cedents";
import type {
  DatasetStatusResponse,
  DetailRequest,
  DetailResponse,
  ErtJobStatusResponse,
  HealthResponse,
  MapRequest,
  MapResponse,
  PivotRequest,
  PivotResponse,
} from "./types";

export const queryKeys = {
  health: ["health"] as const,
  cedents: () => ["cedents"] as const,
  programmeStatus: (id: string) => ["programmes", id, "status"] as const,
  map: (req: MapRequest) => ["exposures", "map", req] as const,
  detail: (req: DetailRequest) => ["exposures", "detail", req] as const,
  pivot: (req: PivotRequest) => ["exposures", "pivot", req] as const,
  job: (id: string) => ["ert-jobs", id] as const,
} as const;

export const useHealth = () =>
  useQuery({ queryKey: queryKeys.health, queryFn: () => apiGet<HealthResponse>("/health") });

export const useCedents = () =>
  useQuery<CedentTreeResponse>({
    queryKey: queryKeys.cedents(),
    queryFn: () => listCedents(),
  });

export const useProgrammeStatus = (programmeId: string | null | undefined) =>
  useQuery<DatasetStatusResponse>({
    queryKey: queryKeys.programmeStatus(programmeId ?? ""),
    queryFn: () =>
      apiGet<DatasetStatusResponse>(`/programmes/${encodeURIComponent(programmeId as string)}/status`),
    enabled: Boolean(programmeId),
  });

export const useMapData = (
  req: MapRequest | null,
  opts?: Partial<UseQueryOptions<MapResponse>>,
) =>
  useQuery<MapResponse>({
    queryKey: req ? queryKeys.map(req) : ["exposures", "map", null],
    queryFn: ({ signal }) => fetchMap(req as MapRequest, signal),
    enabled: Boolean(req) && (opts?.enabled ?? true),
    ...opts,
  });

export const useDetailData = (req: DetailRequest | null) =>
  useQuery<DetailResponse>({
    queryKey: req ? queryKeys.detail(req) : ["exposures", "detail", null],
    queryFn: ({ signal }) => fetchDetail(req as DetailRequest, signal),
    enabled: Boolean(req),
  });

export const usePivotData = (req: PivotRequest | null) =>
  useQuery<PivotResponse>({
    queryKey: req ? queryKeys.pivot(req) : ["exposures", "pivot", null],
    queryFn: ({ signal }) => fetchPivot(req as PivotRequest, signal),
    enabled: Boolean(req),
  });

export const useDamageCurves = () =>
  useQuery<DamageCurvesResponse>({
    queryKey: ["damage-curves"],
    queryFn: fetchDamageCurves,
    staleTime: 5 * 60_000,
  });

/** The default calibrated curve set, blended across segments by book mix. */
export const useCalibratedCurve = (): CalibratedCurve | null => {
  const { data } = useDamageCurves();
  return useMemo(
    () => blendCalibratedCurve(data?.curveSets.find((c) => c.id === data.defaultId)),
    [data],
  );
};

export const useIndustryLoss = (
  stormId: string | null,
  curveSetId: string | null,
  exposedFraction: Record<string, number>,
) =>
  useQuery<IndustryLossResponse>({
    queryKey: ["industry-loss", stormId, curveSetId, exposedFraction],
    queryFn: () =>
      fetchIndustryLoss(stormId as string, { curveSetId, exposedFraction }),
    enabled: Boolean(stormId),
    staleTime: 60_000,
  });

export const useIndustryBacktest = (stormId: string | null, curveSetId: string | null, enabled: boolean) =>
  useQuery<BacktestResponse>({
    queryKey: ["industry-backtest", stormId, curveSetId],
    queryFn: () => fetchBacktest(stormId as string, curveSetId),
    enabled: Boolean(stormId) && enabled,
    staleTime: 60_000,
  });

/** Polls until status is terminal — BACKGROUND_JOBS_SPEC.md §"Polling guidance". */
export const useErtJobStatus = (jobId: string | null) =>
  useQuery<ErtJobStatusResponse>({
    queryKey: jobId ? queryKeys.job(jobId) : ["ert-jobs", null],
    queryFn: () => getErtJobStatus(jobId as string),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        return false;
      }
      // ~2s while queued/running, backing off after 30s of polling.
      const elapsed = Date.now() - query.state.dataUpdatedAt;
      return elapsed > 30_000 ? 5000 : 2000;
    },
  });
