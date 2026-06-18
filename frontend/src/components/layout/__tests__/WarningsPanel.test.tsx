import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WarningsPanel } from "../WarningsPanel";
import { WarningCode, WarningSeverity } from "../../../types/contracts";

describe("WarningsPanel", () => {
  it("dedupes identical (code, message) pairs", () => {
    render(
      <WarningsPanel
        warnings={[
          {
            code: WarningCode.WARN_COUNTY_DATA_UNAVAILABLE,
            severity: WarningSeverity.WARN,
            message: "County-level data is not available.",
          },
          {
            code: WarningCode.WARN_COUNTY_DATA_UNAVAILABLE,
            severity: WarningSeverity.WARN,
            message: "County-level data is not available.",
          },
        ]}
      />,
    );
    expect(screen.getAllByText("WARN_COUNTY_DATA_UNAVAILABLE")).toHaveLength(1);
  });

  it("renders empty-state copy when no warnings", () => {
    render(<WarningsPanel warnings={[]} />);
    expect(screen.getByText(/No warnings/i)).toBeInTheDocument();
  });
});
