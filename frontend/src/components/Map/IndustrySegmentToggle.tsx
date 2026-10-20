/**
 * Residential / Commercial / Auto chips for the Industry client. All three on
 * (the default) sends no segment filter, so the map shows the bundled total.
 * The filter feeds every request (map, detail, pivot, export, impact) so the
 * numbers on screen agree with each other.
 */

import { useEffect } from "react";
import { useFiltersStore } from "../../state/filters";
import { useIsIndustryScope } from "../../state/useIsIndustryScope";
import { OccupancySegment } from "../../types/contracts";

const SEGMENTS = [
  { value: OccupancySegment.RESIDENTIAL, label: "Residential" },
  { value: OccupancySegment.COMMERCIAL, label: "Commercial" },
  { value: OccupancySegment.AUTO, label: "Auto" },
] as const;

export function IndustrySegmentToggle() {
  const isIndustry = useIsIndustryScope();
  const selected = useFiltersStore((s) => s.occupancySegment);
  const setSegments = useFiltersStore((s) => s.setOccupancySegment);

  // Other clients have different segments; never carry the chips over.
  useEffect(() => {
    if (!isIndustry && selected.length > 0) setSegments([]);
  }, [isIndustry, selected.length, setSegments]);

  if (!isIndustry) return null;

  const isOn = (v: OccupancySegment) => selected.length === 0 || selected.includes(v);

  const toggle = (v: OccupancySegment) => {
    const current: OccupancySegment[] = SEGMENTS.map((s) => s.value).filter(isOn);
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
    if (next.length === 0) return;
    setSegments(next.length === SEGMENTS.length ? [] : next);
  };

  return (
    <div
      role="group"
      aria-label="Industry segments"
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      title="Pick the segments to show. All three on shows the bundled total."
    >
      <span style={{ fontSize: "0.75rem", color: "var(--ink-600)", marginRight: 2 }}>Segments</span>
      {SEGMENTS.map(({ value, label }) => {
        const on = isOn(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(value)}
            style={{
              fontSize: "0.74rem",
              padding: "4px 9px",
              borderRadius: 999,
              border: `1px solid ${on ? "var(--brand-700)" : "var(--ink-300)"}`,
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
