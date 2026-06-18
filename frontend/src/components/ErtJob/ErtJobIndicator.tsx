/**
 * Inline ERT-job indicator + Run/Rerun buttons for one dataset.
 *
 * On failure: shows the friendly message + the technical block (BACKGROUND_JOBS_SPEC.md
 * §"Failure requirements") and notes whether the error email was sent.
 */

import type { Dataset } from "../../api/types";
import { useRunErtJob } from "./useRunErtJob";

export function ErtJobIndicator({ dataset }: { dataset: Dataset }) {
  const { run, rerun, status, isRunning, isStarting, error } = useRunErtJob(dataset);
  const startDisabled = isStarting || isRunning;
  return (
    <div style={{ fontSize: "0.75rem", display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => run()} disabled={startDisabled}>
          Run ERT
        </button>
        <button onClick={() => rerun()} disabled={startDisabled}>
          Rerun
        </button>
      </div>
      {isStarting && <span>Submitting…</span>}
      {status && (
        <div>
          Job <code>{status.jobId.slice(-8)}</code>: <strong>{status.status}</strong>
          {status.outputTablesGenerated.length > 0 && (
            <> · tables: {status.outputTablesGenerated.join(", ")}</>
          )}
        </div>
      )}
      {status?.error && (
        <div
          style={{
            background: "#fdecea",
            border: "1px solid #f5c6cb",
            color: "#721c24",
            padding: 6,
            borderRadius: 4,
            marginTop: 4,
          }}
        >
          <div>
            <strong>ERT failed.</strong> {status.error.message}
          </div>
          <div style={{ color: "#666", marginTop: 2 }}>
            Server: <code>{status.error.technical.serverName}</code>
            <br />
            Procedure: <code>{status.error.technical.procedureName}</code>
            <br />
            Tables generated before failure:{" "}
            {status.error.technical.tablesGeneratedBeforeFailure.join(", ") || "(none)"}
            <br />
            Error email sent: {status.error.emailSent ? "yes" : "no"}
          </div>
        </div>
      )}
      {error ? (
        <div style={{ color: "#b00020" }}>
          Job request failed: {String((error as Error)?.message ?? error)}
        </div>
      ) : null}
    </div>
  );
}
