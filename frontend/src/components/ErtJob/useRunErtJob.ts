/**
 * Hook to start an ERT job and poll its status until terminal.
 * Per BACKGROUND_JOBS_SPEC.md: 2s polling while queued/running, 5s after 30s.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  if (
    statusQuery.data &&
    (statusQuery.data.status === "completed" || statusQuery.data.status === "failed") &&
    dataset
  ) {
    qc.invalidateQueries({ queryKey: ["programmes"] });
  }

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
