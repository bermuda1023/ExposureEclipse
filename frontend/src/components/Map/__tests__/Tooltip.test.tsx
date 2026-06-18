import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MapTooltip } from "../Tooltip";
import {
  AggregationLevel,
  MetricKey,
  WarningCode,
  WarningSeverity,
  YoyStatus,
} from "../../../types/contracts";
import type { MapFeature } from "../../../api/types";

const baseFeature: MapFeature = {
  geographyId: "US-FL",
  geographyName: "Florida",
  metricValue: 12_400_000_000,
  tiv: 12_400_000_000,
  locationCount: 42_318,
  dealShareOfPortfolioInGeography: 0.182,
  geographyShareOfTotalPortfolio: 0.064,
  selectedDealGeographyConcentration: 0.27,
  clientMarketShare: 0.031,
  yoyChange: 0.058,
  yoyStatus: YoyStatus.OK,
  hasGeometry: true,
  warnings: [],
};

describe("MapTooltip", () => {
  it("renders every metric label", () => {
    render(
      <MapTooltip
        feature={baseFeature}
        currency="USD"
        aggregationLevel={AggregationLevel.STATE}
        selectedMetric={MetricKey.TIV}
      />,
    );
    expect(screen.getByText("Florida", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Deal Share of Portfolio in Geography/)).toBeInTheDocument();
    expect(screen.getByText(/Client Market Share/)).toBeInTheDocument();
    // Formula hints were removed — definitions live in the detail panel.
    expect(screen.queryByText(/deal geo TIV ÷ portfolio geo TIV/)).not.toBeInTheDocument();
  });

  it("promotes the selected metric to the Active-metric block", () => {
    render(
      <MapTooltip
        feature={baseFeature}
        currency="USD"
        aggregationLevel={AggregationLevel.STATE}
        selectedMetric={MetricKey.CLIENT_MARKET_SHARE}
      />,
    );
    // The "Active metric" header is only shown when there's a match.
    expect(screen.getByText(/Active metric/i)).toBeInTheDocument();
    // Client Market Share label appears once in the prominent block (and not in the list below).
    const labels = screen.getAllByText(/Client Market Share/);
    expect(labels).toHaveLength(1);
  });

  it("renders N/A (not 0%) for null share metrics", () => {
    render(
      <MapTooltip
        feature={{ ...baseFeature, clientMarketShare: null }}
        currency="USD"
        aggregationLevel={AggregationLevel.STATE}
        selectedMetric={MetricKey.TIV}
      />,
    );
    const cells = screen.getAllByText("N/A");
    expect(cells.length).toBeGreaterThan(0);
  });

  it("renders warnings when present", () => {
    render(
      <MapTooltip
        feature={{
          ...baseFeature,
          warnings: [
            {
              code: WarningCode.WARN_IED_DENOMINATOR_MISSING,
              severity: WarningSeverity.WARN,
              message: "Market share cannot be calculated.",
            },
          ],
        }}
        currency="USD"
        aggregationLevel={AggregationLevel.STATE}
        selectedMetric={MetricKey.TIV}
      />,
    );
    expect(screen.getByText(/Market share cannot be calculated/)).toBeInTheDocument();
  });
});
