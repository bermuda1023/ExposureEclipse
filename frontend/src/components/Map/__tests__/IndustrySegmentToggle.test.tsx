import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IndustrySegmentToggle } from "../IndustrySegmentToggle";
import { useFiltersStore } from "../../../state/filters";
import { useSelectionStore } from "../../../state/selection";

function renderToggle() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IndustrySegmentToggle />
    </QueryClientProvider>,
  );
}

describe("IndustrySegmentToggle", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    useFiltersStore.getState().reset();
    useSelectionStore.getState().clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is hidden for other clients", () => {
    useSelectionStore.getState().selectCedent("ced-farmers");
    renderToggle();
    expect(screen.queryByRole("group", { name: "Industry segments" })).toBeNull();
  });

  it("defaults to all three on and sends no filter", () => {
    useSelectionStore.getState().selectCedent("ced-industry");
    renderToggle();
    for (const name of ["Residential", "Commercial", "Auto"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    }
    expect(useFiltersStore.getState().occupancySegment).toEqual([]);
  });

  it("filters to the chosen segments and keeps at least one on", () => {
    useSelectionStore.getState().selectCedent("ced-industry");
    renderToggle();
    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(useFiltersStore.getState().occupancySegment).toEqual(["RESIDENTIAL", "COMMERCIAL"]);
    fireEvent.click(screen.getByRole("button", { name: "Commercial" }));
    expect(useFiltersStore.getState().occupancySegment).toEqual(["RESIDENTIAL"]);
    fireEvent.click(screen.getByRole("button", { name: "Residential" }));
    expect(useFiltersStore.getState().occupancySegment).toEqual(["RESIDENTIAL"]);
    fireEvent.click(screen.getByRole("button", { name: "Commercial" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(useFiltersStore.getState().occupancySegment).toEqual([]);
  });

  it("clears the segment filter when leaving the Industry client", () => {
    useSelectionStore.getState().selectCedent("ced-industry");
    renderToggle();
    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(useFiltersStore.getState().occupancySegment).not.toEqual([]);
    act(() => useSelectionStore.getState().selectCedent("ced-farmers"));
    expect(useFiltersStore.getState().occupancySegment).toEqual([]);
  });
});
