/**
 * Key for the live wildfire overlay — only shown while the overlay is active.
 * Explains the three layers' colour encodings.
 */

import { useLiveWildfireStore } from "../../state/liveWildfire";

function Ramp({ colors }: { colors: string[] }) {
  return (
    <span style={{
      display: "inline-block", width: 46, height: 9, borderRadius: 2,
      background: `linear-gradient(90deg, ${colors.join(", ")})`,
      border: "1px solid rgba(0,0,0,0.15)",
    }} />
  );
}

export function WildfireLegend() {
  const s = useLiveWildfireStore();
  if (!s.active) return null;

  const rows: { show: boolean; node: JSX.Element; label: string }[] = [
    {
      show: s.showHeat,
      label: "Satellite heat (FRP: low → high)",
      node: <Ramp colors={["#fde047", "#f97316", "#dc2626"]} />,
    },
    {
      show: s.showPerimeters,
      label: "Perimeter outline (0% → 100% contained)",
      node: <Ramp colors={["#dc2626", "#f59e0b", "#16a34a"]} />,
    },
    {
      show: s.showHeatShapes,
      label: "Heat-derived footprint",
      node: <span style={{ display: "inline-block", width: 46, height: 9, background: "rgba(185,28,28,0.16)", border: "1px dashed #b91c1c" }} />,
    },
  ];
  const visible = rows.filter((r) => r.show);
  if (visible.length === 0) return null;

  return (
    <div style={{
      position: "absolute", bottom: 12, left: 12,
      background: "var(--surface, rgba(255,255,255,0.97))",
      border: "1px solid var(--ink-200)", borderRadius: 8,
      boxShadow: "0 3px 12px rgba(0,0,0,0.12)",
      padding: "7px 9px", fontSize: "0.64rem", color: "var(--ink-700)", zIndex: 4,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: "0.58rem", color: "var(--ink-500)" }}>
        Wildfire key
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {visible.map((r) => (
          <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {r.node}
            <span>{r.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
