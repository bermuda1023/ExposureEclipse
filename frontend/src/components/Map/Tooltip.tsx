/**
 * Hover tooltip — values AND explanations (MAPBOX_SPEC.md).
 *
 * The three "share" metrics are easy to confuse; the formula reminder is
 * required, not decorative. null metrics render as "N/A" — never as 0%.
 *
 * The selected metric (the one driving the choropleth fill) is promoted to the
 * top of the tooltip and visually highlighted. In YoY view-mode the prominent
 * block becomes a mini table comparing current vs prior, with both the absolute
 * delta (in the metric's native unit) and the percent change.
 */

import type { MapFeature } from "../../api/types";
import { MetricKey, type CurrencyCode, type AggregationLevel } from "../../types/contracts";
import { formatCount, formatMoneyCompact, formatPercent } from "../../lib/format";

interface Props {
  feature: MapFeature;
  currency: CurrencyCode;
  aggregationLevel: AggregationLevel;
  /** Metric currently driving the map fill. Promoted to the top of the tooltip. */
  selectedMetric: MetricKey;
  /** When true, the prominent block becomes a current-vs-prior mini table. */
  yoyMode?: boolean;
}

/** Native unit of a metric — controls how prior/current/delta are formatted. */
type MetricUnit = "money" | "count" | "ratio";

interface MetricSpec {
  key: MetricKey;
  label: string;
  unit: MetricUnit;
  formula?: string;
  /** Raw current-period value for this metric. Used by the YoY mini-table. */
  rawValue: (f: MapFeature) => number | null;
  /** Display string for the standard (non-YoY) row in the list. */
  render: (f: MapFeature, currency: CurrencyCode) => string;
}

const NA = "N/A";

function pct(value: number | null): string {
  return value === null ? NA : formatPercent(value);
}

