/**
 * Toolbar control for the hurricane overlay.
 *
 *  ┌ Hurricanes (toggle) ┐ ┌ 2010 – 2024 ┐ ┌ ≥ Cat 3 ┐
 *
 * The year inputs and category dropdown are inline next to the toggle when
 * the layer is enabled. Hidden otherwise to keep the toolbar tidy.
 */

import { useEffect, useState } from "react";
import { useHurricaneStore } from "../../state/hurricanes";
import { SAFFIR_SIMPSON_COLORS } from "./hurricaneColors";

// Upper bound on the year input — current UTC year. Hardcoding 2025 made
// the input reject anything typed above it once we passed New Year.
const CURRENT_YEAR = new Date().getUTCFullYear();
const MIN_YEAR = 1950;

const CATEGORIES = [
  { value: -1, label: "All (incl. TD/TS)" },
  { value: 0, label: "≥ TS" },
  { value: 1, label: "≥ Cat 1" },
  { value: 2, label: "≥ Cat 2" },
  { value: 3, label: "≥ Cat 3" },
  { value: 4, label: "≥ Cat 4" },
  { value: 5, label: "Cat 5 only" },
];

// Hurricane-landfall states — Atlantic + Gulf coastline + PR.
// Order is rough north-to-south so the picker reads geographically.
const LANDFALL_STATES: { code: string; label: string }[] = [
  { code: "ME", label: "ME" },
  { code: "MA", label: "MA" },
  { code: "RI", label: "RI" },
  { code: "CT", label: "CT" },
  { code: "NY", label: "NY" },
  { code: "NJ", label: "NJ" },
  { code: "DE", label: "DE" },
  { code: "MD", label: "MD" },
  { code: "VA", label: "VA" },
  { code: "NC", label: "NC" },
  { code: "SC", label: "SC" },
  { code: "GA", label: "GA" },
  { code: "FL", label: "FL" },
  { code: "AL", label: "AL" },
  { code: "MS", label: "MS" },
  { code: "LA", label: "LA" },
  { code: "TX", label: "TX" },
  { code: "PR", label: "PR" },
];

export function HurricaneControls() {
  const {
    enabled,
    yearMin,
    yearMax,
    minCategory,
    landfallOnly,
    landfallStates,
    setEnabled,
    setYearRange,
    setMinCategory,
    setLandfallOnly,
    toggleLandfallState,
    setLandfallStates,
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
            <YearInput
              value={yearMin}
              min={MIN_YEAR}
              max={CURRENT_YEAR}
              ariaLabel="Earliest year"
              onCommit={(v) => {
                // Cross-clamp: if the user types an earliest year above the
                // current latest, bump latest up too rather than silently
                // clamping to yearMax (which was the source of the glitch).
                const newMax = Math.max(yearMax, v);
                setYearRange(v, newMax);
              }}
            />
            <span>–</span>
            <YearInput
              value={yearMax}
              min={MIN_YEAR}
              max={CURRENT_YEAR}
              ariaLabel="Latest year"
              onCommit={(v) => {
                // Same cross-clamp the other way — earliest never > latest.
                const newMin = Math.min(yearMin, v);
                setYearRange(newMin, v);
              }}
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
          <LandfallStatePicker
            selected={landfallStates}
            onToggle={toggleLandfallState}
            onClear={() => setLandfallStates([])}
          />
          <HurricaneLegend />
        </>
      )}
    </div>
  );
}

function LandfallStatePicker({
  selected,
  onToggle,
  onClear,
}: {
  selected: string[];
  onToggle: (code: string) => void;
  onClear: () => void;
}) {
  const active = new Set(selected);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "2px 5px 2px 6px",
        background: "var(--ink-50)",
        border: "1px solid var(--ink-200)",
        borderRadius: 999,
        fontSize: "0.66rem",
        color: "var(--ink-600)",
        flexWrap: "wrap",
      }}
      title="Filter to storms that made landfall in these states. Empty = all states."
    >
      <span style={{ marginRight: 4, fontWeight: 600 }}>Landfall:</span>
      {LANDFALL_STATES.map((s) => {
        const on = active.has(s.code);
        return (
          <button
            key={s.code}
            type="button"
            onClick={() => onToggle(s.code)}
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "1px 5px",
              borderRadius: 3,
              fontSize: "0.62rem",
              fontWeight: 700,
              color: on ? "white" : "var(--ink-600)",
              background: on ? "var(--accent-500)" : "transparent",
              border: `1px solid ${on ? "var(--accent-500)" : "var(--ink-300)"}`,
            }}
            title={`${on ? "Remove" : "Add"} ${s.code} from landfall filter`}
          >
            {s.label}
          </button>
        );
      })}
      {selected.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          style={{
            all: "unset",
            cursor: "pointer",
            marginLeft: 4,
            color: "var(--brand-700)",
            textDecoration: "underline",
            fontSize: "0.62rem",
          }}
        >
          clear
        </button>
      )}
    </div>
  );
}

/**
 * Number-typed year input that only commits to the store on blur / Enter,
 * so the user can freely type a 4-digit year without the intermediate
 * digits (2 → 20 → 202 → 2023) getting clamped on each keystroke.
 *
 * The previous implementation clamped `+e.target.value` on every change,
 * which broke typing in three ways:
 *   1. Typing "2023" into a field with max=yearMax=2020 clamped every
 *      digit to 2020, so the user could never raise the year at all.
 *   2. Backspacing to empty gave +"" = 0, which NaN-guarded back to
 *      MIN_YEAR — cursor jumped, field snapped to 1950.
 *   3. Number spinner arrows also snapped past the clamp boundary
 *      because HTML min/max was set to the OTHER field's value.
 *
 * This version keeps a local string, commits an integer on blur/Enter,
 * and cross-clamps at the callsite instead of the DOM — so typing an
 * earliest year of 2023 with current latest at 2020 bumps latest up
 * rather than rejecting the input.
 */
function YearInput({
  value,
  min,
  max,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  ariaLabel: string;
}) {
  const [local, setLocal] = useState<string>(String(value));

  // Sync from the store when the value changes for an external reason
  // (Clear button, cross-clamp from the other field, etc.). Only rewrites
  // the local string when it drifts from the prop — no thrash while typing.
  useEffect(() => {
    setLocal((cur) => (cur === String(value) ? cur : String(value)));
  }, [value]);

  const commit = () => {
    const n = parseInt(local, 10);
    if (Number.isNaN(n)) {
      setLocal(String(value));   // revert an empty/garbage field
      return;
    }
    const clamped = Math.max(min, Math.min(max, n));
    setLocal(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      type="number"
      value={local}
      // Deliberately NO min/max attributes — HTML clamping fights with the
      // typing UX. Commit-time clamping in the callback is the source of
      // truth.
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setLocal(String(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      inputMode="numeric"
      maxLength={4}
      style={{ width: 60, fontSize: "0.78rem" }}
      aria-label={ariaLabel}
    />
  );
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
