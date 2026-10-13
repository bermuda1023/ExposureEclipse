/**
 * Industry loss for the active storm, computed on the backend from the
 * industry TIV (supplied vintage, else the built-in book) and a damage-curve
 * set (calibrated against supplied PCS losses, else Form V-1). When the storm
 * has supplied actuals the section also shows modelled vs actual.
 */

import { useMemo, useState } from "react";
import { useDamageCurves, useIndustryBacktest, useIndustryLoss } from "../../api/hooks";
import { LOSS_SEGMENTS, actualsBasisLabel, type LossSegment } from "../../api/industryLoss";
import { useCountyOverridesStore } from "../../state/countyOverrides";
import { formatMoneyCompact } from "../../lib/format";

const SEGMENT_LABEL: Record<LossSegment, string> = {
  RESIDENTIAL: "Residential",
  COMMERCIAL: "Commercial",
  AUTO: "Auto",
};

function ratioText(modelled: number, actual: number): string {
  if (!(actual > 0)) return "—";
  return `×${(modelled / actual).toFixed(2)}`;
}

function ratioColor(modelled: number, actual: number): string {
  if (!(actual > 0) || !(modelled > 0)) return "var(--ink-500)";
  const r = Math.abs(Math.log(modelled / actual));
  if (r < Math.log(1.25)) return "#066c2f";
  if (r < Math.log(1.6)) return "#7d5400";
  return "#b91c1c";
}

