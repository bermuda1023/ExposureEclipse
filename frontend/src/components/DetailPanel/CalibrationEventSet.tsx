/**
 * Which PCS storms train the PCS-calibrated curve and its range, and why the
 * others are left out. Shared by the damage assumptions editor and the
 * Methodology page so both read the same shipped curve set.
 */

import type { CalibrationEvent, EventExclusionReason, PanelBandEvent } from "../../api/industryLoss";
import { calibrationEvent, type CalibratedCurve } from "../../state/damageAssumptions";

export const EXCLUSION_LABEL: Record<EventExclusionReason, string> = {
  noExposure: "No matching TIV",
  stalled: "Stalled, rain-driven",
  outsideFootprint: "Loss outside wind field",
};

export function rangeLabel(curve: CalibratedCurve): string {
  const target = Math.round((curve.panelBand.coverageTarget ?? 0.8) * 100);
  return `PCS holdout ${target}% range`;
}

function share(v: number | null | undefined): string {
  return v == null ? "–" : `${Math.round(v * 100)}%`;
}

function factorText(row: PanelBandEvent | undefined): string {
  return row?.factor == null ? "–" : `${row.factor.toFixed(2)}×`;
}

function evidence(e: CalibrationEvent): string {
  const m = e.metrics;
  return `${share(m.outsideFootprintShare)} of loss outside the modelled wind field · ${
    m.stallHours == null ? "no US landfall" : `${Math.round(m.stallHours)} h within 100 nm of landfall`
  }${m.noTivShare ? ` · ${share(m.noTivShare)} of loss with no book TIV` : ""}`;
}

/** One line under the impact totals: what the range is and whether it applies to this storm. */
export function PanelBandNote({ curve, stormId }: { curve: CalibratedCurve; stormId: string }) {
  const band = curve.panelBand;
  const event = calibrationEvent(curve, stormId);
  const row = band.events?.find((r) => r.stormId === event?.stormId);
  const base = `${band.lowFactor.toFixed(2)}–${band.highFactor.toFixed(2)}× the mean: held out, ${band.coveredEvents} of ${band.scorableEvents} wind-dominant PCS events fell inside. Applies to wind-dominant storms only.`;
  if (event && !event.included) {
    return (
      <div style={{ ...note, background: "var(--warn-50, #fff7e6)", borderColor: "var(--warn-300, #f5c26b)" }}>
        <b>{event.name} is excluded from calibration</b> ({event.reasons.map((r) => EXCLUSION_LABEL[r]).join(", ")}).
        {" "}The range does not apply: actual / model on the calibrated curve was {factorText(row)}. {event.mechanism}
      </div>
    );
  }
  return (
    <div style={note}>
      {base}
      {event && row && (
        <> {event.name} is a training storm; held out it scored {factorText(row)}{row.withinRange ? "" : ", outside the range"}.</>
      )}
    </div>
  );
}

export function CalibrationEventSet({ curve, fontSize = "0.66rem" }: { curve: CalibratedCurve; fontSize?: string }) {
  const rows = new Map((curve.panelBand.events ?? []).map((r) => [r.stormId, r]));
  const included = curve.eventSet.filter((e) => e.included);
  const excluded = curve.eventSet.filter((e) => !e.included);
  if (curve.eventSet.length === 0) return null;
  return (
    <div style={{ fontSize, color: "var(--ink-700)" }}>
      <div style={{ fontWeight: 700, margin: "4px 0 2px" }}>
        Included: {included.length} wind-dominant storms
      </div>
      <table style={table}>
        <tbody>
          {included.map((e) => (
            <tr key={e.stormId} style={rowStyle} title={evidence(e)}>
              <td style={cell}>{e.name} {e.year}</td>
              <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
                {factorText(rows.get(e.stormId))}{rows.get(e.stormId)?.withinRange === false ? " (outside)" : ""}
              </td>
              <td style={{ ...cell, color: "var(--ink-500)" }}>{e.mechanism}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontWeight: 700, margin: "6px 0 2px" }}>
        Excluded: {excluded.length} storms whose loss a wind-damage curve cannot represent
      </div>
      <table style={table}>
        <tbody>
          {excluded.map((e) => (
            <tr key={e.stormId} style={rowStyle} title={evidence(e)}>
              <td style={cell}>{e.name} {e.year}</td>
              <td style={{ ...cell, whiteSpace: "nowrap" }}>{e.reasons.map((r) => EXCLUSION_LABEL[r]).join(", ")}</td>
              <td style={{ ...cell, color: "var(--ink-500)" }}>
                {e.mechanism} <i>{evidence(e)}.</i>
                {rows.get(e.stormId)?.factor != null && <> Scored on the final curve: {factorText(rows.get(e.stormId))}.</>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ color: "var(--ink-500)", marginTop: 4 }}>
        Factor = on-levelled PCS loss in the book ÷ the panel&apos;s PCS-calibrated mean, with the storm held out of the fit.
        Exclusion rules use track, footprint and TIV coverage only, never the fit.
      </div>
    </div>
  );
}

const note: React.CSSProperties = {
  fontSize: "0.66rem",
  color: "var(--ink-600)",
  border: "1px solid var(--ink-200)",
  borderRadius: 4,
  padding: "4px 6px",
  margin: "4px 0",
  gridColumn: "1 / -1",
};
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse" };
const rowStyle: React.CSSProperties = { borderTop: "1px solid var(--ink-100)", verticalAlign: "top" };
const cell: React.CSSProperties = { padding: "2px 4px" };
