/**
 * Editable damage-ratio assumptions table (mean + SD per Saffir-Simpson
 * category). Numbers are entered as percentages; the impact panel applies
 * them client-side to produce per-county and per-programme loss bands.
 */

import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  useDamageAssumptionsStore,
  type Sshws,
} from "../../state/damageAssumptions";

interface Props {
  compact?: boolean;
}

export function DamageAssumptionsEditor({ compact = false }: Props) {
  const byCategory = useDamageAssumptionsStore((s) => s.byCategory);
  const set = useDamageAssumptionsStore((s) => s.set);
  const reset = useDamageAssumptionsStore((s) => s.reset);

  return (
    <section
      style={{
        background: "#fff",
        border: "1px solid var(--ink-200)",
        borderRadius: 6,
        padding: compact ? 6 : 10,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
        <div>
          <div
            style={{
              fontSize: compact ? "0.62rem" : "0.66rem",
              color: "var(--ink-500)",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Damage assumptions (your inputs)
          </div>
          <div style={{ fontSize: "0.66rem", color: "var(--ink-500)", marginTop: 1 }}>
            Mean ± SD damage ratio per category — drives the loss band on every
            impacted county.
          </div>
        </div>
        <button
          onClick={reset}
          title="Reset to industry-shape defaults"
          style={{
            all: "unset",
            cursor: "pointer",
            fontSize: "0.62rem",
            color: "var(--brand-700)",
            textDecoration: "underline",
          }}
        >
          reset
        </button>
      </header>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.72rem" }}>
        <thead>
          <tr style={{ color: "var(--ink-500)", textAlign: "left" }}>
            <th style={th}>Category</th>
            <th style={{ ...th, textAlign: "right" }}>Mean DR %</th>
            <th style={{ ...th, textAlign: "right" }}>± SD %</th>
            <th style={{ ...th, textAlign: "right" }}>Band</th>
          </tr>
        </thead>
        <tbody>
          {CATEGORY_ORDER.map((cat) => {
            const a = byCategory[cat];
            const lo = Math.max(0, a.mean - a.sd).toFixed(1);
            const hi = Math.min(100, a.mean + a.sd).toFixed(1);
            return (
              <tr key={cat} style={{ borderTop: "1px solid var(--ink-100)" }}>
                <td style={{ ...td, fontWeight: 600 }}>{CATEGORY_LABELS[cat]}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <Input
                    value={a.mean}
                    onChange={(n) => set(cat, { mean: n })}
                  />
                </td>
                <td style={{ ...td, textAlign: "right" }}>
                  <Input
                    value={a.sd}
                    onChange={(n) => set(cat, { sd: n })}
                  />
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--ink-500)" }}>
                  {lo}–{hi}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Input({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <input
      type="number"
      step="0.1"
      min="0"
      max="100"
      value={value}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
        else onChange(0);
      }}
      style={{
        width: 56,
        padding: "2px 4px",
        fontSize: "0.72rem",
        textAlign: "right",
        border: "1px solid var(--ink-300)",
        borderRadius: 3,
        background: "white",
        fontFamily: "ui-monospace, monospace",
      }}
    />
  );
}

// helper used by callers to flag a category that no impacted county falls in
export function _categoryUsedInImpact(
  cat: Sshws,
  impactedWinds: number[],
): boolean {
  // not used internally; kept for future "grey out unused rows" UX
  void cat;
  void impactedWinds;
  return true;
}

const th: React.CSSProperties = {
  fontWeight: 600,
  padding: "3px 6px",
  fontSize: "0.62rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const td: React.CSSProperties = { padding: "3px 6px" };
