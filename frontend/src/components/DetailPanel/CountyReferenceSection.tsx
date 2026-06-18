/**
 * County reference panel — population, household counts, avg insured home cost,
 * coastal exposure. Mock data from /api/counties/{geographyId}/reference; in
 * production sourced from US Census + Marshall & Swift.
 *
 * Shown when the detail panel is viewing a county-grain geography OR when the
 * panel is rendering an impacted county from the hurricane-impact view.
 */

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../../api/client";
import { formatCount, formatMoneyCompact } from "../../lib/format";

export interface CountyReference {
  geoid: string;
  state: string;
  population: number;
  households: number;
  avgReplacementCost: number;
  avgInsuredValue: number;
  coastalExposurePct: number;
  source: "curated" | "synthetic";
  currency: string;
}

const fetchReference = (geographyId: string) =>
  apiGet<CountyReference>(`/counties/${encodeURIComponent(geographyId)}/reference`);

export function useCountyReference(geographyId: string | null | undefined) {
  return useQuery({
    queryKey: ["county-reference", geographyId],
    queryFn: () => fetchReference(geographyId as string),
    enabled: Boolean(geographyId),
    staleTime: 60 * 60_000,
    retry: 0,
  });
}

export function CountyReferenceSection({
  geographyId,
}: {
  geographyId: string | null | undefined;
}) {
  const { data, isLoading, error } = useCountyReference(geographyId);
  if (!geographyId) return null;

  return (
    <section
      style={{
        background: "#fff",
        border: "1px solid #eee",
        borderRadius: 4,
        padding: 8,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h4 style={{ margin: "0 0 6px", fontSize: "0.78rem", color: "#333" }}>
          County reference (industry baseline)
        </h4>
        {data && (
          <span style={{ fontSize: "0.62rem", color: "#888" }}>
            source: {data.source === "curated" ? "curated census" : "synthesised"}
          </span>
        )}
      </header>
      {isLoading && (
        <div style={{ color: "#888", fontSize: "0.74rem" }}>Loading county reference…</div>
      )}
      {error && (
        <div style={{ color: "#9b1c1c", fontSize: "0.72rem" }}>
          County reference unavailable.
        </div>
      )}
      {data && (
        <div style={{ display: "grid", gap: 4, fontSize: "0.74rem" }}>
          <Row label="Population" value={formatCount(data.population)} />
          <Row label="Households" value={formatCount(data.households)} />
          <Row
            label="Avg replacement cost (home)"
            value={formatMoneyCompact(data.avgReplacementCost, data.currency)}
            tip="Insurance reconstruction cost per single-family dwelling — based on Marshall & Swift mock baseline."
          />
          <Row
            label="Avg insured value (home)"
            value={formatMoneyCompact(data.avgInsuredValue, data.currency)}
            tip="Replacement cost × 0.85 typical limit factor."
          />
          <Row
            label="Industry housing TIV (est.)"
            value={formatMoneyCompact(
              data.avgInsuredValue * data.households,
              data.currency,
            )}
            tip="avg insured value × households — back-of-envelope industry residential TIV in this county."
          />
          {data.coastalExposurePct > 0 && (
            <Row
              label="Coastal housing share"
              value={`${(data.coastalExposurePct * 100).toFixed(0)}%`}
              tip="Estimated share of housing within 25 miles of the coast."
            />
          )}
        </div>
      )}
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
