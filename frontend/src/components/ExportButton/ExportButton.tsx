/**
 * Excel export trigger — POSTs the current view to /api/exports/excel and saves the xlsx.
 *
 * Numbers in the workbook match screen/API exactly (the backend rebuilds map/
 * detail/pivot responses from the same request and writes those). Here we
 * just forward whatever the user is looking at right now.
 */

import { useState } from "react";
import { downloadExcelExport } from "../../api/exports";
import { useFiltersStore } from "../../state/filters";
import { useSelectionStore } from "../../state/selection";
import { useViewStore } from "../../state/view";
import { useEffectiveScope } from "../../state/useEffectiveScope";

export function ExportButton() {
  const scope = useEffectiveScope();
  const comparisonProgrammeId = useSelectionStore((s) => s.comparisonProgrammeId);
  const aggregationLevel = useViewStore((s) => s.aggregationLevel);
  const metric = useViewStore((s) => s.metric);
  const perils = useViewStore((s) => s.perils);
  const selectedGeographyId = useViewStore((s) => s.selectedGeographyId);
  const filters = useFiltersStore();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <button
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const blob = await downloadExcelExport({
              cedentId: scope.cedentId,
              chainId: scope.chainId,
              chainIds: scope.chainIds,
              programmeId: scope.programmeId,
              comparisonProgrammeId,
              perils,
              aggregationLevel,
              metric,
              filters: {
                peril: filters.peril,
                occupancy: filters.occupancy,
                distanceToCoast: filters.distanceToCoast,
                geocoding: filters.geocoding,
                construction: filters.construction,
                numberOfStories: filters.numberOfStories,
                yearBuilt: filters.yearBuilt,
              },
              selectedGeographyId,
              pivot: {
                rows: [aggregationLevel],
                columns: ["PERIL"],
                measures: ["TIV", "LOCATION_COUNT"],
              },
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "exposure-eclipse-export.xlsx";
            a.click();
            URL.revokeObjectURL(url);
          } catch (e) {
            setError(String((e as Error)?.message ?? e));
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        title={
          scope.hasExplicit
            ? "Export the current selection to Excel"
            : scope.hasScopeFilter
              ? "Export the filtered scope to Excel"
              : "Export the in-force portfolio to Excel"
        }
      >
        {busy ? "Building workbook…" : "Export to Excel"}
      </button>
      {error && (
        <span style={{ color: "var(--error-700)", fontSize: "0.72rem" }}>{error}</span>
      )}
    </div>
  );
}
