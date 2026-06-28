/**
 * Toolbar chip group for hail / tornado / wildfire choropleths.
 * At most one peril active; clicking the active chip turns it off.
 */

import { useHazardOverlayStore } from "../../state/hazardOverlay";
import type { HazardType } from "../../api/hazards";

const HAZARDS: { id: HazardType; label: string; emoji: string; tint: string }[] = [
  { id: "tornado",  label: "Tornado",  emoji: "🌪", tint: "#dc2626" },
  { id: "hail",     label: "Hail",     emoji: "🧊", tint: "#3730a3" },
  // Wildfire chip hidden — the WFIGS-derived surface isn't ready for
  // primetime yet (limited 2020+ coverage skews the picture). Re-add
  // the wildfire entry to bring it back; the backend endpoint and
  // grid data are still live.
];

export function HazardOverlayControls() {
  const active = useHazardOverlayStore((s) => s.active);
  const toggle = useHazardOverlayStore((s) => s.toggle);

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 5px 2px 7px",
        background: "var(--ink-50)",
        border: "1px solid var(--ink-200)",
        borderRadius: 999,
        fontSize: "0.66rem",
        color: "var(--ink-600)",
      }}
      title="Hail / tornado / wildfire risk overlays — county-level choropleth"
    >
      <span style={{ fontWeight: 700 }}>Risk:</span>
      {HAZARDS.map((h) => {
        const on = active === h.id;
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => toggle(h.id)}
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "2px 7px",
              borderRadius: 999,
              fontWeight: 600,
              fontSize: "0.66rem",
              color: on ? "white" : "var(--ink-700)",
              background: on ? h.tint : "transparent",
              border: `1px solid ${on ? h.tint : "var(--ink-300)"}`,
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
            }}
            title={on ? `Hide ${h.label} overlay` : `Show ${h.label} overlay`}
          >
            <span aria-hidden>{h.emoji}</span>
            {h.label}
          </button>
        );
      })}
    </div>
  );
}
