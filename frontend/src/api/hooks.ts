/**
 * TanStack Query hooks — the only thing components use to read API data.
 *
 * Components MUST go through these (not raw fetch / not the api/* functions
 * directly) so cache invalidation stays consistent and we can swap providers
 * without touching the UI. CLAUDE.md rule 1.
 */

import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { listCedents } from "./cedents";
import { fetchDetail, fetchMap, fetchPivot } from "./exposures";
import { apiGet } from "./client";
import { getErtJobStatus } from "./jobs";
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
    queryFn: () => fetchMap(req as MapRequest),
    enabled: Boolean(req) && (opts?.enabled ?? true),
    ...opts,
  });

export const useDetailData = (req: DetailRequest | null) =>
  useQuery<DetailResponse>({
    queryKey: req ? queryKeys.detail(req) : ["exposures", "detail", null],
    queryFn: () => fetchDetail(req as DetailRequest),
    enabled: Boolean(req),
  });

export const usePivotData = (req: PivotRequest | null) =>
  useQuery<PivotResponse>({
    queryKey: req ? queryKeys.pivot(req) : ["exposures", "pivot", null],
    queryFn: () => fetchPivot(req as PivotRequest),
    enabled: Boolean(req),
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