function signedPct(value: number | null): string {
  if (value === null) return NA;
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPercent(value)}`;
}

/** Format a value in the metric's native unit. */
function formatNative(value: number | null, unit: MetricUnit, currency: CurrencyCode): string {
  if (value === null || !Number.isFinite(value)) return NA;
  if (unit === "money") return formatMoneyCompact(value, currency);
  if (unit === "count") return formatCount(value);
  return formatPercent(value);
}

/** Signed delta in the metric's native unit (money or count). Ratios render as +/- pp. */
function formatSignedDelta(
  current: number | null,
  prior: number | null,
  unit: MetricUnit,
  currency: CurrencyCode,
): string {
  if (current === null || prior === null) return NA;
  const d = current - prior;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  const abs = Math.abs(d);
  if (unit === "money") return `${sign}${formatMoneyCompact(abs, currency)}`;
  if (unit === "count") return `${sign}${formatCount(abs)}`;
  return `${sign}${(abs * 100).toFixed(1)}pp`;
}

function pctChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return (current - prior) / prior;
}

const METRIC_ORDER: MetricSpec[] = [
  {
    key: MetricKey.TIV,
    label: "TIV",
    unit: "money",
    rawValue: (f) => f.tiv,
    render: (f, c) => formatMoneyCompact(f.tiv, c),
  },
  {
    key: MetricKey.LOCATION_COUNT,
    label: "Location Count",
    unit: "count",
    rawValue: (f) => f.locationCount,
    render: (f) => formatCount(f.locationCount),
  },
  {
    key: MetricKey.DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY,
    label: "Deal Share of Portfolio in Geography",
    unit: "ratio",
    formula: "deal geo TIV ÷ portfolio geo TIV",
    rawValue: (f) => f.dealShareOfPortfolioInGeography,
    render: (f) => pct(f.dealShareOfPortfolioInGeography),
  },
  {
    key: MetricKey.GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO,
    label: "Geography Share of Total Portfolio",
    unit: "ratio",
    formula: "portfolio geo TIV ÷ total portfolio TIV",
    rawValue: (f) => f.geographyShareOfTotalPortfolio,
    render: (f) => pct(f.geographyShareOfTotalPortfolio),
  },
  {
    key: MetricKey.SELECTED_DEAL_GEOGRAPHY_CONCENTRATION,
    label: "Selected Deal Geography Concentration",
    unit: "ratio",
    formula: "deal geo TIV ÷ deal total TIV",
    rawValue: (f) => f.selectedDealGeographyConcentration,
    render: (f) => pct(f.selectedDealGeographyConcentration),
  },
  {
    key: MetricKey.CLIENT_MARKET_SHARE,
    label: "Client Market Share",
    unit: "ratio",
    formula: "client TIV ÷ RMS IED industry TIV",
    rawValue: (f) => f.clientMarketShare,
    render: (f) => pct(f.clientMarketShare),
  },
  {
    key: MetricKey.YOY_CHANGE,
    label: "YoY Change",
    unit: "ratio",
    rawValue: (f) => f.yoyChange,
    render: (f) => signedPct(f.yoyChange),
  },
];

export function MapTooltip({
  feature,
  currency,
  aggregationLevel,
  selectedMetric,
  yoyMode = false,
}: Props) {
  const selected = METRIC_ORDER.find((m) => m.key === selectedMetric);
  const others = METRIC_ORDER.filter((m) => m.key !== selectedMetric);

  return (
    <div
      style={{
        background: "rgba(255,255,255,0.97)",
        border: "1px solid var(--ink-300)",
        borderRadius: "var(--radius)",
        padding: "8px 10px",
        fontSize: "0.78rem",
        maxWidth: 340,
        boxShadow: "var(--shadow-md)",
        lineHeight: 1.4,
        color: "var(--ink-900)",
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {feature.geographyName ?? feature.geographyId}
      </div>
      <div style={{ color: "var(--ink-500)", fontSize: "0.72rem" }}>
        {aggregationLevel} · {currency}
      </div>

      {selected && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "var(--brand-50)",
            border: "1px solid var(--brand-400)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <div
            style={{
              fontSize: "0.66rem",
              color: "var(--brand-700)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 4,
            }}
          >
            {yoyMode ? `Active metric · YoY change of ${selected.label}` : "Active metric"}
          </div>
          {yoyMode ? (
            <YoyMiniTable spec={selected} feature={feature} currency={currency} />
          ) : (
            <Row spec={selected} feature={feature} currency={currency} prominent />
          )}
        </div>
      )}

      <hr style={{ border: "none", borderTop: "1px solid var(--ink-200)", margin: "8px 0 4px" }} />

      {others.map((spec) => (
        <Row key={spec.key} spec={spec} feature={feature} currency={currency} />
      ))}

      {feature.warnings.length > 0 && (
        <div style={{ marginTop: 6, color: "var(--error-700)" }}>
          {feature.warnings.map((w) => (
            <div key={w.code}>⚠ {w.message}</div>
          ))}
        </div>
      )}
      {!feature.hasGeometry && (
        <div style={{ marginTop: 4, color: "var(--ink-500)", fontStyle: "italic" }}>
          (data only — no geometry for this feature)
        </div>
      )}
    </div>
  );
}

/**
 * Mini-table for YoY mode: 2x2 grid showing current vs prior values + the
 * native-unit delta and the percent change. Reads the prior value from
 * `feature.priorMetricValue` (provided by the backend when a comparison
 * dataset is set).
 */
function YoyMiniTable({
  spec,
  feature,
  currency,
}: {
  spec: MetricSpec;
  feature: MapFeature;
  currency: CurrencyCode;
}) {
  const current = spec.rawValue(feature);
  const prior = feature.priorMetricValue ?? null;
  // metricValue in YoY mode is the % change. Use it directly so the value
  // displayed matches the choropleth shading exactly.
  const pctDelta = feature.metricValue ?? pctChange(current, prior);
  const native = formatSignedDelta(current, prior, spec.unit, currency);
  const tone =
    pctDelta === null ? "var(--ink-700)" : pctDelta < 0 ? "var(--error-700)" : "var(--ok-700)";
  const deltaLabel = spec.unit === "ratio" ? "Δ pp" : "Δ";

  return (
    <div style={{ marginTop: 2 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          columnGap: 14,
          rowGap: 0,
        }}
      >
        <Cell label="Current" value={formatNative(current, spec.unit, currency)} />
        <Cell label="Prior" value={formatNative(prior, spec.unit, currency)} />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          columnGap: 14,
          marginTop: 6,
          paddingTop: 6,
          borderTop: "1px dashed var(--ink-200)",
        }}
      >
        <Cell label={deltaLabel} value={native} tone={tone} />
        <Cell label="Δ %" value={signedPct(pctDelta)} tone={tone} prominent />
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
  prominent = false,
}: {
  label: string;
  value: string;
  tone?: string;
  prominent?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: "0.66rem",
          color: "var(--ink-500)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontWeight: 700,
          fontSize: prominent ? "1rem" : "0.92rem",
          color: tone ?? "var(--ink-900)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Row({
  spec,
  feature,
  currency,
  prominent = false,
}: {
  spec: MetricSpec;
  feature: MapFeature;
  currency: CurrencyCode;
  prominent?: boolean;
}) {
  const value = spec.render(feature, currency);
  // Formula reminders intentionally suppressed — they live in the Detail panel,
  // and the tooltip should stay scannable.
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
      <span style={{ color: prominent ? "var(--ink-900)" : "var(--ink-700)" }}>
        {spec.label}
      </span>
      <strong style={{ fontSize: prominent ? "0.92rem" : undefined }}>{value}</strong>
    </div>
  );
}
