/**
 * Top-of-page peril multi-select. Default = all perils (empty array).
 *
 * Perils that aren't represented in the underlying programmes of the current
 * selection are disabled (greyed out) — clicking them does nothing. This keeps
 * the user from picking "EQ" when their selected chain is WS-only and getting
 * a blank map without explanation.
 */

import { useMemo } from "react";
import { Peril } from "../../types/contracts";
import { useViewStore } from "../../state/view";
import { useCedents } from "../../api/hooks";
import { useSelectionStore } from "../../state/selection";
import type { Programme } from "../../api/cedents";

const SELECTABLE: Peril[] = [Peril.WS, Peril.EQ, Peril.CS, Peril.FL, Peril.FR, Peril.TR];

export function PerilSelector() {
  const perils = useViewStore((s) => s.perils);
  const setPerils = useViewStore((s) => s.setPerils);
  const togglePeril = useViewStore((s) => s.togglePeril);
  const isAll = perils.length === 0;

  const available = useAvailablePerils();

  // Drop any actively-selected peril that became unavailable after a selection
  // change, so the toggle state stays in sync.
  if (perils.some((p) => !available.has(p)) && available.size > 0) {
    setPerils(perils.filter((p) => available.has(p)));
  }

  return (
    <div
      style={{
        display: "inline-flex",
        gap: 4,
        alignItems: "center",
        padding: "2px 4px",
        background: "var(--ink-0)",
        border: "1px solid var(--ink-300)",
        borderRadius: 999,
      }}
      role="group"
      aria-label="Peril filter"
    >
      <PerilChip
        label="ALL"
        active={isAll}
        disabled={false}
        onClick={() => setPerils([])}
        title="Show all perils"
      />
      {SELECTABLE.map((p) => {
        const enabled = available.size === 0 || available.has(p);
        return (
          <PerilChip
            key={p}
            label={p}
            active={perils.includes(p) && enabled}
            disabled={!enabled}
            onClick={() => enabled && togglePeril(p)}
            title={enabled ? `Toggle ${p}` : `${p} isn't represented in the current selection`}
          />
        );
      })}
    </div>
  );
}

/**
 * Compute which perils are actually present in the programmes the current
 * selection points at. Empty set = no selection yet → treat as "all enabled".
 */
function useAvailablePerils(): Set<Peril> {
  const cedentId = useSelectionStore((s) => s.cedentId);
  const officeKey = useSelectionStore((s) => s.officeKey);
  const chainId = useSelectionStore((s) => s.chainId);
  const programmeId = useSelectionStore((s) => s.programmeId);
  const { data } = useCedents();

  return useMemo<Set<Peril>>(() => {
    if (!data) return new Set();
    const programmes: Programme[] = [];

    if (programmeId) {
      for (const c of data.cedents)
        for (const ch of c.chains)
          for (const p of ch.programmes)
            if (p.programmeId === programmeId) programmes.push(p);
    } else if (chainId) {
      const ch = data.cedents.flatMap((c) => c.chains).find((c) => c.chainId === chainId);
      if (ch) programmes.push(...ch.programmes);
    } else if (officeKey) {
      const cedent = data.cedents.find((c) => c.cedentId === officeKey.cedentId);
      cedent?.chains
        .filter((ch) => ch.office === officeKey.office)
        .forEach((ch) => programmes.push(...ch.programmes));
    } else if (cedentId) {
      const cedent = data.cedents.find((c) => c.cedentId === cedentId);
      cedent?.chains.forEach((ch) => programmes.push(...ch.programmes));
    }

    // Multi-peril programmes carry `perils: Peril[]`; single-peril ones may
    // only have the legacy `peril` field. Union both.
    const set = new Set<Peril>();
    for (const p of programmes) {
      if (p.perils?.length) p.perils.forEach((pe) => set.add(pe));
      if (p.peril && p.peril !== ("ALL" as Peril)) set.add(p.peril);
    }
    return set;
  }, [data, cedentId, officeKey, chainId, programmeId]);
}

function PerilChip({
  label,
  active,
  disabled,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-disabled={disabled}
      disabled={disabled}
      title={title}
      style={{
        all: "unset",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: "3px 9px",
        fontSize: "0.72rem",
        fontWeight: 600,
        borderRadius: 999,
        background: active ? "var(--brand-700)" : "transparent",
        color: disabled ? "var(--ink-400)" : active ? "white" : "var(--ink-600)",
        opacity: disabled ? 0.5 : 1,
        transition: "background 80ms, color 80ms",
      }}
    >
      {label}
    </button>
  );
}
