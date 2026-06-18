import { describe, expect, it } from "vitest";
import {
  CombinationMethod,
  JobStatus,
  MetricKey,
  Peril,
  WarningCode,
} from "../types/contracts";

describe("contracts mirror (CONTRACTS.md)", () => {
  it("MetricKey TIV exists and is the wire literal", () => {
    expect(MetricKey.TIV).toBe("TIV");
  });

  it("default group combination method is MAX_ACROSS_PERILS_AT_VIEW_GRAIN", () => {
    expect(CombinationMethod.MAX_ACROSS_PERILS_AT_VIEW_GRAIN).toBe(
      "MAX_ACROSS_PERILS_AT_VIEW_GRAIN",
    );
  });

  it("JobStatus values are lowercase on the wire", () => {
    expect(JobStatus.RUNNING).toBe("running");
    expect(JobStatus.QUEUED).toBe("queued");
  });

  it("Peril includes EQ/WS/CS and the filter-only ALL", () => {
    expect(Peril.EQ).toBe("EQ");
    expect(Peril.WS).toBe("WS");
    expect(Peril.CS).toBe("CS");
    expect(Peril.ALL).toBe("ALL");
  });

  it("WarningCode covers max-across-perils warning", () => {
    expect(WarningCode.WARN_DATASET_GROUP_MAX_ACROSS_PERILS).toBe(
      "WARN_DATASET_GROUP_MAX_ACROSS_PERILS",
    );
  });
});
