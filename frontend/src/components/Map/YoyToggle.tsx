/**
 * YoY view-mode toggle. When on, the choropleth colors the YoY change of
 * whatever metric is selected in the dropdown next to it.
 *
 * Enabled when a chain is selected (the chain auto-pairs latest vs prior) or
 * when a programme is selected and the user has explicitly set a comparison
 * programme. Disabled at the cedent level — cedent-wide YoY needs prior-year
 * chain mapping, which lands in v2.
 */

import { useEffect } from "react";
import { useSelectionStore } from "../../state/selection";
import { useViewStore } from "../../state/view";

export function YoyToggle() {
  const yoyMode = useViewStore((s) => s.yoyMode);
  const setYoyMode = useViewStore((s) => s.setYoyMode);
  const chainId = useSelectionStore((s) => s.chainId);
  const programmeId = useSelectionStore((s) => s.programmeId);
  const comparisonProgrammeId = useSelectionStore((s) => s.comparisonProgrammeId);
  const cedentId = useSelectionStore((s) => s.cedentId);
  const officeKey = useSelectionStore((s) => s.officeKey);

  const disabled =
    Boolean(cedentId || officeKey) ||
    (!chainId && !(programmeId && comparisonProgrammeId));

  // Auto-untick when the new selection can't compute YoY. Prevents the toolbar
  // from claiming YoY mode while the map silently shows "current vs zero".
  useEffect(() => {
    if (disabled && yoyMode) setYoyMode(false);
  }, [disabled, yoyMode, setYoyMode]);

  const title = disabled
    ? cedentId
      ? "YoY at the cedent level is not yet supported. Pick a chain or programme."
      : "Pick a chain (auto-pairs prior) or set a comparison programme to enable YoY."
    : yoyMode
      ? "Showing year-over-year change. Click to switch back to absolute values."
      : "Show year-over-year change of the selected metric.";

  return (
    <button
      type="button"
      onClick={() => setYoyMode(!yoyMode)}
      disabled={disabled}
      aria-pressed={yoyMode}
      title={title}
      style={{
        fontSize: "0.74rem",
        padding: "5px 10px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${yoyMode ? "var(--brand-700)" : "var(--ink-300)"}`,
        background: yoyMode ? "var(--brand-700)" : "var(--ink-0)",
        color: yoyMode ? "white" : "var(--ink-700)",
        fontWeight: 600,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: yoyMode ? "white" : "var(--ink-400)",
          display: "inline-block",
        }}
      />
      YoY
    </button>
  );
}
