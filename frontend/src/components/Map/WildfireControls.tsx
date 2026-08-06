/**
 * Chip toggling the live wildfire overlay (WFIGS perimeters + FIRMS heat).
 * Separate from the "Risk" hazard-grid chips — this is live incident data.
 */

import { useLiveWildfireStore } from "../../state/liveWildfire";

export function WildfireControls() {
  const active = useLiveWildfireStore((s) => s.active);
  const showHeat = useLiveWildfireStore((s) => s.showHeat);
  const toggle = useLiveWildfireStore((s) => s.toggle);
  const setShowHeat = useLiveWildfireStore((s) => s.setShowHeat);

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 5px",
        background: "var(--ink-50)",
        border: "1px solid var(--ink-200)",
        borderRadius: 999,
        fontSize: "0.66rem",
        color: "var(--ink-600)",
      }}
      title="Live wildfire — current NIFC/WFIGS burn-area perimeters + NASA FIRMS satellite heat"
    >
      <button
        type="button"
        onClick={toggle}
        style={{
          all: "unset",
          cursor: "pointer",
          padding: "2px 8px",
          borderRadius: 999,
          fontWeight: 600,
          color: active ? "white" : "var(--ink-700)",
          background: active ? "#ea580c" : "transparent",
          border: `1px solid ${active ? "#ea580c" : "var(--ink-300)"}`,
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
        }}
        title={active ? "Hide live wildfire overlay" : "Show live wildfire overlay"}
      >
        <span aria-hidden>🔥</span>
        Wildfire (live)
      </button>
      {active && (
        <button
          type="button"
          onClick={() => setShowHeat(!showHeat)}
          style={{
            all: "unset",
            cursor: "pointer",
            padding: "2px 7px",
            borderRadius: 999,
            fontWeight: 600,
            color: showHeat ? "white" : "var(--ink-600)",
            background: showHeat ? "#dc2626" : "transparent",
            border: `1px solid ${showHeat ? "#dc2626" : "var(--ink-300)"}`,
          }}
          title="Toggle NASA FIRMS satellite active-fire points"
        >
          🛰 Heat
        </button>
      )}
    </div>
  );
}
