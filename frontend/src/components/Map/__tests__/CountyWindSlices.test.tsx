import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CountyWindSlices } from "../CountyWindSlices";
import { DEFAULTS } from "../../../state/damageAssumptions";

describe("CountyWindSlices", () => {
  it("rounds a calibrated damage ratio to one decimal place", () => {
    render(
      <CountyWindSlices
        bands={[{ category: 4, areaFraction: 1, maxWindKt: 135 }]}
        tiv={1_000_000}
        scale={1}
        byCategory={{
          ...DEFAULTS,
          4: { mean: 17.768935967305616, sd: 0, lowFactor: 0.95, highFactor: 1.33 },
        }}
        currency="USD"
      />,
    );
    expect(screen.getByText(/DR 17\.8%/)).toBeTruthy();
    expect(screen.queryByText(/17\.768/)).toBeNull();
  });
});
