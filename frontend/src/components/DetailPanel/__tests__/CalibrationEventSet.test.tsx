import { render, screen } from "@testing-library/react";
import type { CalibratedCurve } from "../../../state/damageAssumptions";
import { CalibrationEventSet, PanelBandNote, rangeLabel } from "../CalibrationEventSet";

const metrics = { pcsLoss: 1, noTivShare: 0, outsideFootprintShare: 0.07, stallHours: 24 };

const curve: CalibratedCurve = {
  id: "calibrated-test",
  label: "Test",
  bandMid: [45.5],
  dr: [0.01],
  windFactor: 0.8,
  windExponent: 0,
  windFloor: 0,
  sigmaLogEvent: 0.8,
  panelBand: {
    lowFactor: 0.596,
    highFactor: 1.862,
    coverageTarget: 0.8,
    coveredEvents: 6,
    scorableEvents: 7,
    suppliedEvents: 15,
    outsideEvents: ["AL092021"],
    basis: "test",
    events: [
      { stormId: "AL092022", name: "Ian", trained: true, reasons: [], actual: 1, model: 1, factor: 0.948, withinRange: true },
      { stormId: "AL192020", name: "Sally", trained: false, reasons: ["stalled"], actual: 1, model: 1, factor: 2.082, withinRange: false },
    ],
  },
  eventSet: [
    { stormId: "AL092022", name: "Ian", year: 2022, included: true, reasons: [], mechanism: "Wind.", metrics },
    {
      stormId: "AL192020", name: "Sally", year: 2020, included: false, reasons: ["stalled"],
      mechanism: "Crawled ashore.", metrics: { ...metrics, stallHours: 51 },
    },
  ],
  eventRules: {},
};

describe("calibration event set", () => {
  it("labels the range by its coverage target", () => {
    expect(rangeLabel(curve)).toBe("PCS holdout 80% range");
  });

  it("scores a training storm against the range", () => {
    render(<PanelBandNote curve={curve} stormId="al092022" />);
    expect(screen.getByText(/6 of 7 wind-dominant PCS events/)).toBeInTheDocument();
    expect(screen.getByText(/held out it scored 0.95×/)).toBeInTheDocument();
  });

  it("says the range does not apply to an excluded storm", () => {
    render(<PanelBandNote curve={curve} stormId="AL192020" />);
    expect(screen.getByText(/Sally is excluded from calibration/)).toBeInTheDocument();
    expect(screen.getByText(/The range does not apply/)).toBeInTheDocument();
  });

  it("lists included and excluded storms with the reason", () => {
    render(<CalibrationEventSet curve={curve} />);
    expect(screen.getByText(/Included: 1 wind-dominant storms/)).toBeInTheDocument();
    expect(screen.getByText("Stalled, rain-driven")).toBeInTheDocument();
    expect(screen.getByText(/51 h within 100 nm of landfall/)).toBeInTheDocument();
  });
});
