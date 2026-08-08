/**
 * Toolbar chip: master on/off for the live flood overlay. The severity floor
 * and hide-exposures toggle live in the FloodPanel, which opens when active.
 */

import { useLiveFloodStore } from "../../state/liveFlood";

export function FloodControls() {
  const active = useLiveFloodStore((s) => s.active);
  const toggle = useLiveFloodStore((s) => s.toggle);

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
        background: active ? "#1d4ed8" : "var(--ink-50)",
        border: `1px solid ${active ? "#1d4ed8" : "var(--ink-200)"}`,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
      title={active ? "Hide live flood overlay" : "Show live flooding — active NWS flood warnings"}
    >
      <span aria-hidden>🌊</span>
      Flood (live)
    </button>
  );
}
