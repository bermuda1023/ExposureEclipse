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
import type { Cedent, Programme, ProgrammeChain } from "../../api/cedents";
import { ErtBadge } from "./ErtBadge";
import { ErtStatus } from "../../types/contracts";
import { ErtJobIndicator } from "../ErtJob/ErtJobIndicator";

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
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
  const [officeFilter, setOfficeFilter] = useState<string>("");

  const allOffices = useMemo(() => {
    if (!data) return [];
    const offices = new Set<string>();
    for (const c of data.cedents) for (const ch of c.chains) offices.add(ch.office);
    return uniq([...offices]).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.cedents
      .map((c) => ({
        ...c,
        chains: c.chains.filter((ch) => !officeFilter || ch.office === officeFilter),
      }))
      .filter((c) => {
        if (officeFilter && c.chains.length === 0) return false;
        if (!q) return true;
        const haystack =
          `${c.cedentName} ${c.chains.map((ch) => `${ch.chainName} ${ch.office}`).join(" ")}`.toLowerCase();
        return haystack.includes(q);
      });
  }, [data, search, officeFilter]);

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
        <label style={{ display: "grid", gap: 3 }}>
          Office
          <select
            value={officeFilter}
            onChange={(e) => setOfficeFilter(e.target.value)}
            aria-label="Office filter"
          >
            <option value="">(any)</option>
            {allOffices.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <button
          type="button"
          onClick={() => selectChain(isChainSelected ? null : chain.chainId)}
          style={{ all: "unset", cursor: "pointer", flex: 1, minWidth: 0 }}
          title="Pick this chain — latest vs prior auto-pairs for YoY"
        >
          <div
            style={{
              fontWeight: 600,
              color: "var(--ink-900)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {chain.chainName}
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
        <ErtBadge status={ert} />
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
