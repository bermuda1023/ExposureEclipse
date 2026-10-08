/**
 * One row per local-wind slice of a county: how much of the polygon was
 * in that Saffir-Simpson bin, the TIV sitting there, and the damage ratio
 * the underwriter has set for that bin.
 */

import { formatMoneyCompact } from "../../lib/format";
import type { WindBand } from "../../api/hurricanes";
import {
  applyCategory,
  resolveBandFractions,
  type CategoryAssumption,
  type Sshws,
} from "../../state/damageAssumptions";

const LABEL: Record<number, string> = {
  [-1]: "Clear",
  [0]: "TS",
  [1]: "Cat 1",
  [2]: "Cat 2",
  [3]: "Cat 3",
  [4]: "Cat 4",
  [5]: "Cat 5",
};

interface Props {
  bands: WindBand[] | undefined;
  tiv: number;
  scale: number;
  byCategory: Record<Sshws, CategoryAssumption>;
  currency: string;
  /** One line, highest band first. Used in the floating panel. */
  compact?: boolean;
  /** When set, each slice percent is an editable override. */
  onBandPercent?: (category: number, percent: number | null) => void;
  bandPercent?: Partial<Record<string, number>>;
}

export function CountyWindSlices({
  bands,
  tiv,
  scale,
  byCategory,
  currency,
  compact = false,
  onBandPercent,
  bandPercent,
}: Props) {
  const modelBands = bands ?? [];
  const resolved = resolveBandFractions(modelBands, bandPercent);
  const rows = resolved
    .filter((b) => b.areaFraction >= 0.005 || bandPercent?.[String(b.category)] != null)
    .slice()
    .sort((a, b) => b.category - a.category);
  if (rows.length === 0) return null;

  if (compact) {
    return (
      <div style={{ fontSize: "0.58rem", color: "var(--ink-600)", marginTop: 1 }}>
        {rows
          .map((b) => `${LABEL[b.category] ?? b.category} ${Math.round(b.areaFraction * 100)}%`)
          .join(" · ")}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 1, marginTop: 3 }}>
      {rows.map((b) => {
        const sliceTiv = tiv * b.areaFraction * scale;
        const loss =
          b.category >= 0 && tiv > 0
            ? applyCategory(sliceTiv, b.category, byCategory)
            : null;
        const assumption = byCategory[b.category as Sshws];
        return (
          <div
            key={b.category}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 6,
              fontSize: "0.6rem",
              color: "var(--ink-600)",
            }}
          >
            <span onClick={(e) => e.stopPropagation()}>
              <b style={{ color: "var(--ink-800)" }}>{LABEL[b.category] ?? b.category}</b>
              {" "}
              {onBandPercent ? (
                <SlicePercent
                  model={modelBands.find((m) => m.category === b.category)?.areaFraction ?? b.areaFraction}
                  override={bandPercent?.[String(b.category)]}
                  onChange={(pct) => onBandPercent(b.category, pct)}
                />
              ) : (
                <>{Math.round(b.areaFraction * 100)}%</>
              )}
              {b.category >= 0 && b.maxWindKt > 0 ? ` · ${b.maxWindKt} kt` : ""}
            </span>
            {loss && assumption ? (
              <span>
                {formatMoneyCompact(sliceTiv, currency)} · DR {assumption.mean}% ·{" "}
                <span style={{ color: "#b91c1c", fontWeight: 600 }}>
                  {formatMoneyCompact(loss.mean, currency)}
                </span>
              </span>
            ) : (
              <span>not in the storm</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SlicePercent({
  model,
  override,
  onChange,
}: {
  model: number;
  override: number | undefined;
  onChange: (percent: number | null) => void;
}) {
  const shown = override ?? Math.round(model * 100);
  const dirty = override != null && Math.abs(override - Math.round(model * 100)) >= 1;
  return (
    <input
      type="number"
      min={0}
      max={100}
      step={1}
      value={Math.round(shown)}
      title={dirty ? `Model had ${Math.round(model * 100)}%. Clear the box to put it back.` : "Share of the county. Edit to override. The rest becomes not in the storm."}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (raw === "") {
          onChange(null);
          return;
        }
        const v = parseFloat(raw);
        if (!Number.isFinite(v)) return;
        const pct = Math.max(0, Math.min(100, v));
        if (Math.abs(pct - Math.round(model * 100)) < 0.5) onChange(null);
        else onChange(pct);
      }}
      style={{
        width: 36,
        padding: "0 2px",
        fontSize: "0.6rem",
        textAlign: "right",
        border: `1px solid ${dirty ? "#fbbf24" : "var(--ink-300)"}`,
        background: dirty ? "#fef3c7" : "white",
        borderRadius: 3,
        fontFamily: "ui-monospace, monospace",
      }}
    />
  );
}
