import { MetricKey } from "../../types/contracts";
import { useViewStore } from "../../state/view";

// YOY_CHANGE used to live here; it's now a toggle (YoyToggle.tsx) applied to
// whatever metric is selected here.
const LABELS: Partial<Record<MetricKey, string>> = {
  [MetricKey.TIV]: "TIV",
  [MetricKey.LOCATION_COUNT]: "Location count",
  [MetricKey.DEAL_SHARE_OF_PORTFOLIO_IN_GEOGRAPHY]: "Deal share of portfolio in geography",
  [MetricKey.GEOGRAPHY_SHARE_OF_TOTAL_PORTFOLIO]: "Geography share of total portfolio",
  [MetricKey.SELECTED_DEAL_GEOGRAPHY_CONCENTRATION]: "Selected deal geography concentration",
  [MetricKey.CLIENT_MARKET_SHARE]: "Client market share",
};

const OPTIONS = Object.keys(LABELS) as MetricKey[];

export function MetricSelector() {
  const metric = useViewStore((s) => s.metric);
  const setMetric = useViewStore((s) => s.setMetric);
  return (
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: "0.75rem", color: "var(--ink-600)" }}>Metric</span>
      <select
        value={metric}
        onChange={(e) => setMetric(e.target.value as MetricKey)}
        style={{ fontSize: "0.85rem", width: "auto" }}
      >
        {OPTIONS.map((m) => (
          <option key={m} value={m}>
            {LABELS[m]}
          </option>
        ))}
      </select>
    </label>
  );
}
