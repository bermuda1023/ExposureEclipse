/**
 * Pivot workbench — simplified builder per IMPLEMENTATION_PLAN.md Phase 7.
 *
 * Pivot uses the SAME calc service as map/detail (CALCULATION_RULES.md). The
 * combined rows+columns set IS the view grain — group max-across-perils is
 * computed at that grain (CONTRACTS.md §13).
 */

import { useMemo, useState } from "react";
import { usePivotData } from "../../api/hooks";
import { useFiltersStore } from "../../state/filters";
import { useSelectionStore } from "../../state/selection";
import { useViewStore } from "../../state/view";
import { useEffectiveScope } from "../../state/useEffectiveScope";
import {
  AggregationLevel,
  Measure,
  type Measure as MeasureType,
} from "../../types/contracts";
import type { PivotRequest } from "../../api/types";
import { formatCount, formatMoneyCompact } from "../../lib/format";
import { WarningsPanel } from "../layout/WarningsPanel";

// Valid pivot dimension keys = aggregation levels + canonical breakdown keys.
const DIMENSIONS = [
  AggregationLevel.COUNTRY,
  AggregationLevel.STATE,
  AggregationLevel.COUNTY,
  AggregationLevel.CRESTA,
  "PERIL",
  "OCCUPANCY",
  "CONSTRUCTION",
  "DISTANCE_TO_COAST",
  "GEOCODING",
  "NUMBER_OF_STORIES",
  "DATASET",
  "DATASET_GROUP",
  "CURRENCY",
  "TREATY_YEAR",
] as const;

const MEASURES: MeasureType[] = [
  Measure.TIV,
  Measure.BUILDING,
  Measure.CONTENTS,
  Measure.BI,
  Measure.EXPLIM_GR,
  Measure.EXPLIM_NET,
  Measure.LOCATION_COUNT,
  Measure.ACCOUNT_COUNT,
  Measure.INVALID_TIV,
  Measure.INVALID_COUNT,
];

const MONEY_MEASURES: ReadonlySet<MeasureType> = new Set([
  Measure.TIV,
  Measure.BUILDING,
  Measure.CONTENTS,
  Measure.BI,
  Measure.EXPLIM_GR,
  Measure.EXPLIM_NET,
  Measure.INVALID_TIV,
]);

