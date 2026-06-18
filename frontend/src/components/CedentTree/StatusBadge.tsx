/**
 * Tiny chip showing a programme's lifecycle status (BOUND / QUOTED / etc).
 * Currently in-force = BOUND and within [inception, expiry]; that's surfaced
 * as a small dot on the badge so the rail can be skimmed for what's actually
 * live right now.
 */

import type { Programme, ProgrammeStatus } from "../../api/cedents";

const COLOR: Record<ProgrammeStatus, { bg: string; fg: string; border: string }> = {
  BOUND: { bg: "#e8f7ec", fg: "#066c2f", border: "#5cba6a" },
  QUOTED: { bg: "#fff7e3", fg: "#7d5400", border: "#e0b34a" },
  DECLINED: { bg: "#fde9e9", fg: "#9b1c1c", border: "#e07474" },
  NTU: { bg: "#f1f1f6", fg: "#56607d", border: "#a3aabc" },
  EXPIRED: { bg: "#eceff4", fg: "#5e6a7d", border: "#b3becf" },
};

export function isInForce(p: Programme, today = new Date()): boolean {
  if (p.status !== "BOUND") return false;
  if (p.inceptionDate && new Date(p.inceptionDate) > today) return false;
  if (p.expiryDate && new Date(p.expiryDate) < today) return false;
  return true;
}

export function StatusBadge({
  status,
  inForce = false,
  size = "sm",
}: {
  status: ProgrammeStatus;
  inForce?: boolean;
  size?: "sm" | "xs";
}) {
  const c = COLOR[status] ?? COLOR.BOUND;
  return (
    <span
      title={inForce ? `${status} — in-force today` : status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: size === "xs" ? "0.58rem" : "0.62rem",
        fontWeight: 700,
        letterSpacing: "0.04em",
        color: c.fg,
        background: c.bg,
        border: `1px solid ${c.border}`,
        padding: size === "xs" ? "0px 5px" : "1px 6px",
        borderRadius: 999,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {inForce && (
        <span
          aria-hidden
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: c.fg,
            display: "inline-block",
          }}
        />
      )}
      {status}
    </span>
  );
}
