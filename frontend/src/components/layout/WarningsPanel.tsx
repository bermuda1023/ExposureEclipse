/**
 * Warnings panel — surfaces every Warning returned by analytical endpoints.
 *
 * CLAUDE.md rule 11: warnings are first-class. Group by severity, dedupe by
 * (code + message). UI text is the canonical message from the wire.
 */

import type { ApiWarning } from "../../api/client";

interface Props {
  warnings: ApiWarning[];
}

function dedupe(warnings: ApiWarning[]): ApiWarning[] {
  const seen = new Map<string, ApiWarning>();
  for (const w of warnings) {
    const key = `${w.code}|${w.message}`;
    if (!seen.has(key)) seen.set(key, w);
  }
  return [...seen.values()];
}

const severityStyles: Record<string, React.CSSProperties> = {
  warn: { borderLeftColor: "#b00020", background: "#fdecea" },
  info: { borderLeftColor: "#1565c0", background: "#e8f0fe" },
};

export function WarningsPanel({ warnings }: Props) {
  const list = dedupe(warnings);
  if (list.length === 0) {
    return (
      <div style={{ color: "#888", fontSize: "0.85rem" }}>
        No warnings — every metric is fully traceable.
      </div>
    );
  }
  return (
    <ul
      aria-label="Warnings"
      style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}
    >
      {list.map((w, i) => (
        <li
          key={`${w.code}-${i}`}
          style={{
            borderLeft: "4px solid",
            padding: "6px 10px",
            fontSize: "0.85rem",
            ...severityStyles[w.severity],
          }}
        >
          <strong style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
            {w.code}
          </strong>{" "}
          — {w.message}
        </li>
      ))}
    </ul>
  );
}