export function Pivot() {
  const scope = useEffectiveScope();
  const comparisonProgrammeId = useSelectionStore((s) => s.comparisonProgrammeId);
  const perils = useViewStore((s) => s.perils);
  const filters = useFiltersStore();

  const [rows, setRows] = useState<string[]>([AggregationLevel.STATE]);
  const [columns, setColumns] = useState<string[]>(["PERIL"]);
  const [measures, setMeasures] = useState<MeasureType[]>([Measure.TIV, Measure.LOCATION_COUNT]);

  // Pivot fires for any scope the map fires for, including portfolio mode.
  const request = useMemo<PivotRequest | null>(() => {
    if (measures.length === 0) return null;
    return {
      cedentId: scope.cedentId,
      chainId: scope.chainId,
      chainIds: scope.chainIds,
      programmeId: scope.programmeId,
      rows,
      columns,
      measures,
      filters: {
        peril: filters.peril,
        occupancy: filters.occupancy,
        distanceToCoast: filters.distanceToCoast,
        geocoding: filters.geocoding,
        construction: filters.construction,
        numberOfStories: filters.numberOfStories,
        yearBuilt: filters.yearBuilt,
      },
      comparisonProgrammeId,
      perils,
    };
  }, [
    scope.cedentId,
    scope.chainId,
    scope.programmeId,
    scope.chainIds,
    comparisonProgrammeId,
    perils,
    rows,
    columns,
    measures,
    filters.peril,
    filters.occupancy,
    filters.distanceToCoast,
    filters.geocoding,
    filters.construction,
    filters.numberOfStories,
    filters.yearBuilt,
  ]);

  const { data, isLoading, error } = usePivotData(request);

  const colKeys = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    const out: string[][] = [];
    for (const cell of data.cells) {
      const k = JSON.stringify(cell.colKey);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(cell.colKey);
      }
    }
    return out;
  }, [data]);

  const rowKeys = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    const out: string[][] = [];
    for (const cell of data.cells) {
      const k = JSON.stringify(cell.rowKey);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(cell.rowKey);
      }
    }
    return out;
  }, [data]);

  const cellMap = useMemo(() => {
    const m = new Map<string, Record<string, number | null>>();
    if (data) {
      for (const c of data.cells) m.set(`${JSON.stringify(c.rowKey)}|${JSON.stringify(c.colKey)}`, c.values);
    }
    return m;
  }, [data]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <DimensionPicker label="Rows" value={rows} onChange={setRows} />
        <DimensionPicker label="Columns" value={columns} onChange={setColumns} />
        <MeasurePicker value={measures} onChange={setMeasures} />
      </div>
      <p style={{ margin: 0, fontSize: "0.72rem", color: "#666" }}>
        View grain (CONTRACTS.md §13) = <code>{[...rows, ...columns].join(" × ")}</code> · max-
        across-perils for groups is computed at this grain.
      </p>
      {!request && (
        <p style={{ color: "#666", fontSize: "0.85rem" }}>
          Pick at least one measure.
        </p>
      )}
      {isLoading && <p>Loading pivot…</p>}
      {error ? (
        <p style={{ color: "#b00020" }}>
          Pivot failed: {String((error as Error)?.message ?? error)}
        </p>
      ) : null}
      {data && (
        <div style={{ overflow: "auto" }}>
          <p style={{ margin: 0, color: "#555", fontSize: "0.78rem" }}>
            {data.cells.length} cells · currency <code>{data.currency}</code>
          </p>
          <table
            style={{
              borderCollapse: "collapse",
              fontSize: "0.78rem",
              marginTop: 8,
              minWidth: 480,
            }}
          >
            <thead>
              <tr>
                {rows.map((r) => (
                  <th key={r} style={head}>
                    {r}
                  </th>
                ))}
                {colKeys.map((ck) => (
                  <th key={JSON.stringify(ck)} style={head} colSpan={measures.length}>
                    {ck.join(" / ") || "(all)"}
                  </th>
                ))}
              </tr>
              <tr>
                {rows.map((r) => (
                  <th key={`m-${r}`} style={head} />
                ))}
                {colKeys.flatMap((ck) =>
                  measures.map((m) => (
                    <th key={`${JSON.stringify(ck)}-${m}`} style={subHead}>
                      {m}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {rowKeys.map((rk) => (
                <tr key={JSON.stringify(rk)} style={{ borderTop: "1px solid #f3f3f3" }}>
                  {rk.map((part, i) => (
                    <td key={i} style={body}>
                      {part}
                    </td>
                  ))}
                  {colKeys.flatMap((ck) => {
                    const values = cellMap.get(
                      `${JSON.stringify(rk)}|${JSON.stringify(ck)}`,
                    );
                    return measures.map((m) => {
                      const v = values?.[m] ?? null;
                      return (
                        <td key={`${JSON.stringify(ck)}-${m}`} style={{ ...body, textAlign: "right" }}>
                          {MONEY_MEASURES.has(m)
                            ? formatMoneyCompact(v, data.currency)
                            : formatCount(v)}
                        </td>
                      );
                    });
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {data.warnings.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <WarningsPanel warnings={data.warnings} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DimensionPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset style={{ border: "1px solid #ddd", padding: 6, borderRadius: 4 }}>
      <legend style={{ fontSize: "0.75rem" }}>{label}</legend>
      <select
        multiple
        value={value}
        onChange={(e) =>
          onChange(Array.from(e.target.selectedOptions).map((o) => o.value))
        }
        style={{ width: "100%", fontSize: "0.78rem", minHeight: 80 }}
      >
        {DIMENSIONS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

function MeasurePicker({
  value,
  onChange,
}: {
  value: MeasureType[];
  onChange: (v: MeasureType[]) => void;
}) {
  return (
    <fieldset style={{ border: "1px solid #ddd", padding: 6, borderRadius: 4 }}>
      <legend style={{ fontSize: "0.75rem" }}>Measures</legend>
      <select
        multiple
        value={value}
        onChange={(e) =>
          onChange(
            Array.from(e.target.selectedOptions).map((o) => o.value as MeasureType),
          )
        }
        style={{ width: "100%", fontSize: "0.78rem", minHeight: 80 }}
      >
        {MEASURES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </fieldset>
  );
}

const head: React.CSSProperties = {
  padding: "4px 8px",
  background: "#f5f5f5",
  borderBottom: "1px solid #ddd",
  textAlign: "left",
  fontWeight: 600,
};
const subHead: React.CSSProperties = { ...head, background: "#fafafa", fontSize: "0.72rem" };
const body: React.CSSProperties = { padding: "3px 8px" };
