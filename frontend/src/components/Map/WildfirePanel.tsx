/**
 * Control + summary for the live wildfire overlay. Layer toggles, hide-
 * exposures, FIRMS day window (up to 30d) + min-size cleanup, affected states,
 * largest burn areas, and — when fires are selected — the COMBINED exposed TIV
 * by client across the selection, feedable into the XOL layer calc.
 */

import { useQuery } from "@tanstack/react-query";
import {
  fetchLiveWildfire, fetchWildfireExposure, type WildfirePerimeterProps,
} from "../../api/wildfire";
import { LayerCalc, formatTiv as tiv } from "./LayerCalc";
import {
  useLiveWildfireStore, MIN_SIZE_PARAMS, type MinSize,
} from "../../state/liveWildfire";

const DAY_OPTIONS = [3, 7, 14, 30];
const SIZE_OPTIONS: { id: MinSize; label: string }[] = [
  { id: "all", label: "All" }, { id: "small", label: "Small+" },
  { id: "medium", label: "Med+" }, { id: "large", label: "Large+" },
];

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

  const perimQuery = useQuery({
    queryKey: ["wildfire-perimeters"],
    queryFn: () => fetchLiveWildfire({ includeHeat: false, includePerimeters: true }),
    enabled: s.active,
    staleTime: 10 * 60_000,
    retry: 2,
  });
  const heatOn = s.showHeat || s.showHeatShapes;
  const heatQuery = useQuery({
    queryKey: ["wildfire-heat", s.heatDays, s.minSize],
    queryFn: () => fetchLiveWildfire({ includeHeat: true, includePerimeters: false, dayRange: s.heatDays, ...MIN_SIZE_PARAMS[s.minSize] }),
    enabled: s.active && heatOn,
    staleTime: 5 * 60_000,
  });

  const selIds = s.selectedFires.map((f) => f.id).sort().join("|");
  const exposure = useQuery({
    queryKey: ["wildfire-exposure", selIds],
    queryFn: () => fetchWildfireExposure(s.selectedFires.map((f) => ({ id: f.id, name: f.name, geometry: f.geometry }))),
    enabled: s.selectedFires.length > 0,
    staleTime: 5 * 60_000,
  });

  // The union is computed server-side so overlapping selections (an official
  // perimeter plus the heat shape over the same fire) count each location once.
  const combined = exposure.data?.combined;
  const ccy = exposure.data?.currency ?? "USD";

  if (!s.active) return null;
  const perim = perimQuery.data;
  const heat = heatQuery.data;
  const notes = [...(perim?.notes ?? []), ...(heat?.notes ?? [])];
  const top = perim
    ? [...perim.perimeters.features].sort((a, b) => (b.properties.gisAcres ?? 0) - (a.properties.gisAcres ?? 0)).slice(0, 8)
    : [];
  const perimLoading = perimQuery.isLoading;
  const heatLoading = heatOn && heatQuery.isFetching;

  return (
    <div style={{
      position: "absolute", top: 12, right: 12, width: 304,
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
          <Toggle on={s.showPerimeters} label="⬡ Perimeters" tint="#ea580c" onClick={() => s.setShowPerimeters(!s.showPerimeters)} />
          <Toggle on={s.showHeatShapes} label="◇ Heat shapes" tint="#b91c1c" onClick={() => s.setShowHeatShapes(!s.showHeatShapes)} />
          <Toggle on={s.showHeat} label="🛰 Heat points" tint="#dc2626" onClick={() => s.setShowHeat(!s.showHeat)} />
        </div>
        <div style={{ marginBottom: 6 }}>
          <Toggle on={s.hideExposures} label={s.hideExposures ? "Exposures hidden" : "Hide exposures"} tint="#334155" onClick={() => s.setHideExposures(!s.hideExposures)} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ color: "var(--ink-500)", fontSize: "0.62rem" }}>Window:</span>
          <Pills options={DAY_OPTIONS} value={s.heatDays} onPick={s.setHeatDays} fmt={(d) => `${d}d`} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ color: "var(--ink-500)", fontSize: "0.62rem" }}>Min size:</span>
          <Pills options={SIZE_OPTIONS.map((o) => o.id)} value={s.minSize} onPick={(v) => s.setMinSize(v as MinSize)}
            fmt={(id) => SIZE_OPTIONS.find((o) => o.id === id)!.label} />
        </div>

        {(perimLoading || heatLoading) && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af", borderRadius: 6, padding: "5px 8px", marginBottom: 6, fontSize: "0.66rem" }}>
            <span className="ee-spin" style={{ width: 11, height: 11, border: "2px solid #bfdbfe", borderTopColor: "#1e40af", borderRadius: "50%", display: "inline-block", animation: "ee-spin 0.8s linear infinite" }} />
            {perimLoading ? "Loading fire perimeters…" : `Loading satellite heat (${s.heatDays}d)…`}
            <style>{"@keyframes ee-spin{to{transform:rotate(360deg)}}"}</style>
          </div>
        )}
        {perimQuery.isError && <div style={{ color: "#b91c1c", marginBottom: 6 }}>Couldn’t load perimeters — retrying…</div>}

        {(perim || heat) && (
          <>
            <div style={{ color: "var(--ink-600)", marginBottom: 6 }}>
              <strong>{perim ? perim.counts.perimeters : "…"}</strong> perimeters ·{" "}
              <strong>{heat ? heat.counts.heatShapes : (heatOn ? "…" : "—")}</strong> heat shapes ·{" "}
              <strong>{heat ? heat.counts.activeFiresTotal.toLocaleString() : (heatOn ? "…" : "—")}</strong> detections
              <span style={{ color: "var(--ink-400)" }}> ({s.heatDays}d)</span>
            </div>

            {notes.map((n) => (
              <div key={n} style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 6, padding: "5px 7px", marginBottom: 6, fontSize: "0.64rem", lineHeight: 1.35 }}>{n}</div>
            ))}

            {/* Combined selection */}
            {s.selectedFires.length > 0 && (
              <div style={{ border: "1px solid #fdba74", background: "#fff7ed", borderRadius: 8, padding: "7px 8px", marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <strong style={{ fontSize: "0.72rem" }}>💰 Combined — {s.selectedFires.length} fire{s.selectedFires.length > 1 ? "s" : ""}</strong>
                  <button type="button" onClick={s.clearFires} style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontSize: "0.62rem" }}>clear</button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                  {s.selectedFires.map((f) => (
                    <span key={f.id} onClick={() => s.toggleFire(f)} style={{ cursor: "pointer", background: "white", border: "1px solid var(--ink-300)", borderRadius: 999, padding: "0 6px", fontSize: "0.6rem" }} title="Remove">
                      {f.source === "heat" ? "◇" : "⬡"} {f.name.length > 16 ? f.name.slice(0, 15) + "…" : f.name} ✕
                    </span>
                  ))}
                </div>
                {exposure.isLoading && <div style={{ color: "var(--ink-500)" }}>Computing…</div>}
                {exposure.isError && <div style={{ color: "#b91c1c", fontSize: "0.64rem" }}>Couldn’t compute exposed TIV.</div>}
                {exposure.data && combined && (
                  <>
                    {exposure.data.warnings.map((w) => (
                      <div key={w} style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 6, padding: "4px 6px", marginBottom: 4, fontSize: "0.6rem", lineHeight: 1.35 }}>{w}</div>
                    ))}
                    <div style={{ marginBottom: 3 }}>Total exposed <strong>{tiv(combined.totalTiv, ccy)}</strong> <span style={{ color: "var(--ink-500)" }}>· {combined.locationCount} locations</span></div>
                    {combined.byClient.length === 0
                      ? <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>No exposure inside the selected fire(s).</div>
                      : combined.byClient.map((c) => (
                        <div key={c.client} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.66rem" }}>
                          <span>{c.client}</span><span style={{ fontWeight: 600 }}>{tiv(c.tiv, ccy)}</span>
                        </div>
                      ))}
                    {exposure.data.synthetic && (
                      <div style={{ marginTop: 4, color: "#92400e", fontSize: "0.58rem", lineHeight: 1.35 }}>
                        Estimated — synthetic locations from county aggregates (not location-level data).
                        Max across perils at county grain.
                      </div>
                    )}
                    {combined.totalTiv > 0 && <LayerCalc combinedTiv={combined.totalTiv} currency={ccy} />}
                  </>
                )}
              </div>
            )}

            {perim && perim.affectedStates.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 700, color: "var(--ink-500)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Affected states</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {perim.affectedStates.slice(0, 6).map((st) => (
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
                  const on = s.selectedFires.some((x) => x.id === p.incidentId);
                  return (
                    <button key={p.incidentId} type="button"
                      onClick={() => s.toggleFire({ id: p.incidentId, name: p.name, source: "perimeter", geometry: f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon })}
                      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box", padding: "5px 7px", marginBottom: 3, borderRadius: 6, background: on ? "#fff7ed" : "transparent", border: `1px solid ${on ? "#fdba74" : "transparent"}` }}>
                      <div style={{ fontWeight: 600 }}>{on ? "✓ " : ""}{p.name}</div>
                      <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>
                        {p.gisAcres != null ? `${Math.round(p.gisAcres).toLocaleString()} ac` : "—"}
                        {" · "}{p.percentContained != null ? `${p.percentContained}% contained` : "containment n/a"}
                        {p.state ? ` · ${p.state}` : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--ink-100)", color: "var(--ink-400)", fontSize: "0.6rem", lineHeight: 1.4 }}>
              Click perimeters/heat shapes to combine them.{perim ? ` Perimeters: ${perim.attribution.perimeters}.` : ""}{heat ? ` Heat: ${heat.attribution.activeFires}.` : ""}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
