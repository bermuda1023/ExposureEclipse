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
import { fetchHurricaneImpact } from "../../api/hurricanes";
import { useFiltersStore } from "../../state/filters";
import { useHurricaneImpactStore } from "../../state/hurricaneImpact";
import { useLiveStormStore, type ToggleKey } from "../../state/liveStorm";
import { useEffectiveScope } from "../../state/useEffectiveScope";
import { useViewStore } from "../../state/view";

export function LiveStormPanel() {
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ["live-storms-list"],
    queryFn: fetchLiveStormList,
    staleTime: 5 * 60_000,
  });

  const store = useLiveStormStore();
  const activeId = store.activeStormId;
  const impactStore = useHurricaneImpactStore();
  const scope = useEffectiveScope();
  const perils = useViewStore((s) => s.perils);
  const filters = useFiltersStore();

  // Trigger the existing historical-impact flow on the live storm — same
  // engine (R64 asymmetric capture, per-programme TIV breakdown). Pushes
  // straight to the right-rail detail view so the user sees the full
  // county/programme rollup for "if this storm's track plays out".
  function runImpact() {
    if (!activeId) return;
    const payload = {
      cedentId: scope.cedentId,
      chainId: scope.chainId,
      chainIds: scope.chainIds,
      programmeId: scope.programmeId,
      aggregationLevel: "COUNTY",
      metric: "TIV",
      perils,
      filters: {
        peril: filters.peril,
        occupancy: filters.occupancy,
        distanceToCoast: filters.distanceToCoast,
        geocoding: filters.geocoding,
        construction: filters.construction,
        numberOfStories: filters.numberOfStories,
        yearBuilt: filters.yearBuilt,
      },
    };
    impactStore.start(activeId, payload);
    fetchHurricaneImpact(activeId, payload)
      .then((d) => {
        impactStore.setData(d);
        impactStore.pushToDetail();
      })
      .catch((e) => impactStore.setError(String(e?.message ?? e)));
  }

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
        width: open ? 360 : 130,
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
                marginBottom: 6,
              }}
            >
              Layers
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              <LayerChip store={store} k="showWindField" label="Wind field" hint="Rmax + R64" color="#b91c1c" />
              <LayerChip store={store} k="showForecastHistory" label="Forecast evolution" hint="Ghost tracks" color="#475569" />
              <LayerChip store={store} k="showAlerts" label="NWS alerts" hint="Watches + warnings" color="#ea580c" />
              <LayerChip store={store} k="showBuoys" label="NDBC buoys" hint="Marine obs" color="#0ea5e9" />
              <LayerChip store={store} k="showLand" label="NWS land stations" hint="Slow source" color="#10b981" />
              <LayerChip store={store} k="showSst" label="Sea-surface temp" hint="MUR 0.01°" color="#facc15" />
            </div>
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
            <>
              <BundleSummary data={store.data} />
              <button
                onClick={runImpact}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  textAlign: "center",
                  padding: "6px 8px",
                  border: "1px solid var(--brand-500)",
                  borderRadius: 4,
                  background: "var(--brand-500)",
                  color: "white",
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
                title="Run the county-impact + per-programme TIV breakdown for this storm's track"
              >
                Run county impact
              </button>
            </>
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

function LayerChip({
  store,
  k,
  label,
  hint,
  color,
}: {
  store: ReturnType<typeof useLiveStormStore.getState>;
  k: ToggleKey;
  label: string;
  hint?: string;
  color: string;
}) {
  const active = store[k] as boolean;
  return (
    <button
      type="button"
      onClick={() => store.setToggle(k, !active)}
      title={hint ? `${label} — ${hint}` : label}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 7px",
        borderRadius: 4,
        border: `1px solid ${active ? color : "var(--ink-200)"}`,
        background: active ? "#fff" : "transparent",
        fontSize: "0.7rem",
        color: active ? "var(--ink-900)" : "var(--ink-500)",
        opacity: active ? 1 : 0.7,
        minHeight: 24,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: 2,
          background: active ? color : "transparent",
          border: `1.5px solid ${color}`,
          flexShrink: 0,
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </button>
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