export function IndustryLossSection({ stormId }: { stormId: string }) {
  const [curveSetId, setCurveSetId] = useState<string | null>(null);
  const [showBacktest, setShowBacktest] = useState(false);
  const overrides = useCountyOverridesStore((s) => s.byStorm[stormId]);
  const exposedFraction = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [geoid, row] of Object.entries(overrides ?? {})) {
      if (row.exposedFraction !== 1.0) out[geoid] = row.exposedFraction;
    }
    return out;
  }, [overrides]);
  const hasSliceEdits = Object.values(overrides ?? {}).some(
    (row) => Object.keys(row.bandPercent ?? {}).length > 0,
  );

  const curves = useDamageCurves();
  const loss = useIndustryLoss(stormId, curveSetId, exposedFraction);
  const data = loss.data;
  const hasActuals = Boolean(data?.actuals);
  const backtest = useIndustryBacktest(stormId, data?.curveSet.id ?? curveSetId, hasActuals && showBacktest);
  const selected = curveSetId ?? curves.data?.defaultId ?? "";

  return (
    <section
      style={{
        display: "grid",
        gap: 6,
        padding: 10,
        border: "1px solid var(--ink-300)",
        borderRadius: "var(--radius-sm)",
        background: "white",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <div style={sectionTitle}>Industry loss</div>
        <select
          value={selected}
          onChange={(e) => setCurveSetId(e.target.value || null)}
          title="Damage-curve set. Calibrated sets are fitted to supplied PCS losses."
          style={{ fontSize: "0.7rem", maxWidth: 170 }}
        >
          {(curves.data?.curveSets ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      {loss.isLoading && <div style={{ color: "var(--ink-500)" }}>Computing industry loss…</div>}
      {loss.error && (
        <div style={{ color: "var(--error-700)" }}>
          Industry loss failed: {String((loss.error as Error).message ?? loss.error)}
        </div>
      )}

      {data && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.72rem" }}>
            <thead>
              <tr style={{ color: "var(--ink-500)", textAlign: "left" }}>
                <th style={th}>Segment</th>
                <th style={{ ...th, textAlign: "right" }}>P50</th>
                <th style={{ ...th, textAlign: "right" }}>P10 – P90</th>
                {hasActuals && <th style={{ ...th, textAlign: "right" }}>Actual</th>}
              </tr>
            </thead>
            <tbody>
              {LOSS_SEGMENTS.map((seg) => {
                const band = data.summary.bySegment[seg];
                const actual = data.actuals?.bySegment[seg] ?? 0;
                if (!band || (band.tiv <= 0 && actual <= 0)) return null;
                return (
                  <tr key={seg} style={{ borderTop: "1px solid var(--ink-200)" }}>
                    <td style={td}>{SEGMENT_LABEL[seg]}</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>
                      {formatMoneyCompact(band.p50, data.currency)}
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "var(--ink-600)" }}>
                      {formatMoneyCompact(band.p10, data.currency)} – {formatMoneyCompact(band.p90, data.currency)}
                    </td>
                    {hasActuals && (
                      <td style={{ ...td, textAlign: "right" }}>
                        {formatMoneyCompact(actual, data.currency)}
                        <div style={{ fontSize: "0.6rem", color: ratioColor(band.mean, actual), fontWeight: 600 }}>
                          {ratioText(band.mean, actual)} mean
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              <tr style={{ borderTop: "2px solid var(--ink-300)", fontWeight: 700 }}>
                <td style={td}>Total</td>
                <td style={{ ...td, textAlign: "right" }}>
                  {formatMoneyCompact(data.summary.total.p50, data.currency)}
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--ink-600)", fontWeight: 400 }}>
                  {formatMoneyCompact(data.summary.total.p10, data.currency)} –{" "}
                  {formatMoneyCompact(data.summary.total.p90, data.currency)}
                </td>
                {hasActuals && data.actuals && (
                  <td style={{ ...td, textAlign: "right" }}>
                    {formatMoneyCompact(data.actuals.total, data.currency)}
                    <div
                      style={{
                        fontSize: "0.6rem",
                        color: ratioColor(data.summary.total.mean, data.actuals.total),
                      }}
                    >
                      {ratioText(data.summary.total.mean, data.actuals.total)} mean
                    </div>
                  </td>
                )}
              </tr>
            </tbody>
          </table>

          <div style={{ fontSize: "0.62rem", color: "var(--ink-500)", lineHeight: 1.4 }}>
            Curve <strong>{data.curveSet.label}</strong> ({data.curveSet.kind}) · land wind ×
            {data.curveSet.windFactor.toFixed(2)} · TIV{" "}
            {data.tivSource.kind === "supplied"
              ? `supplied ${data.tivSource.year} (${data.tivSource.file})`
              : "built-in Industry book"}
            {data.actuals?.source ? ` · actuals ${data.actuals.source}` : ""}
            {data.actuals?.asOfDate ? ` as of ${data.actuals.asOfDate}` : ""}
            {data.actuals && actualsBasisLabel(data.actuals) ? ` (${actualsBasisLabel(data.actuals)})` : ""}
          </div>
          {[...data.notes, ...(hasSliceEdits ? ["Wind-slice edits are not applied to industry loss; county scale is."] : [])].map(
            (note) => (
              <div key={note} style={{ fontSize: "0.62rem", color: "#7d5400" }}>
                {note}
              </div>
            ),
          )}

          {hasActuals && (
            <button
              onClick={() => setShowBacktest((v) => !v)}
              style={{
                all: "unset",
                cursor: "pointer",
                color: "var(--brand-700)",
                fontWeight: 600,
                fontSize: "0.7rem",
              }}
            >
              {showBacktest ? "Hide county backtest" : "Show county backtest"}
            </button>
          )}
          {showBacktest && backtest.isLoading && (
            <div style={{ color: "var(--ink-500)" }}>Loading backtest…</div>
          )}
          {showBacktest && backtest.data && (
            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ fontSize: "0.62rem", color: "var(--ink-600)" }}>
                Biggest county misses. {backtest.data.footprintMisses.length} reported counties sit outside the
                modelled wind field; {backtest.data.unreportedCounties.length} modelled counties have no
                reported loss.
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.68rem" }}>
                <thead>
                  <tr style={{ color: "var(--ink-500)", textAlign: "left" }}>
                    <th style={th}>County</th>
                    <th style={{ ...th, textAlign: "right" }}>Actual</th>
                    <th style={{ ...th, textAlign: "right" }}>Model</th>
                  </tr>
                </thead>
                <tbody>
                  {backtest.data.counties.slice(0, 12).map((row) => (
                    <tr key={`${row.geographyId}-${row.segment}`} style={{ borderTop: "1px solid var(--ink-200)" }}>
                      <td style={td}>
                        {row.name ?? row.geographyId} · {row.state}
                        <div style={{ fontSize: "0.58rem", color: "var(--ink-500)" }}>
                          {SEGMENT_LABEL[row.segment]}
                          {row.maxWindKt ? ` · ${row.maxWindKt} kt` : " · outside wind field"}
                          {row.impliedDr != null ? ` · implied DR ${(row.impliedDr * 100).toFixed(2)}%` : ""}
                        </div>
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>
                        {formatMoneyCompact(row.actual, backtest.data.currency)}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: ratioColor(row.modelled, row.actual) }}>
                        {formatMoneyCompact(row.modelled, backtest.data.currency)}
                        <div style={{ fontSize: "0.58rem" }}>{ratioText(row.modelled, row.actual)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: "0.66rem",
  color: "var(--ink-500)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontWeight: 700,
};
const th: React.CSSProperties = { fontWeight: 600, padding: "3px 4px", fontSize: "0.62rem" };
const td: React.CSSProperties = { padding: "4px 4px" };
