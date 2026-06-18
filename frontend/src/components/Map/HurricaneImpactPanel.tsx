/**
 * Floating panel that summarises a hurricane-impact query — appears when the
 * user clicks a hurricane track segment. Shows total impacted counties +
 * total TIV in the current selection, plus a per-county breakdown ordered
 * by max wind speed.
 */

import { useState } from "react";
import { useHurricaneImpactStore } from "../../state/hurricaneImpact";
import { formatCount, formatMoneyCompact } from "../../lib/format";
import { SAFFIR_SIMPSON_COLORS, SAFFIR_SIMPSON_LABEL } from "./hurricaneColors";
import { downloadHurricaneImpactXlsx } from "../../api/hurricanes";

export function HurricaneImpactPanel() {
  const {
    activeStormId,
    data,
    isLoading,
    error,
    clear,
    selectionPayload,
    pushedToDetail,
    pushToDetail,
  } = useHurricaneImpactStore();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // When the impact has been pushed to the right-rail detail panel, hide the
  // floating panel — the detail view shows the same content + per-programme
  // breakdown.
  if (pushedToDetail) return null;

  async function onDownload() {
    if (!activeStormId || !selectionPayload) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadHurricaneImpactXlsx(activeStormId, selectionPayload);
    } catch (e) {
      setExportError(String((e as Error)?.message ?? e));
    } finally {
      setExporting(false);
    }
  }

  if (!activeStormId && !isLoading && !data && !error) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 14,
        left: 14,
        width: 340,
        maxHeight: "60%",
        zIndex: 7,
        background: "rgba(255,255,255,0.98)",
        border: "1px solid var(--ink-300)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        display: "grid",
        gridTemplateRows: "auto 1fr",
        overflow: "hidden",
        fontSize: "0.78rem",
      }}
    >
      <header
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--ink-200)",
          background: "var(--ink-50)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 6,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.66rem",
              color: "var(--ink-500)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Hurricane impact
          </div>
          <div style={{ fontWeight: 700, color: "var(--ink-900)", marginTop: 2 }}>
            {data ? `${data.stormName} (${data.year})` : activeStormId}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={pushToDetail}
            disabled={!data}
            title="Open this impact in the right-rail detail panel (with per-programme breakdown)"
            style={{
              all: "unset",
              cursor: data ? "pointer" : "not-allowed",
              color: "var(--brand-700)",
              fontWeight: 600,
              fontSize: "0.7rem",
              padding: "2px 6px",
              border: "1px solid var(--brand-400)",
              borderRadius: 4,
              opacity: data ? 1 : 0.4,
            }}
          >
            → detail
          </button>
          <button
            onClick={onDownload}
            disabled={!data || exporting}
            title="Download impact summary as Excel"
            style={{
              all: "unset",
              cursor: data && !exporting ? "pointer" : "not-allowed",
              color: "var(--brand-700)",
              fontWeight: 600,
              fontSize: "0.7rem",
              padding: "2px 6px",
              border: "1px solid var(--brand-400)",
              borderRadius: 4,
              opacity: data && !exporting ? 1 : 0.4,
            }}
          >
            {exporting ? "…" : "↓ xlsx"}
          </button>
          <button
            onClick={clear}
            aria-label="Close impact panel"
            style={{
              all: "unset",
              cursor: "pointer",
              color: "var(--ink-500)",
              fontSize: "1.1rem",
              padding: "0 4px",
            }}
            title="Clear hurricane impact selection"
          >
            ✕
          </button>
        </div>
      </header>

      <div style={{ overflow: "auto", padding: 12, display: "grid", gap: 10, alignContent: "start" }}>
        {isLoading && <div style={{ color: "var(--ink-500)" }}>Computing wind-field impact…</div>}
        {error && (
          <div style={{ color: "var(--error-700)" }}>
            <strong>Impact lookup failed:</strong> {error}
          </div>
        )}
        {exportError && (
          <div style={{ color: "var(--error-700)", fontSize: "0.72rem" }}>
            Export failed: {exportError}
          </div>
        )}
        {data && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                padding: 10,
                background: "var(--brand-50)",
                border: "1px solid var(--brand-400)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <Stat label="Counties impacted" value={String(data.summary.countiesImpacted)} />
              <Stat
                label="Total TIV (your selection)"
                value={formatMoneyCompact(data.summary.totalTiv, data.currency)}
              />
              <Stat
                label="With TIV data"
                value={`${data.summary.countiesWithData} / ${data.summary.countiesImpacted}`}
              />
              <Stat
                label="Total locations"
                value={formatCount(data.summary.totalLocationCount)}
              />
            </div>
            {data.footprint.length > 0 && (
              <RmaxSourceLine footprint={data.footprint} />
            )}

            <div
              style={{
                fontSize: "0.66rem",
                color: "var(--ink-500)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 700,
                marginTop: 2,
              }}
            >
              Per-county breakdown (top by wind)
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.74rem" }}>
              <thead>
                <tr style={{ color: "var(--ink-500)", textAlign: "left" }}>
                  <th style={th}>County</th>
                  <th style={{ ...th, textAlign: "center" }}>Wind</th>
                  <th style={{ ...th, textAlign: "right" }}>TIV</th>
                </tr>
              </thead>
              <tbody>
                {data.counties.slice(0, 60).map((c) => (
                  <tr
                    key={c.geographyId}
                    style={{
                      borderTop: "1px solid var(--ink-200)",
                      background: c.hasData ? "var(--brand-50)" : undefined,
                    }}
                  >
                    <td style={td}>
                      <div style={{ fontWeight: c.hasData ? 600 : 400, color: "var(--ink-900)" }}>
                        {c.name} <span style={{ color: "var(--ink-500)" }}>· {c.state}</span>
                      </div>
                      <div style={{ fontSize: "0.66rem", color: "var(--ink-500)" }}>
                        eye {c.closestDistanceNm.toFixed(1)} nm · Rmax {c.rmaxAtClosestNm.toFixed(0)} nm
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "2px 7px",
                          borderRadius: 999,
                          background: SAFFIR_SIMPSON_COLORS[c.maxCategory] ?? "var(--ink-300)",
                          color: c.maxCategory >= 3 ? "white" : "var(--ink-900)",
                          fontWeight: 600,
                          fontSize: "0.66rem",
                          whiteSpace: "nowrap",
                        }}
                        title={SAFFIR_SIMPSON_LABEL[c.maxCategory] ?? ""}
                      >
                        {c.maxWindKt} kt
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: "right", color: c.hasData ? "var(--ink-900)" : "var(--ink-400)" }}>
                      {c.hasData ? formatMoneyCompact(c.tiv, data.currency) : "—"}
                      <div style={{ fontSize: "0.58rem", color: "var(--ink-500)", fontWeight: 400 }}>
                        Rmax {c.rmaxAtClosestNm.toFixed(0)}nm ·{" "}
                        <SourceTag source={c.rmaxSource} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.counties.length > 60 && (
              <div style={{ fontSize: "0.7rem", color: "var(--ink-500)" }}>
                Showing top 60 of {data.counties.length} impacted counties.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: "0.62rem",
          color: "var(--brand-700)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div style={{ fontWeight: 700, color: "var(--ink-900)", marginTop: 1 }}>{value}</div>
    </div>
  );
}

