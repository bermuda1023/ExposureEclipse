/**
 * One row per local-wind slice of a county: how much of the polygon was
 * in that Saffir-Simpson bin, the TIV sitting there, and the damage ratio
 * the underwriter has set for that bin.
 */

import { formatMoneyCompact } from "../../lib/format";
import type { WindBand } from "../../api/hurricanes";
import {
  applyCategory,
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
}

export function CountyWindSlices({
  bands,
  tiv,
  scale,
  byCategory,
  currency,
  compact = false,
}: Props) {
  const rows = (bands ?? [])
    .filter((b) => b.areaFraction >= 0.005)
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
            <span>
              <b style={{ color: "var(--ink-800)" }}>{LABEL[b.category] ?? b.category}</b>
              {" "}
              {Math.round(b.areaFraction * 100)}%
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
