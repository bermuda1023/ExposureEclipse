/**
 * Floating summary for the live wildfire overlay: counts, degraded-layer
 * notes (e.g. FIRMS key missing), affected-state roll-up, and the largest
 * active burn areas. Row click selects the incident (highlights its
 * perimeter on the map). Shares the layer's query cache (same key).
 */

import { useQuery } from "@tanstack/react-query";
import { fetchLiveWildfire } from "../../api/wildfire";
import { useLiveWildfireStore } from "../../state/liveWildfire";

export function WildfirePanel() {
  const active = useLiveWildfireStore((s) => s.active);
  const selectedId = useLiveWildfireStore((s) => s.selectedIncidentId);
  const selectIncident = useLiveWildfireStore((s) => s.selectIncident);
  const setActive = useLiveWildfireStore((s) => s.setActive);

  const query = useQuery({
    queryKey: ["wildfire-live"],
    queryFn: () => fetchLiveWildfire({ includeHeat: true }),
    enabled: active,
    staleTime: 5 * 60_000,
  });

  if (!active) return null;

  const data = query.data;
  const top = data
    ? [...data.perimeters.features]
        .sort(
          (a, b) =>
            (b.properties.gisAcres ?? 0) - (a.properties.gisAcres ?? 0),
        )
        .slice(0, 8)
    : [];

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        width: 288,
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px",
          borderBottom: "1px solid var(--ink-100)",
        }}
      >
        <strong style={{ fontSize: "0.8rem" }}>🔥 Live wildfire</strong>
        <button
          type="button"
          onClick={() => setActive(false)}
          style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontWeight: 700 }}
          title="Close"
        >
          ✕
        </button>
      </div>

      <div style={{ padding: "8px 10px" }}>
        {query.isLoading && <div style={{ color: "var(--ink-500)" }}>Loading current fires…</div>}
        {query.isError && (
          <div style={{ color: "#b91c1c" }}>Couldn’t load live wildfire data.</div>
        )}

        {data && (
          <>
            <div style={{ color: "var(--ink-600)", marginBottom: 6 }}>
              <strong>{data.counts.perimeters}</strong> active perimeters ·{" "}
              <strong>{data.counts.activeFires}</strong> satellite detections
            </div>

            {data.notes.map((n) => (
              <div
                key={n}
                style={{
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  color: "#92400e",
                  borderRadius: 6,
                  padding: "5px 7px",
                  marginBottom: 6,
                  fontSize: "0.66rem",
                  lineHeight: 1.35,
                }}
              >
                {n}
              </div>
            ))}

            {data.affectedStates.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 700, color: "var(--ink-500)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>
                  Affected states
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {data.affectedStates.slice(0, 6).map((s) => (
                    <span
                      key={s.state}
                      style={{
                        background: "var(--ink-50)",
                        border: "1px solid var(--ink-200)",
                        borderRadius: 999,
                        padding: "1px 7px",
                        fontSize: "0.64rem",
                      }}
                      title={`${s.fireCount} fires · ${Math.round(s.acres).toLocaleString()} acres`}
                    >
                      {s.state} · {Math.round(s.acres).toLocaleString()} ac
                    </span>
                  ))}
                </div>
              </div>
            )}

            {top.length > 0 && (
              <div>
                <div style={{ fontWeight: 700, color: "var(--ink-500)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>
                  Largest active burn areas
                </div>
                {top.map((f) => {
                  const p = f.properties;
                  const on = selectedId === p.incidentId;
                  return (
                    <button
                      key={p.incidentId}
                      type="button"
                      onClick={() => selectIncident(on ? null : p.incidentId)}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "5px 7px",
                        marginBottom: 3,
                        borderRadius: 6,
                        background: on ? "#fff7ed" : "transparent",
                        border: `1px solid ${on ? "#fdba74" : "transparent"}`,
                      }}
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
              Perimeters: {data.attribution.perimeters}. Heat: {data.attribution.activeFires}.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
