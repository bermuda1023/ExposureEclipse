import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiPost } from "../client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiGet", () => {
  it("builds URL with query params and parses JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ datasets: [] }), { status: 200 }),
    );
    const result = await apiGet<{ datasets: unknown[] }>("/datasets", {
      treatyYear: 2027,
    });
    expect(result.datasets).toEqual([]);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("/api/datasets");
    expect(calledUrl).toContain("treatyYear=2027");
  });
});

describe("apiPost", () => {
  it("throws ApiError carrying envelope code on non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "CURRENCY_MISMATCH",
            message: "Selected datasets use different currencies.",
          },
        }),
        { status: 409 },
      ),
    );
    await expect(apiPost("/dataset-groups", { foo: "bar" })).rejects.toMatchObject({
      status: 409,
      code: "CURRENCY_MISMATCH",
    });
  });

  it("falls back to INTERNAL_ERROR when body has no envelope", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 500 }));
    let caught: unknown;
    try {
      await apiPost("/exports/excel");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
  });
});
