/**
 * Hook to start an ERT job and poll its status until terminal.
 * Per BACKGROUND_JOBS_SPEC.md: 2s polling while queued/running, 5s after 30s.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { runErtJob } from "../../api/jobs";
import { useErtJobStatus } from "../../api/hooks";
import type { Dataset } from "../../api/types";
import { Peril, AggregationLevel } from "../../types/contracts";

export function useRunErtJob(dataset: Dataset | null | undefined) {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (rerun: boolean) => {
      if (!dataset) throw new Error("No dataset selected");
      const res = await runErtJob({
        serverName: dataset.serverName,
        edmDatabaseName: dataset.edmDatabaseName,
        treatyYear: dataset.treatyYear,
        currency: dataset.currency,
        peril: Peril.ALL,
        aggregationLevels: [
          AggregationLevel.COUNTRY,
          AggregationLevel.STATE,
          AggregationLevel.CRESTA,
        ],
        rerun,
      });
      return res;
    },
    onSuccess: (res) => {
      setJobId(res.jobId);
    },
  });

  const statusQuery = useErtJobStatus(jobId);

  // Refresh any programme-status badge for this dataset's underlying EDM when
  // the job reaches a terminal state. We don't know the programmeId from a
  // bare Dataset shape, so we invalidate the broader programmes namespace.
  // Fire ONCE per job on the transition into a terminal status — invalidating
  // in the render body re-ran on every render while the status stayed
  // terminal, looping invalidate→refetch against CedentTree's
  // ["programmes", id, "status"] queries.
  const status = statusQuery.data?.status;
  const invalidatedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jobId || !dataset) return;
    if (status !== "completed" && status !== "failed") return;
    if (invalidatedJobRef.current === jobId) return;
    invalidatedJobRef.current = jobId;
    qc.invalidateQueries({ queryKey: ["programmes"] });
  }, [jobId, status, dataset, qc]);

  return {
    run: () => mutation.mutate(false),
    rerun: () => mutation.mutate(true),
    jobId,
    status: statusQuery.data,
    isRunning:
      statusQuery.data?.status === "queued" || statusQuery.data?.status === "running",
    error: mutation.error ?? statusQuery.error,
    isStarting: mutation.isPending,
  };
}
