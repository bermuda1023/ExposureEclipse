/**
 * Floating control + summary for the live wildfire overlay: three independent
 * layer toggles (perimeters / heat shapes / heat points), a FIRMS day-window
 * selector, degraded-layer notes, affected-state roll-up, and the largest
 * active burn areas. Shares the layer's query cache (same key).
 */

import { useQuery } from "@tanstack/react-query";
import { fetchLiveWildfire } from "../../api/wildfire";
import { useLiveWildfireStore } from "../../state/liveWildfire";

const DAY_OPTIONS = [1, 3, 5];

function Toggle({ on, label, tint, onClick }: { on: boolean; label: string; tint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: "0.64rem",
        fontWeight: 600,
        color: on ? "white" : "var(--ink-600)",
        background: on ? tint : "transparent",
        border: `1px solid ${on ? tint : "var(--ink-300)"}`,
      }}
    >
      {label}
    </button>
  );
}

export function WildfirePanel() {
  const s = useLiveWildfireStore();

  const query = useQuery({
    queryKey: ["wildfire-live", s.heatDays],
    queryFn: () => fetchLiveWildfire({ includeHeat: true, dayRange: s.heatDays }),
    enabled: s.active,
    staleTime: 5 * 60_000,
  });

  if (!s.active) return null;

  const data = query.data;
  const top = data
    ? [...data.perimeters.features]
        .sort((a, b) => (b.properties.gisAcres ?? 0) - (a.properties.gisAcres ?? 0))
        .slice(0, 8)
    : [];

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        width: 296,
        maxHeight: "calc(100% - 24px)",
        overflowY: "auto",
        background: "var(--surface, #fff)",
        border: "1px solid var(--ink-200)",
        borderRadius: 10,
        boxShadow: "0 6px 24px rgba(0,0,0,0.14)",
        fontSize: "0.72rem",
        color: "var(--ink-700)",
        zIndex: 5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid var(--ink-100)" }}>
        <strong style={{ fontSize: "0.8rem" }}>🔥 Live wildfire</strong>
        <button type="button" onClick={() => s.setActive(false)} style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontWeight: 700 }} title="Close">✕</button>
      </div>

      <div style={{ padding: "8px 10px" }}>
        {/* Layer toggles */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          <Toggle on={s.showPerimeters} label="⬡ Perimeters" tint="#ea580c" onClick={() => s.setShowPerimeters(!s.showPerimeters)} />
          <Toggle on={s.showHeatShapes} label="◇ Heat shapes" tint="#b91c1c" onClick={() => s.setShowHeatShapes(!s.showHeatShapes)} />
          <Toggle on={s.showHeat} label="🛰 Heat points" tint="#dc2626" onClick={() => s.setShowHeat(!s.showHeat)} />
        </div>

        {/* FIRMS day window */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>Heat window:</span>
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => s.setHeatDays(d)}
              style={{
                all: "unset",
                cursor: "pointer",
                padding: "1px 7px",
                borderRadius: 999,
                fontSize: "0.62rem",
                fontWeight: 600,
                color: s.heatDays === d ? "white" : "var(--ink-600)",
                background: s.heatDays === d ? "#7c2d12" : "transparent",
                border: `1px solid ${s.heatDays === d ? "#7c2d12" : "var(--ink-300)"}`,
              }}
              title={`Cluster FIRMS detections over the last ${d} day(s)`}
            >
              {d}d
            </button>
          ))}
        </div>

        {query.isLoading && <div style={{ color: "var(--ink-500)" }}>Loading current fires…</div>}
        {query.isError && <div style={{ color: "#b91c1c" }}>Couldn’t load live wildfire data.</div>}

        {data && (
          <>
            <div style={{ color: "var(--ink-600)", marginBottom: 6 }}>
              <strong>{data.counts.perimeters}</strong> perimeters ·{" "}
              <strong>{data.counts.heatShapes}</strong> heat shapes ·{" "}
              <strong>{data.counts.activeFiresTotal.toLocaleString()}</strong> detections
              <span style={{ color: "var(--ink-400)" }}> ({s.heatDays}d)</span>
            </div>

            {data.notes.map((n) => (
              <div key={n} style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 6, padding: "5px 7px", marginBottom: 6, fontSize: "0.64rem", lineHeight: 1.35 }}>
                {n}
              </div>
            ))}

            {data.affectedStates.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 700, color: "var(--ink-500)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Affected states</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {data.affectedStates.slice(0, 6).map((st) => (
                    <span key={st.state} style={{ background: "var(--ink-50)", border: "1px solid var(--ink-200)", borderRadius: 999, padding: "1px 7px", fontSize: "0.64rem" }} title={`${st.fireCount} fires · ${Math.round(st.acres).toLocaleString()} acres`}>
                      {st.state} · {Math.round(st.acres).toLocaleString()} ac
                    </span>
                  ))}
                </div>
              </div>
            )}

            {top.length > 0 && (
              <div>
                <div style={{ fontWeight: 700, color: "var(--ink-500)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Largest active burn areas</div>
                {top.map((f) => {
                  const p = f.properties;
                  const on = s.selectedIncidentId === p.incidentId;
                  return (
                    <button
                      key={p.incidentId}
                      type="button"
                      onClick={() => s.selectIncident(on ? null : p.incidentId)}
                      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box", padding: "5px 7px", marginBottom: 3, borderRadius: 6, background: on ? "#fff7ed" : "transparent", border: `1px solid ${on ? "#fdba74" : "transparent"}` }}
                    >
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>
                        {p.gisAcres != null ? `${Math.round(p.gisAcres).toLocaleString()} ac` : "—"}
                        {" · "}
                        {p.percentContained != null ? `${p.percentContained}% contained` : "containment n/a"}
                        {p.state ? ` · ${p.state}` : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--ink-100)", color: "var(--ink-400)", fontSize: "0.6rem", lineHeight: 1.4 }}>
              Perimeters: {data.attribution.perimeters}. Heat: {data.attribution.activeFires}. Heat shapes are clustered from FIRMS detections.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
