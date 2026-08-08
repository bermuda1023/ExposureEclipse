/**
 * Control + summary for the live flood overlay. Severity floor, hide-exposures,
 * affected states, the active alert list, and — when alerts are selected — the
 * COMBINED exposed TIV by client across the selection, feedable into the XOL
 * layer calc.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchLiveFlood, fetchFloodExposure, fetchInundation, fetchInundationExposure,
  inundationBbox, SEVERITY_OPTIONS,
  type FloodAlertProps, type FloodSeverity,
} from "../../api/flood";
import { LayerCalc, formatTiv as tiv } from "./LayerCalc";
import { useLiveFloodStore } from "../../state/liveFlood";
import { useLiveWildfireStore } from "../../state/liveWildfire";

/** Must track the `severityRank` ramp in FloodLayer, low → high. */
const SEVERITY_SWATCH: [FloodSeverity, string][] = [
  ["Unknown", "#94a3b8"], ["Minor", "#38bdf8"], ["Moderate", "#0284c7"],
  ["Severe", "#1d4ed8"], ["Extreme", "#4c1d95"],
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

export function FloodPanel() {
  const s = useLiveFloodStore();
  // Both live-peril panels dock top-right; side-by-side beats stacking, since
  // an underwriter can legitimately want fire and flood on screen together.
  const wildfireActive = useLiveWildfireStore((w) => w.active);

  // Same queryKey as FloodLayer, so TanStack Query serves both from one fetch.
  const alertQuery = useQuery({
    queryKey: ["flood-alerts", s.minSeverity],
    queryFn: () => fetchLiveFlood({ minSeverity: s.minSeverity }),
    enabled: s.active,
    staleTime: 60_000,
    retry: 2,
  });

  const selIds = s.selectedAlerts.map((a) => a.id).sort().join("|");
  const exposure = useQuery({
    queryKey: ["flood-exposure", selIds],
    queryFn: () => fetchFloodExposure(
      s.selectedAlerts.map((a) => ({ id: a.id, name: a.name, geometry: a.geometry })),
    ),
    enabled: s.selectedAlerts.length > 0,
    staleTime: 5 * 60_000,
  });

  // The union is computed server-side so overlapping alerts (adjacent flood
  // warnings routinely share ground) count each location once.
  const combined = exposure.data?.combined;
  const ccy = exposure.data?.currency ?? "USD";

  // Same key as FloodLayer's inundation query, so the two share one fetch.
  const inBbox = inundationBbox(s.viewBbox);
  const inKey = inBbox?.join(",") ?? null;
  const tooWide = s.viewBbox !== null && inBbox === null;
  const inundation = useQuery({
    queryKey: ["flood-inundation", inKey],
    queryFn: () => fetchInundation(inBbox!),
    enabled: s.active && s.showInundation && inBbox !== null,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  // Opt-in, not automatic: it is a second round trip over the same view, and
  // the number is only meaningful when the extent is wide enough to sample.
  //
  // The consent is stored as the view it was given for, not as a boolean: a
  // bare flag stays true across a pan, and since the view is part of the query
  // key, each pan would silently re-fire a fetch-plus-ray-cast the underwriter
  // only asked for once.
  const [exposureFor, setExposureFor] = useState<string | null>(null);
  const wantInExposure = inKey !== null && exposureFor === inKey;
  const inExposure = useQuery({
    queryKey: ["flood-inundation-exposure", inKey],
    queryFn: () => fetchInundationExposure(inBbox!),
    enabled: s.active && s.showInundation && wantInExposure,
    staleTime: 10 * 60_000,
    // Unlike the extent, this route fails hard when the model is down (a zero
    // would feed the layer calc), so a retry only re-runs the same rollup.
    retry: 0,
  });

  if (!s.active) return null;
  const data = alertQuery.data;
  const alerts = data ? data.alerts.features : [];

  return (
    <div style={{
      position: "absolute", top: 12, right: wildfireActive ? 324 : 12, width: 304,
      maxHeight: "calc(100% - 24px)", overflowY: "auto",
      background: "var(--surface, #fff)", border: "1px solid var(--ink-200)",
      borderRadius: 10, boxShadow: "0 6px 24px rgba(0,0,0,0.14)",
      fontSize: "0.72rem", color: "var(--ink-700)", zIndex: 5,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: "1px solid var(--ink-100)" }}>
        <strong style={{ fontSize: "0.8rem" }}>🌊 Live flood</strong>
        <button type="button" onClick={s.toggle} style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontWeight: 700 }} title="Close">✕</button>
      </div>

      <div style={{ padding: "8px 10px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          <Toggle on={s.showAlerts} label="⬡ Alert areas" tint="#1d4ed8" onClick={() => s.setShowAlerts(!s.showAlerts)} />
          <Toggle on={s.showInundation} label="≈ Modelled water" tint="#0ea5e9" onClick={() => s.setShowInundation(!s.showInundation)} />
          <Toggle on={s.hideExposures} label={s.hideExposures ? "Exposures hidden" : "Hide exposures"} tint="#334155" onClick={() => s.setHideExposures(!s.hideExposures)} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ color: "var(--ink-500)", fontSize: "0.62rem" }}>Min severity:</span>
          {SEVERITY_OPTIONS.map((o) => (
            <button key={o} type="button" onClick={() => s.setMinSeverity(o as FloodSeverity)} style={{
              all: "unset", cursor: "pointer", padding: "1px 7px", borderRadius: 999,
              fontSize: "0.62rem", fontWeight: 600,
              color: s.minSeverity === o ? "white" : "var(--ink-600)",
              background: s.minSeverity === o ? "#1e3a8a" : "transparent",
              border: `1px solid ${s.minSeverity === o ? "#1e3a8a" : "var(--ink-300)"}`,
            }}>{o === "Unknown" ? "All" : o}</button>
          ))}
        </div>

        {/* Modelled water extent — outside the `data &&` block below so it still
            works when the alert feed is down; the two sources are independent. */}
        {s.showInundation && (
          <div style={{ border: "1px solid #bae6fd", background: "#f0f9ff", borderRadius: 8, padding: "7px 8px", marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: "0.68rem", marginBottom: 3 }}>≈ Modelled water (NWM)</div>
            {tooWide ? (
              <div style={{ color: "var(--ink-600)", fontSize: "0.64rem", lineHeight: 1.35 }}>
                Zoom in to load. The extent is modelled at river-reach resolution;
                over a wider view the upstream service truncates it, which would
                draw a partial extent as if it were all the water there is.
              </div>
            ) : inundation.isFetching ? (
              <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>Loading modelled extent…</div>
            ) : inundation.isError ? (
              <div style={{ color: "#b91c1c", fontSize: "0.64rem", lineHeight: 1.35 }}>
                Couldn’t load the modelled extent. Treat this as unknown, not as dry.
              </div>
            ) : inundation.data ? (
              <>
                <div style={{ color: "var(--ink-600)", marginBottom: 3 }}>
                  <strong>{inundation.data.counts.reaches}</strong> reach{inundation.data.counts.reaches === 1 ? "" : "es"} in view
                  {inundation.data.referenceTime && (
                    <span style={{ color: "var(--ink-500)" }}> · run {inundation.data.referenceTime}</span>
                  )}
                </div>
                {inundation.data.notes.map((n) => (
                  <div key={n} style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 6, padding: "4px 6px", marginBottom: 4, fontSize: "0.6rem", lineHeight: 1.35 }}>{n}</div>
                ))}
                {inundation.data.counts.reaches > 0 && !wantInExposure && (
                  <button type="button" onClick={() => setExposureFor(inKey)} style={{
                    all: "unset", cursor: "pointer", padding: "2px 8px", borderRadius: 999,
                    fontSize: "0.62rem", fontWeight: 600, color: "#075985", border: "1px solid #7dd3fc",
                  }}>Exposed TIV in this water</button>
                )}
                {wantInExposure && inExposure.isLoading && <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>Computing…</div>}
                {wantInExposure && inExposure.isError && (
                  <div style={{ color: "#b91c1c", fontSize: "0.64rem" }}>Couldn’t compute exposed TIV.</div>
                )}
                {inExposure.data && (
                  <>
                    {/* Ahead of the number, not after it: a mixed-currency
                        portfolio is reported as 0 (rule 5), and the warning is
                        the only thing separating that from "no exposure". */}
                    {inExposure.data.warnings.map((w) => (
                      <div key={w} style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 6, padding: "4px 6px", marginBottom: 4, fontSize: "0.6rem", lineHeight: 1.35 }}>{w}</div>
                    ))}
                    {inExposure.data.belowResolution ? (
                      // A bare $0 here reads as "no exposure". It is not: the
                      // extent is narrower than the synthetic locations are spaced.
                      <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 6, padding: "4px 6px", fontSize: "0.6rem", lineHeight: 1.35 }}>
                        Not measurable — the modelled channels are narrower than the
                        spacing of our synthetic locations, so this view can only
                        return zero. Use the alert areas for a bounded estimate.
                      </div>
                    ) : (
                      <>
                        <div style={{ marginBottom: 3 }}>
                          Exposed <strong>{tiv(inExposure.data.combined.totalTiv, inExposure.data.currency)}</strong>
                          <span style={{ color: "var(--ink-500)" }}> · {inExposure.data.combined.locationCount} locations</span>
                        </div>
                        {inExposure.data.combined.byClient.map((c) => (
                          <div key={c.client} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.66rem" }}>
                            <span>{c.client}</span><span style={{ fontWeight: 600 }}>{tiv(c.tiv, inExposure.data!.currency)}</span>
                          </div>
                        ))}
                        {inExposure.data.combined.totalTiv > 0 && (
                          <LayerCalc combinedTiv={inExposure.data.combined.totalTiv} currency={inExposure.data.currency} />
                        )}
                      </>
                    )}
                  </>
                )}
                <div style={{ marginTop: 4, color: "var(--ink-400)", fontSize: "0.58rem", lineHeight: 1.35 }}>
                  Source: {inundation.data.attribution.model}.
                </div>
              </>
            ) : (
              <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>Reading map view…</div>
            )}
          </div>
        )}

        {alertQuery.isFetching && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e40af", borderRadius: 6, padding: "5px 8px", marginBottom: 6, fontSize: "0.66rem" }}>
            <span style={{ width: 11, height: 11, border: "2px solid #bfdbfe", borderTopColor: "#1e40af", borderRadius: "50%", display: "inline-block", animation: "ee-spin 0.8s linear infinite" }} />
            Loading flood alerts…
            <style>{"@keyframes ee-spin{to{transform:rotate(360deg)}}"}</style>
          </div>
        )}
        {alertQuery.isError && <div style={{ color: "#b91c1c", marginBottom: 6 }}>Couldn’t load flood alerts — retrying…</div>}

        {data && (
          <>
            <div style={{ color: "var(--ink-600)", marginBottom: 6 }}>
              <strong>{data.counts.alerts}</strong> mappable alert{data.counts.alerts === 1 ? "" : "s"}
              {data.counts.zoneOnly > 0 && <> · <strong>{data.counts.zoneOnly}</strong> zone-only</>}
            </div>

            {s.showAlerts && (
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 6, fontSize: "0.58rem", color: "var(--ink-500)" }}>
                {SEVERITY_SWATCH.map(([label, color]) => (
                  <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 3 }} title={label}>
                    <span style={{ width: 11, height: 9, borderRadius: 2, background: color, border: "1px solid rgba(0,0,0,0.15)" }} />
                    {label.slice(0, 3)}
                  </span>
                ))}
              </div>
            )}

            {data.notes.map((n) => (
              <div key={n} style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 6, padding: "5px 7px", marginBottom: 6, fontSize: "0.64rem", lineHeight: 1.35 }}>{n}</div>
            ))}

            {/* Combined selection */}
            {s.selectedAlerts.length > 0 && (
              <div style={{ border: "1px solid #93c5fd", background: "#eff6ff", borderRadius: 8, padding: "7px 8px", marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                  <strong style={{ fontSize: "0.72rem" }}>💰 Combined — {s.selectedAlerts.length} alert{s.selectedAlerts.length > 1 ? "s" : ""}</strong>
                  <button type="button" onClick={s.clearAlerts} style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontSize: "0.62rem" }}>clear</button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                  {s.selectedAlerts.map((a) => (
                    <span key={a.id} onClick={() => s.toggleAlert(a)} style={{ cursor: "pointer", background: "white", border: "1px solid var(--ink-300)", borderRadius: 999, padding: "0 6px", fontSize: "0.6rem" }} title="Remove">
                      {a.name.length > 18 ? a.name.slice(0, 17) + "…" : a.name} ✕
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
                      ? <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>No exposure inside the selected alert(s).</div>
                      : combined.byClient.map((c) => (
                        <div key={c.client} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.66rem" }}>
                          <span>{c.client}</span><span style={{ fontWeight: 600 }}>{tiv(c.tiv, ccy)}</span>
                        </div>
                      ))}
                    {exposure.data.synthetic && (
                      <div style={{ marginTop: 4, color: "#92400e", fontSize: "0.58rem", lineHeight: 1.35 }}>
                        Estimated — synthetic locations from county aggregates (not location-level data).
                        Alert areas are warning polygons, not observed water, so this is an upper bound.
                      </div>
                    )}
                    {combined.totalTiv > 0 && <LayerCalc combinedTiv={combined.totalTiv} currency={ccy} />}
                  </>
                )}
              </div>
            )}

            {data.affectedStates.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 700, color: "var(--ink-500)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Affected states</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {data.affectedStates.slice(0, 8).map((st) => (
                    <span key={st.state} style={{ background: "var(--ink-50)", border: "1px solid var(--ink-200)", borderRadius: 999, padding: "1px 7px", fontSize: "0.64rem" }} title={`${st.alertCount} alerts`}>
                      {st.state} · {st.alertCount}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {alerts.length > 0 && (
              <div>
                <div style={{ fontWeight: 700, color: "var(--ink-500)", fontSize: "0.62rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>Active alerts</div>
                {alerts.slice(0, 12).map((f) => {
                  const p = f.properties as FloodAlertProps;
                  const on = s.selectedAlerts.some((x) => x.id === p.alertId);
                  return (
                    <button key={p.alertId} type="button"
                      onClick={() => s.toggleAlert({ id: p.alertId, name: p.event, severity: p.severity, geometry: f.geometry })}
                      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box", padding: "5px 7px", marginBottom: 3, borderRadius: 6, background: on ? "#eff6ff" : "transparent", border: `1px solid ${on ? "#93c5fd" : "transparent"}` }}>
                      <div style={{ fontWeight: 600 }}>{on ? "✓ " : ""}{p.event}</div>
                      <div style={{ color: "var(--ink-500)", fontSize: "0.64rem" }}>
                        {p.severity}{p.areaDesc ? ` · ${p.areaDesc.length > 44 ? p.areaDesc.slice(0, 43) + "…" : p.areaDesc}` : ""}
                      </div>
                    </button>
                  );
                })}
                {alerts.length > 12 && (
                  <div style={{ color: "var(--ink-400)", fontSize: "0.6rem" }}>
                    +{alerts.length - 12} more on the map
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--ink-100)", color: "var(--ink-400)", fontSize: "0.6rem", lineHeight: 1.4 }}>
              Click alert areas on the map to combine them. Source: {data.attribution.alerts}.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
