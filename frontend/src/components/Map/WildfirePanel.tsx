/**
 * Control + summary for the live wildfire overlay: three independent layer
 * toggles, a FIRMS day-window selector (up to 14d), a min-fire-size cleanup
 * selector, affected states, largest burn areas, and — when a fire is
 * selected — the exposed TIV by client inside that polygon.
 */

import { useQuery } from "@tanstack/react-query";
import {
  fetchLiveWildfire,
  fetchWildfireExposure,
  type WildfirePerimeterProps,
} from "../../api/wildfire";
import {
  useLiveWildfireStore, MIN_SIZE_PARAMS, type MinSize,
} from "../../state/liveWildfire";

const DAY_OPTIONS = [3, 7, 14];
const SIZE_OPTIONS: { id: MinSize; label: string }[] = [
  { id: "all", label: "All" },
  { id: "small", label: "Small+" },
  { id: "medium", label: "Med+" },
  { id: "large", label: "Large+" },
];

function tiv(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}bn`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

function Toggle({ on, label, tint, onClick }: { on: boolean; label: string; tint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      all: "unset", cursor: "pointer", padding: "2px 8px", borderRadius: 999,
      fontSize: "0.64rem", fontWeight: 600,
      color: on ? "white" : "var(--ink-600)",
      background: on ? tint : "transparent",
      border: `1px solid ${on ? tint : "var(--ink-300)"}`,
    }}>{label}</button>
  );
}

function Pills<T extends string | number>({ options, value, onPick, fmt }: {
  options: readonly T[]; value: T; onPick: (v: T) => void; fmt: (v: T) => string;
}) {
  return (
    <>
      {options.map((o) => (
        <button key={String(o)} type="button" onClick={() => onPick(o)} style={{
          all: "unset", cursor: "pointer", padding: "1px 7px", borderRadius: 999,
          fontSize: "0.62rem", fontWeight: 600,
          color: value === o ? "white" : "var(--ink-600)",
          background: value === o ? "#7c2d12" : "transparent",
          border: `1px solid ${value === o ? "#7c2d12" : "var(--ink-300)"}`,
        }}>{fmt(o)}</button>
      ))}
    </>
  );
}

export function WildfirePanel() {
  const s = useLiveWildfireStore();

  const query = useQuery({
    queryKey: ["wildfire-live", s.heatDays, s.minSize],
    queryFn: () => fetchLiveWildfire({ includeHeat: true, dayRange: s.heatDays, ...MIN_SIZE_PARAMS[s.minSize] }),
    enabled: s.active,
    staleTime: 5 * 60_000,
  });

  const sel = s.selectedFire;
  const exposure = useQuery({
    queryKey: ["wildfire-exposure", sel?.source, sel?.id],
    queryFn: () => fetchWildfireExposure([{ id: sel!.id, name: sel!.name, geometry: sel!.geometry }]),
    enabled: !!sel,
    staleTime: 5 * 60_000,
  });

  if (!s.active) return null;

  const data = query.data;
  const top = data
    ? [...data.perimeters.features].sort((a, b) => (b.properties.gisAcres ?? 0) - (a.properties.gisAcres ?? 0)).slice(0, 8)
    : [];
  const exp = exposure.data?.results[0];

  return (
    <div style={{
      position: "absolute", top: 12, right: 12, width: 300,
      maxHeight: "calc(100% - 24px)", overflowY: "auto",
      background: "var(--surface, #fff)", border: "1px solid var(--ink-200)",
      borderRadius: 10, boxShadow: "0 6px 24px rgba(0,0,0,0.14)",
      fontSize: "0.72rem", color: "var(--ink-700)", zIndex: 5,
    }}>
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

        {/* Heat window + cleanup */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ color: "var(--ink-500)", fontSize: "0.62rem" }}>Window:</span>
          <Pills options={DAY_OPTIONS} value={s.heatDays} onPick={s.setHeatDays} fmt={(d) => `${d}d`} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ color: "var(--ink-500)", fontSize: "0.62rem" }}>Min size:</span>
          <Pills options={SIZE_OPTIONS.map((o) => o.id)} value={s.minSize} onPick={(v) => s.setMinSize(v as MinSize)}
            fmt={(id) => SIZE_OPTIONS.find((o) => o.id === id)!.label} />
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
              <div key={n} style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 6, padding: "5px 7px", marginBottom: 6, fontSize: "0.64rem", lineHeight: 1.35 }}>{n}</div>
            ))}

            {/* Selected-fire exposure rollup */}
            {sel && (
              <div style={{ border: "1px solid #fdba74", background: "#fff7ed", borderRadius: 8, padding: "7px 8px", marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <strong style={{ fontSize: "0.72rem" }}>💰 Exposed TIV — {sel.name}</strong>
                  <button type="button" onClick={() => s.selectFire(null)} style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)" }} title="Clear selection">✕</button>
                </div>
                {exposure.isLoading && <div style={{ color: "var(--ink-500)" }}>Computing…</div>}
                {exp && (
                  <>
                    <div style={{ marginBottom: 4 }}>
                      Total <strong>{tiv(exp.totalTiv)}</strong>{" "}
                      <span style={{ color: "var(--ink-500)" }}>· {exp.locationCount} locations</span>
                    </div>
                    {exp.byClient.length === 0 ? (
                      <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>No exposure inside this perimeter.</div>
                    ) : (
                      exp.byClient.map((c) => (
                        <div key={c.client} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.66rem" }}>
                          <span>{c.client}</span>
                          <span style={{ fontWeight: 600 }}>{tiv(c.tiv)}</span>
                        </div>
                      ))
                    )}
                    {exposure.data?.synthetic && (
                      <div style={{ marginTop: 4, color: "#92400e", fontSize: "0.58rem", lineHeight: 1.35 }}>
                        Estimated — synthetic locations from county aggregates (not location-level data).
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

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
                  const p = f.properties as WildfirePerimeterProps;
                  const on = sel?.id === p.incidentId;
                  return (
                    <button key={p.incidentId} type="button"
                      onClick={() => s.selectFire(on ? null : {
                        id: p.incidentId, name: p.name, source: "perimeter",
                        geometry: f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon,
                      })}
                      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box", padding: "5px 7px", marginBottom: 3, borderRadius: 6, background: on ? "#fff7ed" : "transparent", border: `1px solid ${on ? "#fdba74" : "transparent"}` }}>
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
              Click any perimeter or heat shape to see exposed TIV by client. Perimeters: {data.attribution.perimeters}. Heat: {data.attribution.activeFires}.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
