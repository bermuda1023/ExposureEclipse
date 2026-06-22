/**
 * Treaty metadata + EDM linkage admin page.
 *
 * Production flow this stands in for:
 *   Inwards business system → exports treaty extract (xlsx/csv) → ops drops
 *   the file here → maps each programme to its EDM (server + database) →
 *   exposure-eclipse pulls facts via the mapped EDM going forward.
 *
 * Today the file/datafeed is manual; long-term it'll be an automated feed
 * that lands rows here and only the EDM linkage step needs human review.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bulkSaveLinks,
  fetchAdminProgrammes,
  importTreatyCsv,
  type EDMLinkInput,
  type TreatyView,
} from "../api/admin";

const STATUS_BADGE: Record<string, { bg: string; fg: string; border: string }> = {
  mapped: { bg: "#e8f7ec", fg: "#066c2f", border: "#5cba6a" },
  unmapped: { bg: "#fde9e9", fg: "#9b1c1c", border: "#e07474" },
};

function formatMoney(v: number, currency = "USD"): string {
  if (!v || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B ${currency}`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M ${currency}`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(0)}K ${currency}`;
  return `${v.toFixed(0)} ${currency}`;
}

export function AdminProgrammes() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-programmes"],
    queryFn: fetchAdminProgrammes,
    staleTime: 30_000,
  });

  // Local edits — keyed by fsDisplayId. Saved on click.
  const [edits, setEdits] = useState<Record<string, EDMLinkInput>>({});
  const [importError, setImportError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: () => bulkSaveLinks(mergedLinks(data?.rows ?? [], edits)),
    onSuccess: () => {
      setEdits({});
      qc.invalidateQueries({ queryKey: ["admin-programmes"] });
    },
  });

  const importMutation = useMutation({
    mutationFn: (csv: string) => importTreatyCsv(csv),
    onSuccess: () => {
      setEdits({});
      setImportError(null);
      qc.invalidateQueries({ queryKey: ["admin-programmes"] });
    },
    onError: (e) => setImportError(String((e as Error)?.message ?? e)),
  });

  const dirty = Object.keys(edits).length > 0;

  return (
    <div style={{ padding: 24, maxWidth: 1500, margin: "0 auto", display: "grid", gap: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, color: "var(--ink-900)" }}>Programmes · admin</h1>
          <p style={{ margin: "4px 0 0", color: "var(--ink-600)", fontSize: 13 }}>
            Treaty metadata (broker / cedent / layers) joined to the EDM linkage map. Click a row to edit its
            server + database mapping; auto-suggest uses the existing cedents.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a
            href="/"
            style={{ fontSize: 12, color: "var(--brand-700)", textDecoration: "none", fontWeight: 600 }}
          >
            ← back to workbench
          </a>
        </div>
      </header>

      <Toolbar
        loading={isLoading || saveMutation.isPending || importMutation.isPending}
        mapped={data?.mappedCount ?? 0}
        unmapped={data?.unmappedCount ?? 0}
        dirty={dirty}
        onSave={() => saveMutation.mutate()}
        onImport={async (file) => {
          const text = await file.text();
          importMutation.mutate(text);
        }}
        onReload={() => refetch()}
      />

      {importError && (
        <div
          style={{
            color: "#9b1c1c",
            background: "#fde9e9",
            border: "1px solid #e07474",
            padding: 8,
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {importError}
        </div>
      )}

      {error && (
        <div style={{ color: "#9b1c1c", fontSize: 13 }}>
          Failed to load programmes: {String((error as Error)?.message ?? error)}
        </div>
      )}

      <div style={{ overflow: "auto", border: "1px solid var(--ink-200)", borderRadius: 6 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--ink-50)", color: "var(--ink-700)", textAlign: "left" }}>
              <Th>FS display</Th>
              <Th>Status</Th>
              <Th>Cedent (reinsured)</Th>
              <Th>Broker</Th>
              <Th>Layer</Th>
              <Th>Inception</Th>
              <Th>COB hierarchy</Th>
              <Th align="right">Event limit</Th>
              <Th align="right">Deductible</Th>
              <Th align="right">Wt%</Th>
              <Th align="right">Signed%</Th>
              <Th align="right">ROL</Th>
              <Th>Server (EDM)</Th>
              <Th>Database name</Th>
            </tr>
          </thead>
          <tbody>
            {(data?.rows ?? []).map((row) => (
              <Row
                key={`${row.treaty.fsDisplayId}-L${row.treaty.layerNumber}-${row.treaty.riskId}`}
                row={row}
                edit={edits[row.treaty.fsDisplayId] ?? {
                  serverName: row.serverName,
                  edmDatabaseName: row.edmDatabaseName,
                }}
                isDirty={Boolean(edits[row.treaty.fsDisplayId])}
                onChange={(partial) =>
                  setEdits((prev) => {
                    const current =
                      prev[row.treaty.fsDisplayId] ?? {
                        serverName: row.serverName,
                        edmDatabaseName: row.edmDatabaseName,
                      };
                    return {
                      ...prev,
                      [row.treaty.fsDisplayId]: { ...current, ...partial },
                    };
                  })
                }
                onApplySuggestion={() => {
                  if (!row.suggestedServer && !row.suggestedEdm) return;
                  setEdits((prev) => ({
                    ...prev,
                    [row.treaty.fsDisplayId]: {
                      serverName: row.suggestedServer,
                      edmDatabaseName: row.suggestedEdm,
                    },
                  }));
                }}
              />
            ))}
            {data?.rows.length === 0 && (
              <tr>
                <td colSpan={14} style={{ padding: 20, color: "var(--ink-500)", textAlign: "center" }}>
                  No treaty rows yet. Import a CSV above to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Toolbar({
  loading,
  mapped,
  unmapped,
  dirty,
  onSave,
  onImport,
  onReload,
}: {
  loading: boolean;
  mapped: number;
  unmapped: number;
  dirty: boolean;
  onSave: () => void;
  onImport: (file: File) => void;
  onReload: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
        background: "var(--ink-50)",
        border: "1px solid var(--ink-200)",
        borderRadius: 6,
        padding: 10,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--ink-700)" }}>
        <strong style={{ color: "#066c2f" }}>{mapped}</strong> mapped ·{" "}
        <strong style={{ color: "#9b1c1c" }}>{unmapped}</strong> unmapped
      </div>
      <div style={{ flex: 1 }} />
      <label
        style={{
          fontSize: 12,
          padding: "5px 10px",
          background: "white",
          border: "1px solid var(--ink-300)",
          borderRadius: 4,
          cursor: "pointer",
          color: "var(--ink-800)",
        }}
      >
        Import CSV…
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = "";
          }}
        />
      </label>
      <button
        onClick={onReload}
        disabled={loading}
        style={btnSecondary}
      >
        Reload
      </button>
      <button
        onClick={onSave}
        disabled={!dirty || loading}
        style={dirty ? btnPrimary : { ...btnPrimary, opacity: 0.5, cursor: "not-allowed" }}
      >
        {loading ? "…" : `Save ${dirty ? "edits" : "(no changes)"}`}
      </button>
    </div>
  );
}

function Row({
  row,
  edit,
  isDirty,
  onChange,
  onApplySuggestion,
}: {
  row: TreatyView;
  edit: EDMLinkInput;
  isDirty: boolean;
  onChange: (partial: Partial<EDMLinkInput>) => void;
  onApplySuggestion: () => void;
}) {
  const t = row.treaty;
  const statusColor = STATUS_BADGE[row.status];
  const hasSuggestion =
    (row.suggestedServer && row.suggestedServer !== edit.serverName) ||
    (row.suggestedEdm && row.suggestedEdm !== edit.edmDatabaseName);
  return (
    <tr
      style={{
        borderTop: "1px solid var(--ink-200)",
        background: isDirty ? "#fff7e3" : undefined,
      }}
    >
      <Td>
        <code style={{ fontSize: 11 }}>{t.fsDisplayId}</code>
        <div style={{ fontSize: 10, color: "var(--ink-500)" }}>{t.riskId}</div>
      </Td>
      <Td>
        <span
          style={{
            display: "inline-block",
            padding: "2px 7px",
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            color: statusColor.fg,
            background: statusColor.bg,
            border: `1px solid ${statusColor.border}`,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {row.status}
        </span>
        <div style={{ fontSize: 10, color: "var(--ink-500)", marginTop: 2 }}>{t.layerStatus}</div>
      </Td>
      <Td>{t.reinsuredName}</Td>
      <Td>
        {t.brokerName}
        {t.brokerOffice && (
          <div style={{ fontSize: 10, color: "var(--ink-500)" }}>{t.brokerOffice}</div>
        )}
      </Td>
      <Td>L{t.layerNumber}</Td>
      <Td>{t.inceptionDate}</Td>
      <Td>
        <div>{t.cob1}</div>
        <div style={{ fontSize: 10, color: "var(--ink-500)" }}>
          {t.cob2} · {t.cob3}
        </div>
      </Td>
      <Td align="right">{formatMoney(t.eventLimitUsd, t.currency)}</Td>
      <Td align="right">{formatMoney(t.deductibleUsd, t.currency)}</Td>
      <Td align="right">{t.weightedSharePct.toFixed(2)}%</Td>
      <Td align="right">{t.signedLinePct.toFixed(2)}%</Td>
      <Td align="right">{t.rolPct.toFixed(2)}%</Td>
      <Td>
        <input
          value={edit.serverName ?? ""}
          onChange={(e) => onChange({ serverName: e.target.value || null })}
          placeholder={row.suggestedServer ?? "(unmapped)"}
          style={inputStyle}
        />
      </Td>
      <Td>
        <input
          value={edit.edmDatabaseName ?? ""}
          onChange={(e) => onChange({ edmDatabaseName: e.target.value || null })}
          placeholder={row.suggestedEdm ?? "(unmapped)"}
          style={inputStyle}
        />
        {hasSuggestion && (
          <button
            onClick={onApplySuggestion}
            style={btnSuggest}
            title="Apply auto-suggest based on a name match in cedents.json"
          >
            ↪ apply suggestion
          </button>
        )}
      </Td>
    </tr>
  );
}

function mergedLinks(
  rows: TreatyView[],
  edits: Record<string, EDMLinkInput>,
): Record<string, EDMLinkInput> {
  // Start from whatever's currently in the backend, override with local edits.
  const out: Record<string, EDMLinkInput> = {};
  for (const r of rows) {
    if (r.serverName || r.edmDatabaseName) {
      out[r.treaty.fsDisplayId] = {
        serverName: r.serverName,
        edmDatabaseName: r.edmDatabaseName,
      };
    }
  }
  for (const [k, v] of Object.entries(edits)) {
    out[k] = v;
  }
  return out;
}

// ─────────────────────────── styles ───────────────────────────

const cellPad = { padding: "6px 10px" } as const;

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{
        ...cellPad,
        textAlign: align,
        fontWeight: 700,
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        borderBottom: "1px solid var(--ink-300)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      style={{
        ...cellPad,
        textAlign: align,
        verticalAlign: "top",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 180,
  padding: "3px 6px",
  fontSize: 11,
  fontFamily: "ui-monospace, monospace",
  border: "1px solid var(--ink-300)",
  borderRadius: 3,
  background: "white",
};

const btnPrimary: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  background: "var(--brand-500)",
  color: "white",
  padding: "6px 14px",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 700,
};

const btnSecondary: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  border: "1px solid var(--ink-300)",
  background: "white",
  color: "var(--ink-800)",
  padding: "5px 10px",
  borderRadius: 4,
  fontSize: 12,
};

const btnSuggest: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  marginTop: 3,
  fontSize: 10,
  color: "var(--brand-700)",
  textDecoration: "underline",
};
