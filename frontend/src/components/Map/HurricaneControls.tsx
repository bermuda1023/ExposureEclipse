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
  { value: -1, label: "All (incl. TD/TS)" },
  { value: 0, label: "≥ TS" },
  { value: 1, label: "≥ Cat 1" },
  { value: 2, label: "≥ Cat 2" },
  { value: 3, label: "≥ Cat 3" },
  { value: 4, label: "≥ Cat 4" },
  { value: 5, label: "Cat 5 only" },
];

export function HurricaneControls() {
  const {
    enabled,
    yearMin,
    yearMax,
    minCategory,
    landfallOnly,
    setEnabled,
    setYearRange,
    setMinCategory,
    setLandfallOnly,
  } = useHurricaneStore();

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
            aria-label="Minimum category (landfall when applicable, else peak)"
            title="Strength filter — uses landfall intensity when the storm hit land, peak otherwise"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setLandfallOnly(!landfallOnly)}
            aria-pressed={landfallOnly}
            title={
              landfallOnly
                ? "Only show storms that made landfall. Click to include open-sea storms (filtered by peak strength)."
                : "Including all storms — filter uses peak strength for non-landfalling. Click to restrict to landfalling only."
            }
            style={{
              fontSize: "0.72rem",
              padding: "4px 9px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${landfallOnly ? "var(--brand-700)" : "var(--ink-300)"}`,
              background: landfallOnly ? "var(--brand-700)" : "var(--ink-0)",
              color: landfallOnly ? "white" : "var(--ink-700)",
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              gap: 5,
              alignItems: "center",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: landfallOnly ? "white" : "var(--ink-400)",
                display: "inline-block",
              }}
            />
            Landfall only
          </button>
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
