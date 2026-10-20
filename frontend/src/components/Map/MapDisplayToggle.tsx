/**
 * Switches the exposure layer between the flat choropleth and 3D columns.
 * Bars use the same metric, colour ramp, and data as the flat fill; only the
 * height is added.
 */

import { useViewStore, type MapDisplay } from "../../state/view";

const OPTIONS: { value: MapDisplay; label: string; title: string }[] = [
  { value: "fill", label: "Fill", title: "Flat choropleth" },
  { value: "bars", label: "3D bars", title: "Column height is the metric value. Drag with right-click or Ctrl to tilt." },
];

export function MapDisplayToggle() {
  const mode = useViewStore((s) => s.mapDisplay);
  const setMode = useViewStore((s) => s.setMapDisplay);
  return (
    <div
      role="group"
      aria-label="Map display"
      style={{
        display: "inline-flex",
        border: "1px solid var(--ink-300)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
      }}
    >
      {OPTIONS.map(({ value, label, title }) => {
        const on = mode === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            title={title}
            onClick={() => setMode(value)}
            style={{
              fontSize: "0.74rem",
              padding: "5px 10px",
              border: "none",
              background: on ? "var(--brand-700)" : "var(--ink-0)",
              color: on ? "white" : "var(--ink-700)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
