import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { IndustryLossResponse } from "../../../api/industryLoss";

const band = (mean: number) => ({ mean, p10: mean * 0.5, p50: mean * 0.9, p90: mean * 1.6 });

const response: IndustryLossResponse = {
  stormId: "AL092022",
  stormName: "IAN",
  year: 2022,
  trackSource: "ibtracs",
  currency: "USD",
  multiplier: 2.5,
  curveSet: { id: "calibrated-x", label: "Calibrated X", kind: "calibrated", windFactor: 0.8, deductible: {}, sigmaLogCounty: 0.4, sigmaLogEvent: 0.3 },
  tivSource: { kind: "supplied", year: 2022, file: "2022.csv", currency: "USD" },
  formula: "",
  summary: {
    total: band(60e9),
    bySegment: {
      RESIDENTIAL: { ...band(40e9), tiv: 1e12 },
      COMMERCIAL: { ...band(19e9), tiv: 6e11 },
      AUTO: { ...band(1e9), tiv: 8e10 },
    },
    countiesWithLoss: 20,
  },
  actuals: {
    total: 50e9,
    bySegment: { RESIDENTIAL: 32e9, COMMERCIAL: 16e9, AUTO: 2e9 },
    asOfDate: "2024-06-30",
    source: "PCS",
    includesFlood: false,
    includesSurge: null,
  },
  counties: [],
  notes: ["No 2026 TIV supplied; using the 2022 vintage."],
};

const backtestQuery = vi.fn();

vi.mock("../../../api/hooks", () => ({
  useDamageCurves: () => ({
    data: {
      defaultId: "calibrated-x",
      curveSets: [
        { id: "calibrated-x", label: "Calibrated X" },
        { id: "kcc", label: "KCC (Form V-1)" },
      ],
    },
  }),
  useIndustryLoss: () => ({ data: response, isLoading: false, error: null }),
  useIndustryBacktest: (...args: unknown[]) => {
    backtestQuery(...args);
    return { data: undefined, isLoading: true };
  },
}));

import { IndustryLossSection } from "../IndustryLossSection";

describe("IndustryLossSection", () => {
  it("shows modelled P50 and actuals by segment with the ratio", () => {
    render(<IndustryLossSection stormId="AL092022" />);
    expect(screen.getByText("Residential")).toBeTruthy();
    expect(screen.getByText("Auto")).toBeTruthy();
    expect(screen.getByText("36.0B USD")).toBeTruthy(); // residential P50
    expect(screen.getByText("50.0B USD")).toBeTruthy(); // actual total
    expect(screen.getByText("×1.20 mean")).toBeTruthy(); // 60 / 50
    expect(screen.getByText(/using the 2022 vintage/)).toBeTruthy();
    expect(screen.getByText(/actuals PCS as of 2024-06-30/)).toBeTruthy();
  });

  it("asks for the backtest only when opened", () => {
    render(<IndustryLossSection stormId="AL092022" />);
    expect(backtestQuery).toHaveBeenLastCalledWith("AL092022", "calibrated-x", false);
    fireEvent.click(screen.getByText("Show county backtest"));
    expect(backtestQuery).toHaveBeenLastCalledWith("AL092022", "calibrated-x", true);
  });
});
