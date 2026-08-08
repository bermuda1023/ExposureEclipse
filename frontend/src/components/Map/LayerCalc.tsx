/**
 * XOL layer-calc strip shared by the live-peril panels (wildfire, flood).
 * Takes a combined exposed TIV and runs it through a deductible/limit/share
 * stack via POST /api/calc/layers, showing ceded loss across the default
 * damage-ratio sweep.
 */

import { useState } from "react";
import { runLayerCalc, type LayerCalcResponse } from "../../api/calc";

/** Rule 5: currency rides on every monetary value — never assume USD. */
export function formatTiv(n: number, ccy: string): string {
  const v = n >= 1e9 ? `${(n / 1e9).toFixed(2)}bn`
    : n >= 1e6 ? `${(n / 1e6).toFixed(1)}m`
    : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k`
    : `${Math.round(n)}`;
  return `${ccy} ${v}`;
}

interface LayerRow { deductible: number; limit: number; share: number; }

export function LayerCalc({ combinedTiv, currency }: { combinedTiv: number; currency: string }) {
  const [layers, setLayers] = useState<LayerRow[]>([{ deductible: 0, limit: 500_000_000, share: 1 }]);
  const [result, setResult] = useState<LayerCalcResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upd = (i: number, k: keyof LayerRow, v: number) =>
    setLayers((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  async function run() {
    setRunning(true); setErr(null);
    try {
      const r = await runLayerCalc({
        layers: layers.map((l, i) => ({ ...l, name: `Layer ${i + 1}` })),
        sweepTiv: combinedTiv,
      });
      setResult(r);
    } catch (e) {
      setErr((e as Error)?.message ?? "calc failed");
    } finally { setRunning(false); }
  }

  const numStyle: React.CSSProperties = {
    width: 62, fontSize: "0.62rem", padding: "1px 3px",
    border: "1px solid var(--ink-300)", borderRadius: 4,
  };

  return (
    <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed var(--ink-200)" }}>
      <div style={{ fontWeight: 700, color: "var(--ink-600)", fontSize: "0.64rem", marginBottom: 4 }}>
        Layer calc (XOL) on {formatTiv(combinedTiv, currency)}
      </div>
      {layers.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 3, fontSize: "0.6rem" }}>
          <span style={{ color: "var(--ink-500)" }}>xs</span>
          <input type="number" style={numStyle} value={l.deductible} onChange={(e) => upd(i, "deductible", +e.target.value)} title="Deductible / attachment" />
          <span style={{ color: "var(--ink-500)" }}>lim</span>
          <input type="number" style={numStyle} value={l.limit} onChange={(e) => upd(i, "limit", +e.target.value)} title="Limit" />
          <span style={{ color: "var(--ink-500)" }}>shr</span>
          <input type="number" step="0.05" min="0" max="1" style={{ ...numStyle, width: 44 }} value={l.share} onChange={(e) => upd(i, "share", +e.target.value)} title="Share 0-1" />
          {layers.length > 1 && (
            <button type="button" onClick={() => setLayers((ls) => ls.filter((_, j) => j !== i))} style={{ all: "unset", cursor: "pointer", color: "var(--ink-400)" }}>✕</button>
          )}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, marginBottom: 4 }}>
        <button type="button" onClick={() => setLayers((ls) => [...ls, { deductible: ls.at(-1)!.deductible + ls.at(-1)!.limit, limit: 500_000_000, share: 1 }])}
          style={{ all: "unset", cursor: "pointer", fontSize: "0.6rem", color: "var(--brand-600, #0369a1)" }}>+ layer</button>
        <button type="button" onClick={run} disabled={running}
          style={{ all: "unset", cursor: "pointer", fontSize: "0.62rem", fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "var(--brand-500, #0284c7)", color: "white" }}>
          {running ? "Running…" : "Run layer calc"}
        </button>
      </div>
      {err && <div style={{ color: "#b91c1c", fontSize: "0.6rem" }}>{err}</div>}
      {result && (
        <div style={{ fontSize: "0.6rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--ink-500)", fontWeight: 700 }}>
            <span>Damage ratio</span><span>Ceded loss</span>
          </div>
          {result.scenarios.map((sc) => (
            <div key={sc.label} style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{sc.damageRatio != null ? `${(sc.damageRatio * 100).toFixed(0)}%` : sc.label}</span>
              <span style={{ fontWeight: 600 }}>{formatTiv(sc.totalCeded, currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
