/**
 * Excel export trigger — POSTs the current view to /api/exports/excel and saves the xlsx.
 *
 * Numbers in the workbook match screen/API exactly (the backend rebuilds map/
 * detail/pivot responses from the same request and writes those). Here we
 * just forward whatever the user is looking at right now.
 */

import { useMemo, useState } from "react";
import { downloadExcelExport } from "../../api/exports";
import { useCedents } from "../../api/hooks";
import { useFiltersStore } from "../../state/filters";
import { useSelectionStore } from "../../state/selection";
import { useViewStore } from "../../state/view";

export function ExportButton() {
  const cedentId = useSelectionStore((s) => s.cedentId);
  const officeKey = useSelectionStore((s) => s.officeKey);
  const chainId = useSelectionStore((s) => s.chainId);
  const programmeId = useSelectionStore((s) => s.programmeId);
  const comparisonProgrammeId = useSelectionStore((s) => s.comparisonProgrammeId);
  const aggregationLevel = useViewStore((s) => s.aggregationLevel);
  const metric = useViewStore((s) => s.metric);
  const perils = useViewStore((s) => s.perils);
  const selectedGeographyId = useViewStore((s) => s.selectedGeographyId);
  const filters = useFiltersStore();
  const cedentsQuery = useCedents();

  const officeChainIds = useMemo<string[]>(() => {
    if (!officeKey || !cedentsQuery.data) return [];
    const cedent = cedentsQuery.data.cedents.find((c) => c.cedentId === officeKey.cedentId);
    if (!cedent) return [];
    return cedent.chains.filter((ch) => ch.office === officeKey.office).map((ch) => ch.chainId);
  }, [officeKey, cedentsQuery.data]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSelection = Boolean(cedentId || chainId || programmeId || officeChainIds.length > 0);
  const disabled = busy || !hasSelection;

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <button
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const blob = await downloadExcelExport({
              cedentId,
              chainId,
              chainIds: officeChainIds.length > 0 ? officeChainIds : undefined,
              programmeId,
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
        disabled={disabled}
      >
        {busy ? "Building workbook…" : "Export to Excel"}
      </button>
      {error && (
        <span style={{ color: "var(--error-700)", fontSize: "0.72rem" }}>{error}</span>
      )}
    </div>
  );
}
