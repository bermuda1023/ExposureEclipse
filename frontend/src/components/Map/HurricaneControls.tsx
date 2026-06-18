/**
 * Toolbar control for the hurricane overlay.
 *
 *  ┌ Hurricanes (toggle) ┐ ┌ 2010 – 2024 ┐ ┌ ≥ Cat 3 ┐
 *
 * The year inputs and category dropdown are inline next to the toggle when
 * the layer is enabled. Hidden otherwise to keep the toolbar tidy.
 */

import { useHurricaneStore } from "../../state/hurricanes";
import { SAFFIR_SIMPSON_COLORS } from "./hurricaneColors";

const CATEGORIES = [
  { value: -2, label: "All (incl. no landfall)" },
  { value: 0, label: "≥ TS" },
  { value: 1, label: "≥ Cat 1" },
  { value: 2, label: "≥ Cat 2" },
  { value: 3, label: "≥ Cat 3" },
  { value: 4, label: "≥ Cat 4" },
  { value: 5, label: "Cat 5 only" },
];

export function HurricaneControls() {
  const { enabled, yearMin, yearMax, minCategory, setEnabled, setYearRange, setMinCategory } =
    useHurricaneStore();

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <button
        type="button"
        onClick={() => setEnabled(!enabled)}
        aria-pressed={enabled}
        title={enabled ? "Hide hurricane tracks" : "Show NOAA hurricane tracks since 1950"}
        style={{
          fontSize: "0.74rem",
          padding: "5px 10px",
          borderRadius: "var(--radius-sm)",
          border: `1px solid ${enabled ? "var(--accent-500)" : "var(--ink-300)"}`,
          background: enabled ? "var(--accent-500)" : "var(--ink-0)",
          color: enabled ? "white" : "var(--ink-700)",
          fontWeight: 600,
          display: "inline-flex",
          gap: 6,
          alignItems: "center",
          cursor: "pointer",
        }}
      >
        <span aria-hidden>🌀</span>
        Hurricanes
      </button>

      {enabled && (
        <>
          <label style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: "0.72rem", color: "var(--ink-600)" }}>
            <input
              type="number"
              value={yearMin}
              min={1950}
              max={yearMax}
              onChange={(e) => setYearRange(clampYear(+e.target.value, 1950, yearMax), yearMax)}
              style={{ width: 60, fontSize: "0.78rem" }}
              aria-label="Earliest year"
            />
            <span>–</span>
            <input
              type="number"
              value={yearMax}
              min={yearMin}
              max={2025}
              onChange={(e) => setYearRange(yearMin, clampYear(+e.target.value, yearMin, 2025))}
              style={{ width: 60, fontSize: "0.78rem" }}
              aria-label="Latest year"
            />
          </label>
          <select
            value={minCategory}
            onChange={(e) => setMinCategory(+e.target.value)}
            style={{ fontSize: "0.78rem", width: "auto" }}
            aria-label="Minimum landfall category"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <HurricaneLegend />
        </>
      )}
    </div>
  );
}

function clampYear(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function HurricaneLegend() {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: "2px 6px",
        background: "var(--ink-50)",
        border: "1px solid var(--ink-200)",
        borderRadius: 999,
        fontSize: "0.66rem",
        color: "var(--ink-600)",
      }}
      title="Saffir-Simpson colour scale"
    >
      <span style={{ marginRight: 4 }}>SSHWS</span>
      {[1, 2, 3, 4, 5].map((c) => (
        <span
          key={c}
          style={{
            width: 14,
            height: 8,
            background: SAFFIR_SIMPSON_COLORS[c],
            borderRadius: 2,
            display: "inline-block",
          }}
          title={`Cat ${c}`}
        />
      ))}
    </div>
  );
}
