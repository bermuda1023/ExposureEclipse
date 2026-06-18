/**
 * Detail side panel — populates from POST /api/exposures/detail.
 *
 * Per IMPLEMENTATION_PLAN.md Phase 5 DoD:
 *  - all three "share" metrics labeled DISTINCTLY (avoids the easy-to-confuse trap)
 *  - market share shows N/A + warning on IED gaps (never a fabricated number)
 *  - YoY shows New/Removed/N/A correctly
 *  - currency always shown
 */

import { useMemo } from "react";
import { useCedents, useDetailData } from "../../api/hooks";
import { useFiltersStore } from "../../state/filters";
import { useSelectionStore } from "../../state/selection";
import { useViewStore } from "../../state/view";
import { formatCount, formatMoneyCompact, formatMoneyFull, formatPercent } from "../../lib/format";
import { WarningsPanel } from "../layout/WarningsPanel";
import type { BreakdownRow, DetailRequest } from "../../api/types";
import { YoyStatus } from "../../types/contracts";

export function DetailPanel() {
  const cedentId = useSelectionStore((s) => s.cedentId);
  const officeKey = useSelectionStore((s) => s.officeKey);
  const chainId = useSelectionStore((s) => s.chainId);
  const programmeId = useSelectionStore((s) => s.programmeId);
  const comparisonProgrammeId = useSelectionStore((s) => s.comparisonProgrammeId);
  const aggregationLevel = useViewStore((s) => s.aggregationLevel);
  const metric = useViewStore((s) => s.metric);
  const perils = useViewStore((s) => s.perils);
  const selectedGeographyId = useViewStore((s) => s.selectedGeographyId);
  const setSelected = useViewStore((s) => s.setSelectedGeographyId);
  const filters = useFiltersStore();
  const cedentsQuery = useCedents();

  const officeChainIds = useMemo<string[]>(() => {
    if (!officeKey || !cedentsQuery.data) return [];
    const cedent = cedentsQuery.data.cedents.find((c) => c.cedentId === officeKey.cedentId);
    if (!cedent) return [];
    return cedent.chains.filter((ch) => ch.office === officeKey.office).map((ch) => ch.chainId);
  }, [officeKey, cedentsQuery.data]);

  const request = useMemo<DetailRequest | null>(() => {
    if (!selectedGeographyId) return null;
    if (!cedentId && !chainId && !programmeId && officeChainIds.length === 0) return null;
    return {
      cedentId,
      chainId,
      chainIds: officeChainIds.length > 0 ? officeChainIds : undefined,
      programmeId,
      aggregationLevel,
      metric,
      geographyId: selectedGeographyId,
      comparisonProgrammeId,
      perils,
      filters: {
        peril: filters.peril,
        occupancy: filters.occupancy,
        distanceToCoast: filters.distanceToCoast,
        geocoding: filters.geocoding,
        construction: filters.construction,
        numberOfStories: filters.numberOfStories,
        yearBuilt: filters.yearBuilt,
      },
    };
  }, [
    selectedGeographyId,
    cedentId,
    chainId,
    programmeId,
    officeChainIds,
    comparisonProgrammeId,
    aggregationLevel,
    metric,
    perils,
    filters.peril,
    filters.occupancy,
    filters.distanceToCoast,
    filters.geocoding,
    filters.construction,
    filters.numberOfStories,
    filters.yearBuilt,
  ]);

  const { data, isLoading, error } = useDetailData(request);

  if (!selectedGeographyId) {
    return (
      <div style={{ color: "#666", fontSize: "0.78rem" }}>
        Click a geography on the map to load detail.
      </div>
    );
  }

  if (isLoading) return <div style={{ fontSize: "0.78rem" }}>Loading detail…</div>;
  if (error)
    return (
      <div style={{ color: "#b00020", fontSize: "0.78rem" }}>
        Failed to load detail: {String((error as Error)?.message ?? error)}
      </div>
    );
  if (!data) return null;

  const currency = data.currency;
  const yoyChange = data.yoy.change;
  const yoyLabel = yoyLabelFor(data.yoy.status, yoyChange);

  return (
    <div style={{ display: "grid", gap: 10, fontSize: "0.82rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h3 style={{ margin: 0, fontSize: "0.95rem" }}>
            {data.geographyName ?? data.geographyId}
          </h3>
          <div style={{ color: "#777", fontSize: "0.72rem" }}>
            {data.aggregationLevel} · currency <code>{currency}</code>
          </div>
        </div>
        <button onClick={() => setSelected(null)} aria-label="Close detail">
          ✕
        </button>
      </header>

      <Section title="Summary">
        <Row label="TIV" value={formatMoneyFull(data.summary.tiv, currency)} />
        <Row label="Locations" value={formatCount(data.summary.locationCount)} />
        <Row
          label="Deal share of portfolio in geography"
          value={formatPercent(data.summary.dealShareOfPortfolioInGeography)}
          tip="deal geo TIV ÷ portfolio geo TIV"
        />
        <Row
          label="Geography share of total portfolio"
          value={formatPercent(data.summary.geographyShareOfTotalPortfolio)}
          tip="portfolio geo TIV ÷ total portfolio TIV"
        />
        <Row
          label="Selected deal geography concentration"
          value={formatPercent(data.summary.selectedDealGeographyConcentration)}
          tip="deal geo TIV ÷ deal total TIV"
        />
      </Section>

      <Section title="Deal vs portfolio">
        <Row label="Deal TIV" value={formatMoneyCompact(data.dealVsPortfolio.dealTiv, currency)} />
        <Row
          label="Portfolio TIV"
          value={formatMoneyCompact(data.dealVsPortfolio.portfolioTiv, currency)}
        />
      </Section>

      <Section title={`Client market share — ${data.marketShare.segment}`}>
        <Row label="Client TIV" value={formatMoneyCompact(data.marketShare.clientTiv, currency)} />
        <Row
          label="Industry TIV (RMS IED)"
          value={formatMoneyCompact(data.marketShare.industryTiv, currency)}
        />
        <Row label="Share" value={formatPercent(data.marketShare.share)} />
        {data.marketShare.share === null && (
          <p style={{ color: "#664d03", margin: "4px 0 0", fontSize: "0.74rem" }}>
            Market share unavailable — see warning below.
          </p>
        )}
      </Section>

      <Section title="Year-over-year">
        <Row
          label="Current TIV"
          value={formatMoneyCompact(data.yoy.currentTiv, currency)}
        />
        <Row label="Prior TIV" value={formatMoneyCompact(data.yoy.priorTiv, currency)} />
        <Row label="YoY status" value={yoyLabel} />
        {data.yoy.status === YoyStatus.OK && (
          <Row label="Change" value={signedPercent(yoyChange)} />
        )}
      </Section>

      <Section title="Breakdowns">
        <Breakdown title="Peril" rows={data.breakdowns.peril} currency={currency} />
        <Breakdown title="Occupancy" rows={data.breakdowns.occupancy} currency={currency} />
        <Breakdown
          title="Distance to coast"
          rows={data.breakdowns.distanceToCoast}
          currency={currency}
        />
        <Breakdown title="Geocoding" rows={data.breakdowns.geocoding} currency={currency} />
        <Breakdown title="Stories" rows={data.breakdowns.stories} currency={currency} />
        <Breakdown title="Construction" rows={data.breakdowns.construction} currency={currency} />
      </Section>

      <Section title="Active filters">
        <pre style={{ background: "#f4f4f4", padding: 6, fontSize: "0.72rem", overflow: "auto" }}>
          {JSON.stringify(data.activeFilters, null, 2)}
        </pre>
      </Section>

      <Section title="Warnings">
        <WarningsPanel warnings={data.warnings} />
      </Section>
    </div>
  );
}

function yoyLabelFor(status: YoyStatus, change: number | null): string {
  switch (status) {
    case YoyStatus.OK:
      return change === null ? "OK" : `OK · ${signedPercent(change)}`;
    case YoyStatus.NEW:
      return "NEW (no prior)";
    case YoyStatus.REMOVED:
      return "REMOVED (no current)";
    case YoyStatus.NA:
    default:
      return "N/A";
  }
}

function signedPercent(value: number | null): string {
  if (value === null) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPercent(value)}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: "#fff",
        border: "1px solid #eee",
        borderRadius: 4,
        padding: 8,
      }}
    >
      <h4 style={{ margin: "0 0 6px", fontSize: "0.78rem", color: "#333" }}>{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, value, tip }: { label: string; value: string; tip?: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
      <span title={tip} style={{ color: "#444" }}>
        {label}
        {tip && <span style={{ color: "#999" }}>  ⓘ</span>}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  currency,
}: {
  title: string;
  rows: BreakdownRow[];
  currency: string;
}) {
  if (rows.length === 0) {
    return (
      <div style={{ marginBottom: 6 }}>
        <div style={{ color: "#777", fontSize: "0.72rem" }}>{title}: (no rows)</div>
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: "#444", fontSize: "0.72rem", marginBottom: 2 }}>{title}</div>
      <table style={{ width: "100%", fontSize: "0.72rem", borderCollapse: "collapse" }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ borderBottom: "1px solid #f3f3f3" }}>
              <td style={{ padding: "2px 4px" }}>{r.key}</td>
              <td style={{ padding: "2px 4px", textAlign: "right" }}>
                {formatMoneyCompact(r.tiv, currency)}
              </td>
              <td style={{ padding: "2px 4px", textAlign: "right", color: "#777" }}>
                {formatCount(r.locationCount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
