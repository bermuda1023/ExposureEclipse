/**
 * Small color-key for the active wind-map layer.
 *
 * Mounts bottom-left of the map (shifting up if the hazard-overlay legend
 * is also visible). Only renders when a live storm is active AND the wind
 * -map layer is on. Shows the palette for the current mode:
 *
 *   * observed / gfs / ecmwf → SSHWS-anchored speed ramp with kt labels
 *   * diff-obs-vs-gfs        → diverging ramp with "Obs weaker" / "Obs stronger"
 *   * diff-obs-vs-ecmwf      → same, obs vs ECMWF
 *   * diff-gfs-vs-ecmwf      → same, GFS vs ECMWF
 *
 * Diverging modes always spell out which side is bigger since users can't
 * be expected to remember which colour means "GFS more" mid-workflow.
 */

import { useHazardOverlayStore } from "../../state/hazardOverlay";
import { useLiveStormStore, type WindMapMode } from "../../state/liveStorm";

interface RampStop {
  color: string;
  label: string;   // ""  = no label, saves ink for intermediate stops
}

// Speed ramp — anchored on the SSHWS thresholds (34 kt TS, 64 kt Cat 1,
// 96 kt Cat 3+). Matches the palette in LiveStormLayer.tsx exactly.
const SPEED_STOPS: RampStop[] = [
  { color: "#e0f2fe", label: "0" },
  { color: "#a3e635", label: "" },
  { color: "#facc15", label: "25" },
  { color: "#fb923c", label: "34 TS" },
  { color: "#dc2626", label: "" },
  { color: "#7f1d1d", label: "64 Cat 1" },
  { color: "#581c87", label: "96+" },
];

// Diverging ramp. Left end = negative Δ, right end = positive Δ.
const DIFF_STOPS: RampStop[] = [
  { color: "#1e3a8a", label: "" },
  { color: "#60a5fa", label: "" },
  { color: "#bfdbfe", label: "" },
  { color: "#f8fafc", label: "0" },
  { color: "#fecaca", label: "" },
  { color: "#dc2626", label: "" },
  { color: "#7f1d1d", label: "" },
];

const MODE_TITLES: Record<WindMapMode, string> = {
  "observed": "Observed wind speed (kt)",
  "gfs": "GFS wind speed (kt)",
  "ecmwf": "ECMWF wind speed (kt)",
  "diff-obs-vs-gfs": "Obs vs GFS (Δ kt)",
  "diff-obs-vs-ecmwf": "Obs vs ECMWF (Δ kt)",
  "diff-gfs-vs-ecmwf": "GFS vs ECMWF (Δ kt)",
};

// For a diff mode, what does each end of the ramp mean?
const DIFF_ENDS: Record<string, [string, string]> = {
  "diff-obs-vs-gfs": ["GFS more", "Obs more"],
  "diff-obs-vs-ecmwf": ["ECMWF more", "Obs more"],
  "diff-gfs-vs-ecmwf": ["ECMWF more", "GFS more"],
};

export function WindMapLegend() {
  const data = useLiveStormStore((s) => s.data);
  const showWindMap = useLiveStormStore((s) => s.showWindMap);
  const mode = useLiveStormStore((s) => s.windMapMode);
  const hazardActive = useHazardOverlayStore((s) => s.active);

  if (!data || !showWindMap) return null;

  const isDiff = mode.startsWith("diff-");
  const stops = isDiff ? DIFF_STOPS : SPEED_STOPS;
  const title = MODE_TITLES[mode];
  const ends = isDiff ? DIFF_ENDS[mode] : null;

  // Sit above the hazard legend if that one is showing, so both are readable.
  const bottom = hazardActive ? 84 : 14;

  return (
    <div
      style={{
        position: "absolute",
        left: 14,
        bottom,
        zIndex: 5,
        background: "rgba(255,255,255,0.95)",
        border: "1px solid var(--ink-300)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-sm)",
        padding: "6px 10px 8px",
        fontSize: "0.68rem",
        color: "var(--ink-700)",
        maxWidth: 260,
      }}
    >
      <div
        style={{
          fontWeight: 700,
          fontSize: "0.63rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--ink-500)",
          marginBottom: 5,
        }}
      >
        {title}
      </div>
      <div
        style={{
          display: "flex",
          height: 10,
          borderRadius: 2,
          overflow: "hidden",
          border: "1px solid var(--ink-200)",
        }}
      >
        {stops.map((s, i) => (
          <div
            key={i}
            style={{ background: s.color, flex: 1 }}
            title={s.label}
          />
        ))}
      </div>
      {isDiff && ends ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 3,
            fontSize: "0.63rem",
          }}
        >
          <span style={{ color: "#1e3a8a", fontWeight: 600 }}>← {ends[0]}</span>
          <span style={{ color: "var(--ink-400)" }}>even</span>
          <span style={{ color: "#7f1d1d", fontWeight: 600 }}>{ends[1]} →</span>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 3,
            fontSize: "0.63rem",
            color: "var(--ink-500)",
          }}
        >
          {stops
            .map((s, i) => (s.label ? [i, s.label] as const : null))
            .filter((x): x is readonly [number, string] => x !== null)
            .map(([i, label]) => (
              <span
                key={i}
                style={{
                  flex: "0 0 auto",
                  // Space labels evenly under the ramp — approximate their
                  // horizontal position via the stop index.
                  marginLeft: i === 0 ? 0 : "auto",
                }}
              >
                {label}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}
