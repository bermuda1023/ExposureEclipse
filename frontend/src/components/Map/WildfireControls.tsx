/**
 * Toolbar chip: master on/off for the live wildfire overlay. Per-layer
 * toggles (perimeters / heat shapes / heat points) + the FIRMS day window
 * live in the WildfirePanel, which opens when this is active.
 */

import { useLiveWildfireStore } from "../../state/liveWildfire";

export function WildfireControls() {
  const active = useLiveWildfireStore((s) => s.active);
  const toggle = useLiveWildfireStore((s) => s.toggle);

  return (
    <button
      type="button"
      onClick={toggle}
      style={{
        all: "unset",
        cursor: "pointer",
        padding: "3px 10px",
        borderRadius: 999,
        fontWeight: 600,
        fontSize: "0.66rem",
        color: active ? "white" : "var(--ink-700)",
        background: active ? "#ea580c" : "var(--ink-50)",
        border: `1px solid ${active ? "#ea580c" : "var(--ink-200)"}`,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
      title={active ? "Hide live wildfire overlay" : "Show live wildfire — WFIGS perimeters + NASA FIRMS heat"}
    >
      <span aria-hidden>🔥</span>
      Wildfire (live)
    </button>
  );
}