function SourceTag({ source }: { source: "ibtracs" | "willoughby" }) {
  const isIbt = source === "ibtracs";
  return (
    <span
      title={
        isIbt
          ? "IBTrACS: NOAA recon-measured radius of maximum winds at this fix"
          : "Willoughby (2006) parametric estimate — IBTrACS had no recon measurement for this fix"
      }
      style={{
        fontWeight: 700,
        color: isIbt ? "#066c2f" : "#7d5400",
      }}
    >
      {isIbt ? "IBTrACS" : "Willoughby est."}
    </span>
  );
}

function RmaxSourceLine({
  footprint,
}: {
  footprint: import("../../api/hurricanes").FootprintPoint[];
}) {
  const ibt = footprint.filter((f) => f.rmaxSource === "ibtracs").length;
  const total = footprint.length;
  const pct = total === 0 ? 0 : Math.round((ibt / total) * 100);
  return (
    <div
      style={{
        fontSize: "0.66rem",
        color: "var(--ink-600)",
        textAlign: "center",
        padding: "4px 0 0",
      }}
      title="Recon-measured Rmax (IBTrACS) takes priority; Willoughby (2006) parametric estimate fills the gaps."
    >
      Rmax source: <strong style={{ color: "#066c2f" }}>{ibt}</strong> /{" "}
      {total} ({pct}%) recon-measured
    </div>
  );
}

const th: React.CSSProperties = {
  fontWeight: 600,
  padding: "3px 6px",
  fontSize: "0.66rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const td: React.CSSProperties = { padding: "5px 6px" };
