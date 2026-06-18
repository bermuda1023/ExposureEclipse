/**
 * Right-rail detail view for an active hurricane impact. Same county table as
 * the floating panel, but each row is expandable to show which programmes
 * contributed TIV (per-deal sense-check after a storm scenario).
 *
 * Toggled on by the floating panel's "→ detail" button; clearing the impact
 * (✕) or hitting "Back to floating" restores the regular detail view.
 */

import { useMemo, useState } from "react";
import { useCedents } from "../../api/hooks";
import { useHurricaneImpactStore } from "../../state/hurricaneImpact";
import { formatCount, formatMoneyCompact } from "../../lib/format";
import { SAFFIR_SIMPSON_COLORS, SAFFIR_SIMPSON_LABEL } from "../Map/hurricaneColors";
import { CountyReferenceSection } from "./CountyReferenceSection";

export function HurricaneImpactDetail() {
  const { data, clear, popFromDetail, setFocusedGeoid } = useHurricaneImpactStore();
  const focusedGeoid = useHurricaneImpactStore((s) => s.focusedGeoid);
  const cedents = useCedents();
  const [openGeoid, setOpenGeoid] = useState<string | null>(null);

  // dataset_id → human-friendly programme label.
  const programmeLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cedents.data?.cedents ?? []) {
      for (const ch of c.chains) {
        for (const p of ch.programmes) {
          m.set(
            p.datasetId,
            `${c.cedentName} · ${ch.chainName} · ${p.treatyYear}`,
          );
        }
      }
    }
    return m;
  }, [cedents.data]);

  if (!data) return null;

  return (
    <div style={{ display: "grid", gap: 10, fontSize: "0.78rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div style={{ fontSize: "0.66rem", color: "var(--ink-500)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Hurricane impact · detail view
          </div>
          <h3 style={{ margin: "2px 0 0", fontSize: "0.95rem" }}>
            {data.stormName} ({data.year})
          </h3>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={popFromDetail}
            title="Restore floating panel"
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "2px 8px",
              borderRadius: 4,
              border: "1px solid var(--ink-300)",
              fontSize: "0.7rem",
              color: "var(--ink-700)",
              fontWeight: 600,
            }}
          >
            ↩ float
          </button>
          <button
            onClick={clear}
            aria-label="Clear hurricane impact"
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "0 6px",
              color: "var(--ink-500)",
              fontSize: "1.1rem",
            }}
          >
            ✕
          </button>
        </div>
      </header>

      <section
        style={{
          padding: 10,
          background: "var(--brand-50)",
          border: "1px solid var(--brand-400)",
          borderRadius: "var(--radius-sm)",
          display: "grid",
          gap: 6,
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <Stat label="Counties impacted" value={String(data.summary.countiesImpacted)} />
          <Stat
            label="Total TIV (your scope)"
            value={formatMoneyCompact(data.summary.totalTiv, data.currency)}
          />
          <Stat
            label="With portfolio data"
            value={`${data.summary.countiesWithData} / ${data.summary.countiesImpacted}`}
          />
          <Stat
            label="Total locations"
            value={formatCount(data.summary.totalLocationCount)}
          />
        </div>
        <div style={{ fontSize: "0.66rem", color: "var(--ink-600)" }}>
          Rmax multiplier {data.multiplier}× — counties exposed to ≥ 85 kt sustained winds.
        </div>
      </section>

      <div style={{ display: "grid", gap: 4 }}>
        <div
          style={{
            fontSize: "0.66rem",
            color: "var(--ink-500)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontWeight: 700,
            marginBottom: 4,
          }}
        >
          Counties (click ▸ to expand by programme)
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.74rem" }}>
          <thead>
            <tr style={{ color: "var(--ink-500)", textAlign: "left" }}>
              <th style={th}></th>
              <th style={th}>County</th>
              <th style={{ ...th, textAlign: "center" }}>Wind</th>
              <th style={{ ...th, textAlign: "right" }}>TIV</th>
            </tr>
          </thead>
          <tbody>
            {data.counties.map((c) => {
              const isOpen = openGeoid === c.geoid;
              const isFocused = focusedGeoid === c.geoid;
              return (
                <FragmentRow
                  key={c.geoid}
                  county={c}
                  isOpen={isOpen}
                  isFocused={isFocused}
                  toggle={() => {
                    // Single click both expands the per-programme breakdown
                    // AND tells the map which county to spotlight. Toggling
                    // the same row off clears both.
                    if (isOpen) {
                      setOpenGeoid(null);
                      setFocusedGeoid(null);
                    } else {
                      setOpenGeoid(c.geoid);
                      setFocusedGeoid(c.geoid);
                    }
                  }}
                  currency={data.currency}
                  programmeLabel={programmeLabel}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      {openGeoid && (
        <CountyReferenceSection
          geographyId={
            data.counties.find((c) => c.geoid === openGeoid)?.geographyId ?? null
          }
        />
      )}
    </div>
  );
}

function FragmentRow({
  county: c,
  isOpen,
  isFocused,
  toggle,
  currency,
  programmeLabel,
}: {
  county: import("../../api/hurricanes").ImpactedCounty;
  isOpen: boolean;
  isFocused: boolean;
  toggle: () => void;
  currency: string;
  programmeLabel: Map<string, string>;
}) {
  return (
    <>
      <tr
        style={{
          borderTop: "1px solid var(--ink-200)",
          background: isFocused
            ? "#fef3c7"
            : c.hasData
              ? "var(--brand-50)"
              : undefined,
          boxShadow: isFocused ? "inset 3px 0 0 #f59e0b" : undefined,
          cursor: "pointer",
        }}
        onClick={toggle}
      >
        <td style={{ ...td, width: 16, color: "var(--ink-500)" }}>{isOpen ? "▾" : "▸"}</td>
        <td style={td}>
          <div style={{ fontWeight: c.hasData ? 600 : 400, color: "var(--ink-900)" }}>
            {c.name} <span style={{ color: "var(--ink-500)" }}>· {c.state}</span>
          </div>
          <div style={{ fontSize: "0.66rem", color: "var(--ink-500)" }}>
            eye {c.closestDistanceNm.toFixed(1)} nm · Rmax {c.rmaxAtClosestNm.toFixed(0)} nm{" "}
            <span
              title={
                c.rmaxSource === "ibtracs"
                  ? "IBTrACS recon-measured Rmax at closest approach"
                  : "Willoughby (2006) parametric estimate"
              }
              style={{
                fontWeight: 700,
                color: c.rmaxSource === "ibtracs" ? "#066c2f" : "#7d5400",
              }}
            >
              ({c.rmaxSource === "ibtracs" ? "IBTrACS" : "Willoughby est."})
            </span>
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
          {c.hasData ? formatMoneyCompact(c.tiv, currency) : "—"}
        </td>
      </tr>
      {isOpen && (
        <tr style={{ background: "#fafbff" }}>
          <td colSpan={4} style={{ padding: "6px 12px 10px" }}>
            {c.byProgramme.length === 0 ? (
              <div style={{ color: "var(--ink-500)", fontSize: "0.72rem" }}>
                No programme contributions for this county in the current scope.
              </div>
            ) : (
              <table style={{ width: "100%", fontSize: "0.7rem", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--ink-500)", textAlign: "left" }}>
                    <th style={subTh}>Programme</th>
                    <th style={{ ...subTh, textAlign: "right" }}>TIV</th>
                    <th style={{ ...subTh, textAlign: "right" }}>Locations</th>
                  </tr>
                </thead>
                <tbody>
                  {c.byProgramme.map((p) => (
                    <tr key={p.datasetId}>
                      <td style={subTd}>
                        {programmeLabel.get(p.datasetId) ?? p.datasetId}
                      </td>
                      <td style={{ ...subTd, textAlign: "right" }}>
                        {formatMoneyCompact(p.tiv, currency)}
                      </td>
                      <td style={{ ...subTd, textAlign: "right", color: "var(--ink-500)" }}>
                        {formatCount(p.locationCount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
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

const th: React.CSSProperties = {
  fontWeight: 600,
  padding: "3px 6px",
  fontSize: "0.66rem",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const td: React.CSSProperties = { padding: "5px 6px" };
const subTh: React.CSSProperties = {
  fontWeight: 600,
  padding: "2px 4px",
  fontSize: "0.62rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const subTd: React.CSSProperties = { padding: "3px 4px" };
