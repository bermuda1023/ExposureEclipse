/** Admin endpoints — treaty metadata + EDM linkage. */

import { API_BASE, apiGet, apiPost, request } from "./client";

export interface TreatyRow {
  fsDisplayId: string;
  reinsuredName: string;
  brokerName: string;
  brokerOffice: string | null;
  layerNumber: number;
  inceptionDate: string;
  layerStatus: string;
  riskId: string;
  currency: string;
  weightedSharePct: number;
  signedLinePct: number;
  riskLocation: string;
  tji: string | null;
  cob1: string | null;
  cob2: string | null;
  cob3: string | null;
  eventLimitUsd: number;
  deductibleUsd: number;
  rolPct: number;
  gulPct: number;
}

export interface TreatyView {
  treaty: TreatyRow;
  serverName: string | null;
  edmDatabaseName: string | null;
  status: "mapped" | "unmapped";
  suggestedServer: string | null;
  suggestedEdm: string | null;
}

export interface ProgrammesListResponse {
  rows: TreatyView[];
  mappedCount: number;
  unmappedCount: number;
}

export interface EDMLinkInput {
  serverName: string | null;
  edmDatabaseName: string | null;
}

export const fetchAdminProgrammes = () =>
  apiGet<ProgrammesListResponse>("/admin/programmes");

export const updateEdmLink = (fsDisplayId: string, link: EDMLinkInput) =>
  request<TreatyView>(`/admin/programmes/${encodeURIComponent(fsDisplayId)}/edm-link`, {
    method: "PUT",
    body: link,
  });

export const bulkSaveLinks = (links: Record<string, EDMLinkInput>) =>
  apiPost<ProgrammesListResponse>("/admin/programmes/edm-links", { links });

/** Raw-CSV upload — content-type text/csv, body is the file contents. */
export async function importTreatyCsv(csvBody: string): Promise<ProgrammesListResponse> {
  const resp = await fetch(`${API_BASE}/admin/programmes/import`, {
    method: "POST",
    headers: { "content-type": "text/csv", accept: "application/json" },
    body: csvBody,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Import failed (${resp.status}): ${text}`);
  }
  return resp.json();
}
