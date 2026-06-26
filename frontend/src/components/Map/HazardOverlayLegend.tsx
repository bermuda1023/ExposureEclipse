/**
 * Legend for the active hazard overlay — shows the colour ramp keyed to
 * the raw values plus source attribution + methodology note.
 *
 * Mounts bottom-left of the map; only renders when a peril is active.
 * Collapsible: defaults to a compact title-plus-ramp chip and expands
 * on click so it doesn't crowd the map view.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchHazard } from "../../api/hazards";
import { useHazardOverlayStore } from "../../state/hazardOverlay";

export function HazardOverlayLegend() {
  const active = useHazardOverlayStore((s) => s.active);
  const clear = useHazardOverlayStore((s) => s.set);
  const [expanded, setExpanded] = useState(false);

  const query = useQuery({
    queryKey: ["hazard", active],
    queryFn: () => fetchHazard(active!),
    enabled: active !== null,
    staleTime: 30 * 60_000,
  });

  if (!active) return null;
  const legend = query.data?.legend;

  // Collapsed: just the title chip + colour ramp + expand affordance.
  // Width auto-sizes to ~180px so it stays out of the way.
  const baseStyle: React.CSSProperties = {
    position: "absolute",
    bottom: 14,
    left: 14,
    zIndex: 6,
    background: "rgba(255,255,255,0.97)",
    border: "1px solid var(--ink-300)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-md)",
    fontSize: "0.72rem",
    color: "var(--ink-800)",
  };

  if (!expanded) {
    return (
      <div style={{ ...baseStyle, padding: "6px 8px", width: 200 }}>
        <button
          onClick={() => setExpanded(true)}
          title="Show legend"
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            width: "100%",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 600, fontSize: "0.7rem" }}>
              {legend?.title?.split(" (")[0] ?? "Loading…"}
            </span>
            <span style={{ color: "var(--ink-500)", fontSize: "0.65rem" }}>⌃</span>
          </div>
          {legend && (
            <div style={{ display: "flex", borderRadius: 2, overflow: "hidden", height: 8 }}>
              {legend.palette.map((c, i) => (
                <div key={i} style={{ flex: 1, background: c }} />
              ))}
            </div>
          )}
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...baseStyle, padding: 10, width: 280 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <div style={{ fontWeight: 700, fontSize: "0.78rem" }}>
          {legend?.title ?? "Loading…"}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setExpanded(false)}
            aria-label="Collapse legend"
            title="Collapse"
            style={{
              all: "unset",
              cursor: "pointer",
              color: "var(--ink-500)",
              fontSize: "0.85rem",
              padding: "0 4px",
            }}
          >
            –
          </button>
          <button
            onClick={() => clear(null)}
            aria-label="Close hazard overlay"
            title="Turn off"
            style={{
              all: "unset",
              cursor: "pointer",
              color: "var(--ink-500)",
              fontSize: "1rem",
              padding: "0 4px",
            }}
          >
            ✕
          </button>
        </div>
      </header>
      {legend && (
        <>
          <div style={{ color: "var(--ink-500)", fontSize: "0.66rem", marginTop: 2 }}>
            {legend.unit}
          </div>
          <div style={{ display: "flex", marginTop: 8, borderRadius: 3, overflow: "hidden" }}>
            {legend.palette.map((c, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: 12,
                  background: c,
                }}
                title={`≥ ${legend.stops[i]}`}
              />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontSize: "0.62rem", color: "var(--ink-600)" }}>
            {legend.stops.map((s, i) => (
              <span key={i}>{s.toLocaleString()}</span>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: "0.62rem", color: "var(--ink-600)" }}>
            Source:{" "}
            <a
              href={legend.sourceUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--brand-700)", textDecoration: "none" }}
            >
              {legend.source}
            </a>
          </div>
          {legend.note && (
            <div style={{ marginTop: 4, fontSize: "0.6rem", color: "var(--ink-500)", fontStyle: "italic" }}>
              {legend.note}
            </div>
          )}
        </>
      )}
    </div>
  );
}
