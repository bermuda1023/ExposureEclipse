import { API_BASE } from "./client";

/**
 * Phase 8 builds the real Excel export. For Phases 2–7 the UI wires up the
 * button — the backend returns 501 until then.
 */
export async function downloadExcelExport(body: unknown): Promise<Blob> {
  const res = await fetch(`${API_BASE}/exports/excel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
  return res.blob();
}
