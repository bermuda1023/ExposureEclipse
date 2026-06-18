/**
 * Cedent → Office → Chain → Programme navigation tree.
 *
 *   Cedent (Farmers Group)            ← click = union of every chain
 *   ├── Office BDA                    ← click = union of BDA's chains
 *   │   ├── Chain "Nationwide WS"     ← click = chain; YoY auto-pairs
 *   │   │   ├── Programme 2027        ← click = single programme/year
 *   │   │   ├── Programme 2026
 *   │   │   └── Programme 2025
 *   │   ├── Chain "Nationwide EQ"
 *   │   └── Chain "Nationwide CS"
 *   └── Office NYC
 *       └── Chain "Florida-Only WS"
 */

import { useMemo, useState } from "react";
import { useCedents, useProgrammeStatus } from "../../api/hooks";
import { useSelectionStore } from "../../state/selection";
import { useScopeFiltersStore } from "../../state/scopeFilters";
import type { Cedent, Programme, ProgrammeChain } from "../../api/cedents";
import { ErtBadge } from "./ErtBadge";
import { ErtStatus } from "../../types/contracts";
import { ErtJobIndicator } from "../ErtJob/ErtJobIndicator";
import { StatusBadge, isInForce } from "./StatusBadge";

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Compact multi-select rendered as toggleable chips. Empty selection = no
 * filter on this dimension; visually distinct from "all chips active" so the
 * user can tell scope filters apart from explicit selections.
 */
function ChipFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (vs: string[]) => void;
}) {
  if (options.length === 0) return null;
  const sel = new Set(selected);
  const toggle = (v: string) => {
    const next = new Set(sel);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange([...next]);
  };
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <span style={{ fontSize: "0.66rem", color: "var(--ink-500)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {options.map((opt) => {
          const active = sel.has(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              title={active ? `Remove ${label.toLowerCase()} '${opt}'` : `Add ${label.toLowerCase()} '${opt}'`}
              style={{
                all: "unset",
                cursor: "pointer",
                fontSize: "0.66rem",
                padding: "2px 7px",
                borderRadius: 999,
                fontWeight: 600,
                color: active ? "var(--brand-700)" : "var(--ink-600)",
                background: active ? "var(--brand-50)" : "var(--ink-0)",
                border: `1px solid ${active ? "var(--brand-500)" : "var(--ink-300)"}`,
              }}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function groupByOffice(chains: ProgrammeChain[]): Map<string, ProgrammeChain[]> {
  const m = new Map<string, ProgrammeChain[]>();
  for (const ch of chains) {
    const list = m.get(ch.office) ?? [];
    list.push(ch);
    m.set(ch.office, list);
  }
  return m;
}

export function CedentTree() {
  const { data, isLoading, error } = useCedents();
  const [search, setSearch] = useState("");
  const offices = useScopeFiltersStore((s) => s.offices);
  const regions = useScopeFiltersStore((s) => s.regions);
  const underwriters = useScopeFiltersStore((s) => s.underwriters);
  const setOffices = useScopeFiltersStore((s) => s.setOffices);
  const setRegions = useScopeFiltersStore((s) => s.setRegions);
  const setUnderwriters = useScopeFiltersStore((s) => s.setUnderwriters);
  const clearScope = useScopeFiltersStore((s) => s.clear);

  const allOffices = useMemo(() => {
    if (!data) return [];
    const xs = new Set<string>();
    for (const c of data.cedents) for (const ch of c.chains) xs.add(ch.office);
    return uniq([...xs]).sort();
  }, [data]);
  const allRegions = useMemo(() => {
    if (!data) return [];
    const xs = new Set<string>();
    for (const c of data.cedents) if (c.region) xs.add(c.region);
    return uniq([...xs]).sort();
  }, [data]);
  const allUnderwriters = useMemo(() => {
    if (!data) return [];
    const xs = new Set<string>();
    for (const c of data.cedents)
      for (const ch of c.chains)
        for (const p of ch.programmes) if (p.underwriter) xs.add(p.underwriter);
    return uniq([...xs]).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const officeSet = offices.length ? new Set(offices) : null;
    const regionSet = regions.length ? new Set(regions) : null;
    const uwSet = underwriters.length ? new Set(underwriters) : null;

    return data.cedents
      .filter((c) => !regionSet || (c.region && regionSet.has(c.region)))
      .map((c) => ({
        ...c,
        chains: c.chains.filter((ch) => {
          if (officeSet && !officeSet.has(ch.office)) return false;
          if (uwSet) {
            // Keep chain if ANY programme in the chain is by a selected underwriter.
            if (!ch.programmes.some((p) => uwSet.has(p.underwriter))) return false;
          }
          return true;
        }),
      }))
      .filter((c) => {
        if ((officeSet || uwSet) && c.chains.length === 0) return false;
        if (!q) return true;
        const haystack =
          `${c.cedentName} ${c.chains.map((ch) => `${ch.chainName} ${ch.office}`).join(" ")}`.toLowerCase();
        return haystack.includes(q);
      });
  }, [data, search, offices, regions, underwriters]);

  return (
    <aside
      style={{
        background: "var(--ink-0)",
        overflow: "auto",
        padding: 14,
        display: "grid",
        gap: 12,
        alignContent: "start",
        height: "100%",
      }}
    >
      <h2
        style={{
          fontSize: "0.7rem",
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-500)",
        }}
      >
        Cedents
      </h2>

      <div style={{ display: "grid", gap: 6, fontSize: "0.72rem", color: "var(--ink-600)" }}>
        <label style={{ display: "grid", gap: 3 }}>
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="cedent / chain / office"
            aria-label="Search cedents"
          />
        </label>
        <ChipFilter
          label="Office"
          options={allOffices}
          selected={offices}
          onChange={setOffices}
        />
        <ChipFilter
          label="Region"
          options={allRegions}
          selected={regions}
          onChange={setRegions}
        />
        <ChipFilter
          label="Underwriter"
          options={allUnderwriters}
          selected={underwriters}
          onChange={setUnderwriters}
        />
        {(offices.length + regions.length + underwriters.length) > 0 && (
          <button
            type="button"
            onClick={clearScope}
            style={{
              all: "unset",
              cursor: "pointer",
              alignSelf: "start",
              fontSize: "0.66rem",
              color: "var(--brand-700)",
              fontWeight: 600,
              textDecoration: "underline",
              padding: "2px 0",
            }}
          >
            Clear all scope filters
          </button>
        )}
      </div>

      {isLoading && (
        <p style={{ fontSize: "0.78rem", color: "var(--ink-500)" }}>Loading cedents…</p>
      )}
      {error ? (
        <div
          style={{
            background: "var(--error-100)",
            color: "var(--error-700)",
            border: "1px solid var(--error-500)",
            padding: 8,
            borderRadius: "var(--radius-sm)",
            fontSize: "0.78rem",
          }}
        >
          <strong>Backend unreachable.</strong>
          <div>{String((error as Error)?.message ?? error)}</div>
        </div>
      ) : null}

      {data && (
        <>
          <div style={{ fontSize: "0.7rem", color: "var(--ink-500)" }}>
            {filtered.length} / {data.cedents.length} cedents
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
            {filtered.map((c) => (
              <CedentItem key={c.cedentId} cedent={c} />
            ))}
            {filtered.length === 0 && (
              <li style={{ color: "var(--ink-500)", fontSize: "0.78rem" }}>
                No cedents match these filters.
              </li>
            )}
          </ul>
        </>
      )}
    </aside>
  );
}

function CedentItem({ cedent }: { cedent: Cedent }) {
  const selectedCedent = useSelectionStore((s) => s.cedentId);
  const selectCedent = useSelectionStore((s) => s.selectCedent);
  const isSelected = selectedCedent === cedent.cedentId;
  const offices = useMemo(() => groupByOffice(cedent.chains), [cedent.chains]);

  return (
    <li
      style={{
        background: "var(--ink-0)",
        border: `1px solid ${isSelected ? "var(--brand-500)" : "var(--ink-200)"}`,
        boxShadow: isSelected ? "0 0 0 3px var(--brand-100)" : "var(--shadow-sm)",
        borderRadius: "var(--radius-md)",
        padding: 10,
        display: "grid",
        gap: 6,
      }}
    >
      <button
        type="button"
        onClick={() => selectCedent(isSelected ? null : cedent.cedentId)}
        style={{ all: "unset", cursor: "pointer", display: "grid", gap: 2, padding: 2 }}
        title={isSelected ? "Deselect cedent" : "Select cedent — unions all offices and chains"}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
          <strong style={{ fontSize: "0.85rem", color: "var(--ink-900)" }}>
            {cedent.cedentName}
          </strong>
          <span style={{ fontSize: "0.66rem", color: "var(--ink-500)" }}>
            {[...offices.keys()].sort().join(" · ")}
          </span>
        </div>
        {cedent.region && (
          <span
            style={{
              justifySelf: "start",
              marginTop: 4,
              fontSize: "0.66rem",
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--brand-700)",
              background: "var(--brand-50)",
              border: "1px solid var(--brand-400)",
              padding: "1px 7px",
              borderRadius: 999,
            }}
          >
            {cedent.region}
          </span>
        )}
      </button>

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
        {[...offices.keys()].sort().map((office) => (
          <OfficeItem
            key={office}
            cedentId={cedent.cedentId}
            office={office}
            chains={offices.get(office)!}
          />
        ))}
      </ul>
    </li>
  );
}

function OfficeItem({
  cedentId,
  office,
  chains,
}: {
  cedentId: string;
  office: string;
  chains: ProgrammeChain[];
}) {
  const officeKey = useSelectionStore((s) => s.officeKey);
  const selectOffice = useSelectionStore((s) => s.selectOffice);
  const selectedChain = useSelectionStore((s) => s.chainId);
  const selectedProg = useSelectionStore((s) => s.programmeId);
  const isOfficeSelected =
    officeKey?.cedentId === cedentId && officeKey?.office === office;
  const isActive =
    isOfficeSelected ||
    chains.some(
      (ch) =>
        ch.chainId === selectedChain ||
        ch.programmes.some((p) => p.programmeId === selectedProg),
    );
  const [expanded, setExpanded] = useState(isActive);

  return (
    <li
      style={{
        background: isActive ? "var(--brand-50)" : "var(--ink-50)",
        border: `1px solid ${isOfficeSelected ? "var(--brand-400)" : "var(--ink-200)"}`,
        borderRadius: "var(--radius-sm)",
        padding: "6px 8px",
        display: "grid",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <button
          type="button"
          onClick={() =>
            isOfficeSelected
              ? useSelectionStore.getState().clear()
              : selectOffice(cedentId, office)
          }
          style={{ all: "unset", cursor: "pointer", flex: 1 }}
          title={`Select ${office} office — unions ${chains.length} chain${chains.length === 1 ? "" : "s"}`}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <strong style={{ fontSize: "0.78rem", color: "var(--ink-900)" }}>{office}</strong>
            <span style={{ fontSize: "0.68rem", color: "var(--ink-500)" }}>
              {chains.length} chain{chains.length === 1 ? "" : "s"}
            </span>
          </div>
        </button>
        <button
          type="button"
          aria-label={expanded ? "Collapse chains" : "Expand chains"}
          onClick={() => setExpanded((v) => !v)}
          style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontSize: "0.78rem", padding: "0 4px" }}
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>

      {expanded && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
          {chains.map((ch) => (
            <ChainItem key={ch.chainId} chain={ch} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ChainItem({ chain }: { chain: ProgrammeChain }) {
  const selectedChain = useSelectionStore((s) => s.chainId);
  const selectedProg = useSelectionStore((s) => s.programmeId);
  const selectChain = useSelectionStore((s) => s.selectChain);
  const selectProgramme = useSelectionStore((s) => s.selectProgramme);
  const comparisonProgrammeId = useSelectionStore((s) => s.comparisonProgrammeId);
  const setComparison = useSelectionStore((s) => s.setComparisonProgramme);

  const isChainSelected = selectedChain === chain.chainId;
  const sortedProgrammes = useMemo(
    () => [...chain.programmes].sort((a, b) => b.treatyYear - a.treatyYear),
    [chain.programmes],
  );
  const current = sortedProgrammes[0];
  const defaultPrior = sortedProgrammes[1];
  const compareToId = comparisonProgrammeId ?? defaultPrior?.programmeId ?? null;

  const isProgrammeOfChain = sortedProgrammes.some((p) => p.programmeId === selectedProg);
  const isActive = isChainSelected || isProgrammeOfChain;
  const [expanded, setExpanded] = useState(isActive);

  return (
    <li
      style={{
        background: isChainSelected ? "var(--brand-100)" : "var(--ink-0)",
        border: `1px solid ${isChainSelected ? "var(--brand-400)" : "var(--ink-200)"}`,
        borderRadius: "var(--radius-sm)",
        padding: "5px 8px",
        fontSize: "0.78rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={() => selectChain(isChainSelected ? null : chain.chainId)}
          style={{ all: "unset", cursor: "pointer", flex: 1, minWidth: 0 }}
          title="Pick this chain — latest vs prior auto-pairs for YoY"
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontWeight: 600,
                color: "var(--ink-900)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                minWidth: 0,
              }}
            >
              {chain.chainName}
            </span>
            {current && (
              <StatusBadge
                status={current.status}
                inForce={isInForce(current)}
                size="xs"
              />
            )}
          </div>
        </button>
        <button
          type="button"
          aria-label={expanded ? "Collapse programmes" : "Expand programmes"}
          onClick={() => setExpanded((v) => !v)}
          style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontSize: "0.78rem", padding: "0 4px" }}
        >
          {expanded ? "▾" : "▸"}
        </button>
      </div>

      {isChainSelected && sortedProgrammes.length > 1 && (
        <label
          style={{
            display: "grid",
            gap: 3,
            marginTop: 4,
            fontSize: "0.7rem",
            color: "var(--ink-600)",
          }}
        >
          Compare {current?.treatyYear} vs
          <select
            value={compareToId ?? ""}
            onChange={(e) => setComparison(e.target.value || null)}
            aria-label="Comparison year"
          >
            {sortedProgrammes
              .filter((p) => p.programmeId !== current?.programmeId)
              .map((p) => (
                <option key={p.programmeId} value={p.programmeId}>
                  {p.treatyYear}
                </option>
              ))}
          </select>
        </label>
      )}

      {expanded && (
        <ul style={{ listStyle: "none", padding: "4px 0 0", margin: 0, display: "grid", gap: 3 }}>
          {sortedProgrammes.map((p) => (
            <ProgrammeItem
              key={p.programmeId}
              programme={p}
              isSelected={selectedProg === p.programmeId}
              onSelect={() => selectProgramme(p.programmeId === selectedProg ? null : p.programmeId)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function ProgrammeItem({
  programme,
  isSelected,
  onSelect,
}: {
  programme: Programme;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { data: status } = useProgrammeStatus(programme.programmeId);
  const ert = status?.ertStatus ?? programme.edm.ertStatus;
  const showJob =
    ert === ErtStatus.ERT_NOT_FOUND || ert === ErtStatus.ERT_PARTIAL || ert === ErtStatus.ERT_ERROR;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px",
          borderRadius: 4,
          background: isSelected ? "var(--brand-100)" : "transparent",
          border: `1px solid ${isSelected ? "var(--brand-400)" : "transparent"}`,
        }}
      >
        <span style={{ fontSize: "0.74rem", color: "var(--ink-900)", fontWeight: 600 }}>
          {programme.treatyYear}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <StatusBadge
            status={programme.status}
            inForce={isInForce(programme)}
            size="xs"
          />
          <ErtBadge status={ert} />
        </span>
      </button>
      {showJob && (
        <div style={{ paddingLeft: 8, marginTop: 4 }}>
          <ErtJobIndicator
            dataset={{
              datasetId: programme.datasetId,
              serverName: programme.edm.serverName,
              edmDatabaseName: programme.edm.edmDatabaseName,
              treatyYear: programme.treatyYear,
              currency: programme.edm.currency,
              ertStatus: ert,
              availableGranularity: programme.edm.availableGranularity,
              isIncludedInPortfolio: true,
            }}
          />
        </div>
      )}
    </li>
  );
}
