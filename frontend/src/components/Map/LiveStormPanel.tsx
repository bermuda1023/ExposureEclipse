/**
 * Floating panel: pick a live (or replay) storm and toggle the overlay
 * layers (alerts / buoys / land stations / SST / forecast history).
 *
 * Mounts top-right of the map container — clear of the existing
 * HurricaneImpactPanel which lives bottom-left.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchLiveStormBundle,
  fetchLiveStormList,
  type LiveStormRow,
} from "../../api/live";
import { useLiveStormStore, type ToggleKey } from "../../state/liveStorm";

export function LiveStormPanel() {
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ["live-storms-list"],
    queryFn: fetchLiveStormList,
    staleTime: 5 * 60_000,
  });

  const store = useLiveStormStore();
  const activeId = store.activeStormId;

  // Fetch the full bundle whenever activeId changes, throttled to once per
  // 60s while a storm is live (cache).
  useEffect(() => {
    if (!activeId) return;
    store.start(activeId);
    fetchLiveStormBundle(activeId, {
      includeObs: store.showBuoys,
      includeAlerts: store.showAlerts,
      includeSst: store.showSst,
      includeLand: store.showLand,
    })
      .then(store.setData)
      .catch((e) => store.setError(String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, store.showBuoys, store.showAlerts, store.showSst, store.showLand]);

  return (
    <div
      style={{
        position: "absolute",
        top: 14,
        right: 14,
        width: open ? 320 : 130,
        zIndex: 7,
        background: "rgba(255,255,255,0.97)",
        border: "1px solid var(--ink-300)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        fontSize: "0.75rem",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          width: "100%",
          padding: "8px 12px",
          background: "var(--ink-50)",
          borderBottom: open ? "1px solid var(--ink-200)" : undefined,
          boxSizing: "border-box",
          fontWeight: 700,
          color: "var(--ink-900)",
          fontSize: "0.72rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
        title="Live + replay hurricane overlay"
      >
        <span>● Live storm</span>
        <span style={{ color: "var(--ink-500)" }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div style={{ padding: 10, display: "grid", gap: 10, maxHeight: "70vh", overflow: "auto" }}>
          {list.isLoading && <div>Loading storms…</div>}
          {list.error && (
            <div style={{ color: "var(--error-700)" }}>
              Live feed unreachable. Replay still works once the catalogue loads.
            </div>
          )}
          {list.data && (
            <>
              {list.data.note && (
                <div
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--ink-600)",
                    background: "#fef3c7",
                    border: "1px solid #fbbf24",
                    padding: 6,
                    borderRadius: 4,
                  }}
                >
                  {list.data.note}
                </div>
              )}
              {list.data.active.length > 0 && (
                <StormPicker
                  label="Active in Atlantic"
                  rows={list.data.active}
                  activeId={activeId}
                  onPick={(id) => useLiveStormStore.getState().start(id)}
                />
              )}
              <StormPicker
                label={`Replay (${list.data.replay.length})`}
                rows={list.data.replay}
                activeId={activeId}
                onPick={(id) => useLiveStormStore.getState().start(id)}
              />
            </>
          )}
          <div style={{ borderTop: "1px solid var(--ink-200)", paddingTop: 8 }}>
            <div
              style={{
                fontSize: "0.62rem",
                color: "var(--ink-500)",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 4,
              }}
            >
              Layers
            </div>
            <ToggleRow store={store} k="showWindField" label="Wind field (Rmax + R64)" />
            <ToggleRow store={store} k="showForecastHistory" label="Forecast evolution (ghost tracks)" />
            <ToggleRow store={store} k="showAlerts" label="NWS active alerts" />
            <ToggleRow store={store} k="showBuoys" label="NDBC buoys" />
            <ToggleRow store={store} k="showLand" label="NWS land stations (slow)" />
            <ToggleRow store={store} k="showSst" label="Sea-surface temperature" />
          </div>
          {store.activeStormId && (
            <button
              onClick={store.clear}
              style={{
                all: "unset",
                cursor: "pointer",
                alignSelf: "start",
                fontSize: "0.7rem",
                color: "var(--ink-500)",
                textDecoration: "underline",
              }}
            >
              Clear active storm
            </button>
          )}
          {store.isLoading && <div style={{ color: "var(--ink-500)" }}>Fetching live data…</div>}
          {store.error && (
            <div style={{ color: "var(--error-700)", fontSize: "0.7rem" }}>{store.error}</div>
          )}
          {store.data && (
            <BundleSummary data={store.data} />
          )}
        </div>
      )}
    </div>
  );
}

function StormPicker({
  label,
  rows,
  activeId,
  onPick,
}: {
  label: string;
  rows: LiveStormRow[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: "0.62rem",
          color: "var(--ink-500)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {rows.map((r) => {
          const isActive = activeId === r.stormId;
          return (
            <button
              key={r.stormId}
              onClick={() => onPick(r.stormId)}
              style={{
                all: "unset",
                cursor: "pointer",
                padding: "4px 8px",
                borderRadius: 4,
                fontSize: "0.72rem",
                color: isActive ? "var(--brand-700)" : "var(--ink-800)",
                background: isActive ? "var(--brand-50)" : "var(--ink-50)",
                border: `1px solid ${isActive ? "var(--brand-400)" : "var(--ink-200)"}`,
              }}
            >
              {r.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({
  store,
  k,
  label,
}: {
  store: ReturnType<typeof useLiveStormStore.getState>;
  k: ToggleKey;
  label: string;
}) {
  const value = store[k] as boolean;
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        fontSize: "0.7rem",
        padding: "2px 0",
        color: "var(--ink-800)",
      }}
    >
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => store.setToggle(k, e.target.checked)}
      />
      {label}
    </label>
  );
}

function BundleSummary({ data }: { data: import("../../api/live").LiveStormBundle }) {
  return (
    <div
      style={{
        background: "var(--brand-50)",
        border: "1px solid var(--brand-400)",
        borderRadius: 4,
        padding: 6,
        fontSize: "0.68rem",
        color: "var(--ink-800)",
        display: "grid",
        gap: 2,
      }}
    >
      <div>
        <strong>{data.storm.name}</strong> · {data.storm.year} ·{" "}
        {data.storm.intensityKt} kt
      </div>
      <div>{data.observedTrack.length} observed fixes · {data.forecasts.length} advisories</div>
      <div>{data.alerts.length} alerts in cone · {data.buoys.length} buoys</div>
      {data.landStations.length > 0 && <div>{data.landStations.length} land stations</div>}
      {data.sst.length > 0 && (
        <div>
          SST {data.sstMinC}–{data.sstMaxC}°C ·{" "}
          {data.sst.filter((p) => p.favorableForIntensification).length} cells ≥26.5°C
        </div>
      )}
    </div>
  );
}
