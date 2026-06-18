import { ErtStatus } from "../../types/contracts";

const STYLES: Record<ErtStatus, { bg: string; fg: string; dot: string; label: string }> = {
  [ErtStatus.ERT_READY]: { bg: "var(--ok-100)", fg: "var(--ok-700)", dot: "var(--ok-500)", label: "Ready" },
  [ErtStatus.ERT_READY_PRIOR_RUN_DETECTED]: {
    bg: "var(--warn-100)", fg: "var(--warn-700)", dot: "var(--warn-500)", label: "Ready · prior run",
  },
  [ErtStatus.ERT_PARTIAL]: { bg: "var(--warn-100)", fg: "var(--warn-700)", dot: "var(--warn-500)", label: "Partial" },
  [ErtStatus.ERT_NOT_FOUND]: { bg: "var(--error-100)", fg: "var(--error-700)", dot: "var(--error-500)", label: "Not found" },
  [ErtStatus.ERT_ERROR]: { bg: "var(--error-100)", fg: "var(--error-700)", dot: "var(--error-500)", label: "Error" },
};

export function ErtBadge({ status }: { status: ErtStatus }) {
  const s = STYLES[status];
  return (
    <span
      style={{
        background: s.bg,
        color: s.fg,
        padding: "1px 7px 1px 5px",
        borderRadius: 999,
        fontSize: "0.66rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
      title={status}
    >
      <span
        aria-hidden
        style={{ width: 5, height: 5, borderRadius: 999, background: s.dot, display: "inline-block" }}
      />
      {s.label}
    </span>
  );
}
