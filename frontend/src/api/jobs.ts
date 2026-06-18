import { apiGet, apiPost } from "./client";
import type {
  ErtJobAcceptedResponse,
  ErtJobRunRequest,
  ErtJobStatusResponse,
} from "./types";

export const runErtJob = (payload: ErtJobRunRequest) =>
  apiPost<ErtJobAcceptedResponse>("/ert-jobs/run", payload);

export const getErtJobStatus = (jobId: string) =>
  apiGet<ErtJobStatusResponse>(`/ert-jobs/status/${encodeURIComponent(jobId)}`);

export const cancelErtJob = (jobId: string) =>
  apiPost<{ jobId: string; status: string }>(
    `/ert-jobs/${encodeURIComponent(jobId)}/cancel`,
  );
