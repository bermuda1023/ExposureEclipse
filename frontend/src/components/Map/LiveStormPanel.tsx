/**
 * Floating panel: pick a live (or replay) storm and toggle the overlay
 * layers (alerts / buoys / land stations / SST / forecast history).
 *
 * Mounts top-right of the map container — clear of the existing
 * HurricaneImpactPanel which lives bottom-left.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchLiveStormBundle,
  fetchLiveStormList,
  fetchWindModelGrid,
  type LiveStormRow,
} from "../../api/live";
import { fetchHurricaneImpact } from "../../api/hurricanes";
import { useFiltersStore } from "../../state/filters";
import { useHurricaneImpactStore } from "../../state/hurricaneImpact";
import {
  useLiveStormStore, type ToggleKey, type WindMapMode,
} from "../../state/liveStorm";
import { useEffectiveScope } from "../../state/useEffectiveScope";
import { useViewStore } from "../../state/view";

export function LiveStormPanel() {
  const open = useLiveStormStore((s) => s.pickerOpen);
  const setPickerOpen = useLiveStormStore((s) => s.setPickerOpen);
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

  // Lazy-fetch model grids whenever the mode requires them and we don't
  // already have them cached. Each model grid is one Open-Meteo call, so
  // triggering only on demand keeps the initial bundle fast.
  useEffect(() => {
    const mode = store.windMapMode;
    const needGfs =
      mode === "gfs"
      || mode === "diff-obs-vs-gfs"
      || mode === "diff-gfs-vs-ecmwf";
    const needEcmwf =
      mode === "ecmwf"
      || mode === "diff-obs-vs-ecmwf"
      || mode === "diff-gfs-vs-ecmwf";
    if (!store.data) return;
    const bbox = store.data.bbox;
    // One automatic retry after a short delay covers Open-Meteo transient
    // failures (rate-limit bursts, cold DNS resolution). If the retry also
    // comes back empty then the model genuinely has no coverage for this
    // bbox — the user gets the "returned no data" note without more retries
    // fighting a persistent issue.
    async function fetchWithRetry(
      model: "gfs" | "ecmwf",
    ) {
      const state = useLiveStormStore.getState();
      const setStatus = model === "gfs"
        ? state.setGfsGridStatus
        : state.setEcmwfGridStatus;
      const setGrid = model === "gfs" ? state.setGfsGrid : state.setEcmwfGrid;
      setStatus("loading");
      const attempt = async () => fetchWindModelGrid(bbox, model);
      try {
        let g = await attempt();
        if (g.cells.length === 0) {
          // 1.5 s delay is long enough to clear Open-Meteo's burst rate
          // limit but short enough that the user doesn't notice a slow
          // panel.
          await new Promise((r) => setTimeout(r, 1500));
          g = await attempt();
        }
        setGrid(g);
        setStatus(g.cells.length > 0 ? "ok" : "empty");
      } catch {
        setStatus("error");
      }
    }

    if (needGfs && !store.gfsGrid && store.gfsGridStatus !== "loading") {
      void fetchWithRetry("gfs");
    }
    if (needEcmwf && !store.ecmwfGrid && store.ecmwfGridStatus !== "loading") {
      void fetchWithRetry("ecmwf");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.windMapMode, store.data, store.gfsGrid, store.ecmwfGrid]);

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
      includeSurge: store.showSurge,
      includeWindMap: store.showWindMap,
    })
      .then(store.setData)
      .catch((e) => store.setError(String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeId,
    store.showBuoys, store.showAlerts, store.showSst, store.showLand,
    store.showSurge, store.showWindMap,
  ]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 14,
        left: 14,
        width: 360,
        zIndex: 7,
        background: "rgba(255,255,255,0.97)",
        border: "1px solid var(--ink-300)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-lg)",
        fontSize: "0.75rem",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          padding: "8px 12px",
          background: "var(--ink-50)",
          borderBottom: "1px solid var(--ink-200)",
          fontWeight: 700,
          color: "var(--ink-900)",
          fontSize: "0.72rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        <span>● Live storm</span>
        <button
          onClick={() => setPickerOpen(false)}
          style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontWeight: 700 }}
          title="Close"
        >
          ✕
        </button>
      </div>
      {open && (
        <div style={{ padding: 10, display: "grid", gap: 10, maxHeight: "70vh", overflow: "auto" }}>
          {list.isLoading && <div>Loading storms…</div>}
          {list.error && (
            <div style={{ color: "var(--error-700)" }}>
              Live feed unreachable.
            </div>
          )}
          {list.data && (
            <>
              {list.data.active.length > 0 ? (
                <StormPicker
                  label="Active in Atlantic"
                  rows={list.data.active}
                  activeId={activeId}
                  onPick={(id) => useLiveStormStore.getState().start(id)}
                />
              ) : (
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
                  No active Atlantic storms right now.
                </div>
              )}
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
              <LayerChip store={store} k="showForecastCone" label="NHC cone" hint="Cone of uncertainty" color="#475569" />
              <LayerChip store={store} k="showSurge" label="Peak surge" hint="NHC coastal inundation" color="#dc2626" />
              <LayerChip store={store} k="showWindField" label="Wind field" hint="Rmax + R64 modelled" color="#b91c1c" />
              <LayerChip store={store} k="showForecastHistory" label="Forecast evolution" hint="Prior NHC advisories" color="#475569" />
              <LayerChip store={store} k="showWindMap" label="Wind speed map" hint="Interpolated obs (IDW)" color="#dc2626" />
              <LayerChip store={store} k="showWindParticles" label="Wind particles" hint="Animated windy.com-style flow" color="#0891b2" />
              <WindMapModeSelector store={store} />
              <WindMapTimeSlider store={store} />
              <LayerChip store={store} k="showAlerts" label="NWS alerts" hint="Watches + warnings" color="#ea580c" />
              <LayerChip store={store} k="showBuoys" label="NDBC buoys" hint="Marine obs" color="#0ea5e9" />
              <LayerChip store={store} k="showLand" label="NWS land stations" hint="Discrete markers" color="#10b981" />
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

function WindMapModeSelector({
  store,
}: {
  store: ReturnType<typeof useLiveStormStore.getState>;
}) {
  if (!store.showWindMap) return null;
  const modes: Array<[WindMapMode, string, string]> = [
    ["observed", "Obs", "Interpolated observations"],
    ["gfs", "GFS", "NOAA GFS surface wind"],
    ["ecmwf", "ECMWF", "ECMWF IFS surface wind"],
    ["diff-obs-vs-gfs", "Obs−GFS", "Observed minus GFS (kt)"],
    ["diff-obs-vs-ecmwf", "Obs−ECMWF", "Observed minus ECMWF (kt)"],
    ["diff-gfs-vs-ecmwf", "GFS−ECMWF", "GFS minus ECMWF (kt)"],
  ];

  // Which model(s) does each mode require?
  const needsGfs = (m: WindMapMode) =>
    m === "gfs" || m === "diff-obs-vs-gfs" || m === "diff-gfs-vs-ecmwf";
  const needsEcmwf = (m: WindMapMode) =>
    m === "ecmwf" || m === "diff-obs-vs-ecmwf" || m === "diff-gfs-vs-ecmwf";

  const obsEmpty = !!store.data && store.data.windMap.length === 0;

  // One-line status describing why the active mode has nothing to show.
  const statusForMode = (mode: WindMapMode): string | null => {
    if (mode === "observed") {
      if (obsEmpty) return "No surface obs in this bbox (open-ocean storm).";
      return null;
    }
    if (needsGfs(mode)) {
      if (store.gfsGridStatus === "loading") return "GFS loading…";
      if (store.gfsGridStatus === "empty") return "GFS returned no data.";
      if (store.gfsGridStatus === "error") return "GFS request failed.";
    }
    if (needsEcmwf(mode)) {
      if (store.ecmwfGridStatus === "loading") return "ECMWF loading…";
      if (store.ecmwfGridStatus === "empty")
        return "ECMWF unavailable in this region (Pacific / open ocean).";
      if (store.ecmwfGridStatus === "error") return "ECMWF request failed.";
    }
    return null;
  };

  // Small badge in the corner of each mode button showing its data state.
  const modeBadge = (mode: WindMapMode): string => {
    if (mode === "observed") return obsEmpty ? "∅" : "";
    const g = store.gfsGridStatus;
    const e = store.ecmwfGridStatus;
    const badge = (s: typeof g) =>
      s === "loading" ? "…" : s === "empty" ? "∅" : s === "error" ? "!" : "";
    if (needsGfs(mode) && needsEcmwf(mode)) return badge(g) || badge(e);
    if (needsGfs(mode)) return badge(g);
    if (needsEcmwf(mode)) return badge(e);
    return "";
  };

  const activeStatus = statusForMode(store.windMapMode);

  return (
    <div
      style={{
        gridColumn: "span 2",
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 3,
        marginTop: 3,
        paddingTop: 5,
        borderTop: "1px dashed var(--ink-200)",
      }}
    >
      <div
        style={{
          gridColumn: "span 3",
          fontSize: "0.6rem",
          color: "var(--ink-500)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 2,
        }}
      >
        Wind map source
      </div>
      {modes.map(([mode, label, hint]) => {
        const active = store.windMapMode === mode;
        const badge = modeBadge(mode);
        return (
          <button
            key={mode}
            type="button"
            title={hint}
            onClick={() => useLiveStormStore.getState().setWindMapMode(mode)}
            style={{
              all: "unset",
              cursor: "pointer",
              padding: "3px 5px",
              borderRadius: 3,
              fontSize: "0.66rem",
              textAlign: "center",
              border: `1px solid ${active ? "#dc2626" : "var(--ink-200)"}`,
              background: active ? "#fef2f2" : "transparent",
              color: active ? "#7f1d1d" : "var(--ink-600)",
              fontWeight: active ? 700 : 400,
              position: "relative",
            }}
          >
            {label}
            {badge && (
              <span
                style={{
                  position: "absolute",
                  top: -3,
                  right: -3,
                  fontSize: "0.6rem",
                  color:
                    badge === "…"
                      ? "#2563eb"
                      : badge === "!"
                      ? "#dc2626"
                      : "#a16207",
                }}
              >
                {badge}
              </span>
            )}
          </button>
        );
      })}
      {activeStatus && (
        <div
          style={{
            gridColumn: "span 3",
            marginTop: 4,
            padding: "4px 6px",
            fontSize: "0.62rem",
            background: "#fef3c7",
            border: "1px solid #fbbf24",
            borderRadius: 3,
            color: "#78350f",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>{activeStatus}</span>
          {(store.gfsGridStatus === "empty" || store.gfsGridStatus === "error"
            || store.ecmwfGridStatus === "empty" || store.ecmwfGridStatus === "error") && (
            <button
              type="button"
              onClick={() => {
                // Reset both grids so the panel's fetch effect re-runs and
                // Open-Meteo gets a fresh chance. Cheap to redo — cached
                // per-bbox on the backend when it succeeded.
                const s = useLiveStormStore.getState();
                if (s.gfsGridStatus !== "loading") {
                  s.setGfsGrid(null);
                  s.setGfsGridStatus("idle");
                }
                if (s.ecmwfGridStatus !== "loading") {
                  s.setEcmwfGrid(null);
                  s.setEcmwfGridStatus("idle");
                }
              }}
              title="Retry model fetch"
              style={{
                all: "unset",
                cursor: "pointer",
                fontSize: "0.7rem",
                padding: "1px 6px",
                border: "1px solid #b45309",
                borderRadius: 2,
                color: "#78350f",
                fontWeight: 600,
              }}
            >
              ↻ retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WindMapTimeSlider({
  store,
}: {
  store: ReturnType<typeof useLiveStormStore.getState>;
}) {
  if (!store.showWindMap) return null;
  const mode = store.windMapMode;
  // Observed grid is always current-time — no frames to scrub through.
  if (mode === "observed") return null;

  const needsGfs =
    mode === "gfs" || mode === "diff-obs-vs-gfs" || mode === "diff-gfs-vs-ecmwf";
  const needsEcmwf =
    mode === "ecmwf" || mode === "diff-obs-vs-ecmwf" || mode === "diff-gfs-vs-ecmwf";

  // Pick whichever grid's frames drive the timeline. For diff modes both
  // grids exist and are aligned; taking either's frame list is fine.
  const drivingGrid = needsGfs
    ? store.gfsGrid
    : needsEcmwf
    ? store.ecmwfGrid
    : null;

  if (!drivingGrid || drivingGrid.frames.length === 0) return null;

  const idx = Math.min(
    Math.max(0, store.windMapFrameIndex),
    drivingGrid.frames.length - 1,
  );
  const frame = drivingGrid.frames[idx];
  const hourLabel =
    frame.hour === 0 ? "Now" : `T+${frame.hour}h`;
  const validLabel = (() => {
    // ISO like "2026-07-22T18:00Z"
    const m = frame.validTimeUtc.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/,
    );
    if (!m) return frame.validTimeUtc;
    const day = new Date(
      Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]),
    );
    const opts: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    };
    return day.toLocaleString(undefined, opts) + " UTC";
  })();

  return (
    <div
      style={{
        gridColumn: "span 2",
        marginTop: 4,
        paddingTop: 6,
        borderTop: "1px dashed var(--ink-200)",
        display: "grid",
        gap: 3,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          fontSize: "0.62rem",
          fontWeight: 700,
          color: "var(--ink-500)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        <span>Forecast time</span>
        <span
          style={{
            color: "var(--ink-700)",
            fontWeight: 700,
            textTransform: "none",
            letterSpacing: "normal",
            fontSize: "0.7rem",
          }}
        >
          {hourLabel}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={drivingGrid.frames.length - 1}
        step={1}
        value={idx}
        onChange={(e) =>
          useLiveStormStore.getState().setWindMapFrameIndex(+e.target.value)
        }
        style={{
          width: "100%",
          accentColor: "#dc2626",
          cursor: "pointer",
        }}
      />
      <div
        style={{
          fontSize: "0.62rem",
          color: "var(--ink-500)",
          textAlign: "center",
        }}
      >
        {validLabel}
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
      {data.forecastCone && (
        <div>NHC cone: {data.forecastCone.ring.length} pts</div>
      )}
      {data.peakSurge.length > 0 && (
        <div>
          Peak surge: {data.peakSurge.length} coastal polygons
        </div>
      )}
      {data.windMap.length > 0 && (
        <div>
          Wind map: {data.windMap.length} cells (
          {Math.max(...data.windMap.map((c) => c.windKt)).toFixed(0)} kt peak,
          {" "}
          {data.windMapMeta.stepDeg}° res)
        </div>
      )}
      {data.sst.length > 0 && (
        <div>
          SST {data.sstMinC}–{data.sstMaxC}°C ·{" "}
          {data.sst.filter((p) => p.favorableForIntensification).length} cells ≥26.5°C
        </div>
      )}
    </div>
  );
}
