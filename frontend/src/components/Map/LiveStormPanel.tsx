/**
 * Floating panel: pick a live (or replay) storm and toggle the overlay
 * layers (alerts / buoys / land stations / SST / forecast history).
 *
 * Mounts top-right of the map container — clear of the existing
 * HurricaneImpactPanel which lives bottom-left.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import {
  fetchEnsembleRisk,
  fetchGTWO,
  fetchLiveStormBundle,
  fetchLiveStormList,
  fetchModelTracks,
  fetchWindModelGrid,
  postWatchWarnExposure,
  type LiveStormBundle,
  type LiveStormRow,
  type ModelFamily,
  type NHCWatchWarn,
  type WatchWarnExposureResponse,
} from "../../api/live";
import { FAMILY_COLOR } from "./ModelTrackLayer";
import { GTWO_BUCKET_COLOR } from "./TWOLayer";

/**
 * "Exit live storm mode" primitive — clears the live-storm slice AND the
 * hurricane-impact slice (populated by "Run county impact"). Both stores
 * back layers on the map, so a clean exit needs both. Called from three
 * spots: the X button, the toolbar chip (in LiveStormControls), and
 * clicking the currently-active picker row.
 */
function fullyClearLiveStorm(): void {
  useLiveStormStore.getState().clear();
  useHurricaneImpactStore.getState().clear();
}
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
  const collapsed = useLiveStormStore((s) => s.collapsed);
  const setCollapsed = useLiveStormStore((s) => s.setCollapsed);
  const pushedToDetail = useLiveStormStore((s) => s.pushedToDetail);
  const pushToDetail = useLiveStormStore((s) => s.pushToDetail);
  const popFromDetail = useLiveStormStore((s) => s.popFromDetail);
  const list = useQuery({
    queryKey: ["live-storms-list"],
    queryFn: fetchLiveStormList,
    staleTime: 5 * 60_000,
  });

  const store = useLiveStormStore();
  const chipStatus = useChipAvailability(store);
  const activeId = store.activeStormId;
  const impactStore = useHurricaneImpactStore();
  const scope = useEffectiveScope();
  const perils = useViewStore((s) => s.perils);
  const filters = useFiltersStore();
  const [detailSlot, setDetailSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!pushedToDetail) {
      setDetailSlot(null);
      return;
    }
    let n = 0;
    const id = window.setInterval(() => {
      const el = document.getElementById("live-storm-detail-slot");
      if (el) {
        setDetailSlot(el);
        window.clearInterval(id);
      } else if (++n > 40) {
        window.clearInterval(id);
      }
    }, 40);
    return () => window.clearInterval(id);
  }, [pushedToDetail]);

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

  // Fetch the FULL bundle whenever activeId changes, once per storm. Every
  // sub-layer is fetched regardless of whether its chip is enabled — the
  // availability signal (which chips should be greyed out) is derived from
  // the bundle response, so we need it all up-front. Previously each
  // include* flag was tied to a chip toggle, which meant switching a chip
  // triggered a full refetch and empty responses were indistinguishable
  // from "not fetched yet".
  useEffect(() => {
    if (!activeId) return;
    store.start(activeId);
    fetchLiveStormBundle(activeId, {
      includeObs: true,
      includeAlerts: true,
      includeSst: true,
      includeLand: true,
      includeSurge: true,
      includeWindMap: true,
    })
      .then(store.setData)
      .catch((e) => store.setError(String(e?.message ?? e)));
    // Also eager-fetch model tracks on storm select so the ensemble chips
    // (Model tracks / envelopes / Strike prob) can be greyed out immediately
    // if the a-deck comes back empty. The tracks payload is small and cached.
    const s = useLiveStormStore.getState();
    s.setModelTracksStatus("loading");
    fetchModelTracks(activeId)
      .then((r) => {
        s.setModelTracks(r);
        s.setModelTracksStatus(r.tracks.length > 0 ? "ok" : "empty");
      })
      .catch(() => s.setModelTracksStatus("error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // (Model tracks are now eagerly fetched in the bundle effect above so
  // their availability drives chip greying-out on storm select. No lazy
  // effect needed here.)

  // Same pattern for the ensemble strike-probability grid. Threshold change
  // invalidates the cache (via setStrikeThresholdNm in the store), so this
  // effect re-fires when either the toggle or the threshold changes.
  useEffect(() => {
    if (!activeId) return;
    if (!store.showStrikeProbability) return;
    if (store.ensembleRisk || store.ensembleRiskStatus === "loading") return;
    const s = useLiveStormStore.getState();
    s.setEnsembleRiskStatus("loading");
    fetchEnsembleRisk(activeId, { thresholdNm: store.strikeThresholdNm })
      .then((r) => {
        s.setEnsembleRisk(r);
        s.setEnsembleRiskStatus(r.strikeByCounty.length > 0 ? "ok" : "empty");
      })
      .catch(() => s.setEnsembleRiskStatus("error"));
  }, [
    activeId, store.showStrikeProbability, store.strikeThresholdNm,
    store.ensembleRisk, store.ensembleRiskStatus,
  ]);

  // GTWO (Tropical Weather Outlook) — basin-wide, doesn't need a storm.
  // Fetch on toggle-on, refresh every 30 min while enabled (NHC issues the
  // outlook every 6h, so 30 min is generous and cheap).
  useEffect(() => {
    if (!store.showGTWO) return;
    if (store.gtwoStatus === "loading") return;
    const stale = !store.gtwoData;
    if (!stale) return;
    const s = useLiveStormStore.getState();
    s.setGTWOStatus("loading");
    fetchGTWO("atl")
      .then((r) => {
        s.setGTWOData(r);
        s.setGTWOStatus(r.areas.length > 0 ? "ok" : "empty");
      })
      .catch(() => s.setGTWOStatus("error"));
  }, [store.showGTWO, store.gtwoData, store.gtwoStatus]);

  // Picker click handler. Same-storm click acts as a toggle-off (clear +
  // remove overlays) rather than re-invoking start() — start() nulls the
  // data/modelTracks slices as part of its state reset, but the fetch
  // effect only fires when activeId changes, so an inadvertent re-click
  // used to make the layers disappear without a refetch. Turning it into
  // an explicit deselect matches the user's expectation ("I clicked the
  // active button, I want it off") and keeps the state machine tidy.
  const pickStorm = (id: string) => {
    if (id === activeId) {
      fullyClearLiveStorm();
    } else {
      useLiveStormStore.getState().start(id);
      // Reset any previous impact result too — running county impact for
      // a different storm should start from a clean slate rather than
      // briefly showing the previous storm's cone.
      useHurricaneImpactStore.getState().clear();
    }
  };

  const inDetail = pushedToDetail && !!detailSlot;
  if (pushedToDetail && !detailSlot) return null;
  if (!inDetail && !open) return null;

  const stormLabel = store.data?.storm.name ?? (activeId ? activeId : "Live storm");

  const headerBtn: CSSProperties = {
    all: "unset",
    cursor: "pointer",
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid var(--ink-300)",
    fontSize: "0.68rem",
    color: "var(--ink-700)",
    fontWeight: 600,
  };

  if (!inDetail && collapsed) {
    return (
      <div
        style={{
          position: "absolute",
          top: 14,
          left: 14,
          zIndex: 7,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: "rgba(255,255,255,0.96)",
          border: "1px solid var(--ink-300)",
          borderRadius: "var(--radius-sm)",
          boxShadow: "var(--shadow-md)",
          fontSize: "0.72rem",
          fontWeight: 600,
          color: "var(--ink-800)",
        }}
      >
        <span style={{ color: "#0891b2" }}>●</span>
        {stormLabel}
        <button type="button" style={headerBtn} onClick={() => setCollapsed(false)} title="Expand panel">
          Expand
        </button>
        <button
          type="button"
          style={headerBtn}
          onClick={pushToDetail}
          title="Move this panel to the Detail rail — map stays clear"
        >
          → detail
        </button>
        <button
          type="button"
          onClick={() => { fullyClearLiveStorm(); setPickerOpen(false); }}
          style={{ ...headerBtn, border: "none" }}
          title="Clear storm overlays"
        >
          ✕
        </button>
      </div>
    );
  }

  const panel = (
    <div
      style={
        inDetail
          ? {
              fontSize: "0.75rem",
              background: "var(--ink-0)",
              border: "1px solid var(--ink-200)",
              borderRadius: "var(--radius-sm)",
              overflow: "hidden",
            }
          : {
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
            }
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          padding: "8px 10px",
          background: "var(--ink-50)",
          borderBottom: "1px solid var(--ink-200)",
          fontWeight: 700,
          color: "var(--ink-900)",
          fontSize: "0.72rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        <span>{inDetail ? "Live storm · detail" : "Live storm"}</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {inDetail ? (
            <button type="button" style={headerBtn} onClick={popFromDetail} title="Put the panel back on the map">
              ↩ map
            </button>
          ) : (
            <>
              <button type="button" style={headerBtn} onClick={() => setCollapsed(true)} title="Minimize — keep overlays on the map">
                Collapse
              </button>
              <button
                type="button"
                style={headerBtn}
                onClick={pushToDetail}
                title="Move this panel to the Detail rail — map stays clear"
              >
                → detail
              </button>
            </>
          )}
          <button
            onClick={() => {
              fullyClearLiveStorm();
              setPickerOpen(false);
            }}
            style={{ all: "unset", cursor: "pointer", color: "var(--ink-500)", fontWeight: 700, padding: "0 4px" }}
            title="Close and clear active storm"
          >
            ✕
          </button>
        </div>
      </div>
      {(open || inDetail) && (
        <div style={{ padding: 10, display: "grid", gap: 10, maxHeight: inDetail ? "none" : "70vh", overflow: "auto" }}>
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
                  onPick={pickStorm}
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
              {list.data.invests.length > 0 && (
                <StormPicker
                  label={`Invests (pre-advisory · ${list.data.invests.length})`}
                  rows={list.data.invests}
                  activeId={activeId}
                  variant="invest"
                  onPick={pickStorm}
                />
              )}
              {list.data.replay.length > 0 && (
                <StormPicker
                  label="Replay"
                  rows={list.data.replay}
                  activeId={activeId}
                  variant="replay"
                  onPick={pickStorm}
                />
              )}
            </>
          )}
          <div style={{ borderTop: "1px solid var(--ink-200)", paddingTop: 8, display: "grid", gap: 10 }}>
            {/* Basin overlays — work without a storm selection. Own subsection
                so the underwriter can leave TWO on as a pre-invest signal
                without wading past storm-specific chips. */}
            <ChipGroup label="Basin (no storm needed)">
              <SmartChip store={store} status={chipStatus.showGTWO} k="showGTWO" label="Formation outlook (TWO)" hint="NHC 7-day outlook · yellow/orange/red = low/med/high chance" color="#f97316" />
              <GTWOStatusLine store={store} />
            </ChipGroup>

            <ChipGroup label="Track & cone">
              <SmartChip store={store} status={chipStatus.showForecastCone} k="showForecastCone" label="NHC cone" hint="Cone of uncertainty" color="#475569" />
              <SmartChip store={store} status={chipStatus.showForecastHistory} k="showForecastHistory" label="Forecast evolution" hint="Prior NHC advisories" color="#475569" />
              <SmartChip store={store} status={chipStatus.showWindField} k="showWindField" label="Wind field" hint="Rmax + R64 modelled" color="#b91c1c" />
            </ChipGroup>

            <ChipGroup label="Model ensemble">
              <SmartChip store={store} status={chipStatus.showModelTracks} k="showModelTracks" label="Model tracks" hint="GEFS + ECMWF-ENS + AI spaghetti" color="#a855f7" />
              <SmartChip store={store} status={chipStatus.showEnsembleEnvelope} k="showEnsembleEnvelope" label="Consensus envelope" hint="Convex hull of every ensemble member" color="#7f1d1d" />
              <SmartChip store={store} status={chipStatus.showAiEnvelope} k="showAiEnvelope" label="AI-only envelope" hint="GraphCast + GenCast + AIFS + FourCastNet + Pangu" color="#a855f7" />
              <SmartChip store={store} status={chipStatus.showStrikeProbability} k="showStrikeProbability" label="Strike probability" hint="Ensemble P(track within threshold nm) by county" color="#dc2626" />
            </ChipGroup>

            <ChipGroup label="Threat products">
              <SmartChip store={store} status={chipStatus.showWatchesWarnings} k="showWatchesWarnings" label="NHC watches/warnings" hint="Hurricane / TS / Storm Surge · NHC palette" color="#ec4899" />
              <SmartChip store={store} status={chipStatus.showSurge} k="showSurge" label="Peak surge" hint="NHC coastal inundation" color="#dc2626" />
              <SmartChip store={store} status={chipStatus.showAlerts} k="showAlerts" label="Other NWS alerts" hint="Flood, tornado, wind..." color="#ea580c" />
            </ChipGroup>

            <ChipGroup label="Wind & observations">
              <SmartChip store={store} status={chipStatus.showWindMap} k="showWindMap" label="Wind speed map" hint="Interpolated obs (IDW)" color="#dc2626" />
              <SmartChip store={store} status={chipStatus.showWindParticles} k="showWindParticles" label="Wind particles" hint="Animated windy.com-style flow" color="#0891b2" />
              <SmartChip store={store} status={chipStatus.showBuoys} k="showBuoys" label="NDBC buoys" hint="Marine obs" color="#0ea5e9" />
              <SmartChip store={store} status={chipStatus.showLand} k="showLand" label="NWS land stations" hint="Discrete markers" color="#10b981" />
              <SmartChip store={store} status={chipStatus.showSst} k="showSst" label="Sea-surface temp" hint="MUR 0.01°" color="#facc15" />
              <WindMapModeSelector store={store} />
              <WindMapTimeSlider store={store} />
            </ChipGroup>
          </div>
          {store.activeStormId && (
            <button
              onClick={fullyClearLiveStorm}
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
              <WatchWarnExposureSection data={store.data} />
              {store.showModelTracks && <ModelTracksSection />}
              {store.showStrikeProbability && <EnsembleRiskSection />}
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

  if (inDetail && detailSlot) return createPortal(panel, detailSlot);
  return panel;
}

/**
 * Small labelled subsection of chips. Keeps the chip grid legible now that
 * we have ~15 layer chips spread across five logical groups. Full-width
 * label bar above a 2-col chip grid, matching the visual style of the
 * previous single "Layers" section but broken up for scanability.
 */
/**
 * Chip availability for the currently loaded storm bundle + model tracks.
 *
 * "Available" = the underlying feed returned at least one meaningful
 * feature for this storm; "unavailable" = we know for certain the chip
 * will paint nothing (either the data came back empty or the product is
 * semantically inapplicable to the storm type — e.g. NHC cone doesn't
 * exist for invests).
 *
 * Availability is only defined AFTER the bundle response arrives. Before
 * that (or when no storm is selected) every chip is treated as available
 * so the panel doesn't flash-grey-out during load.
 */
type ChipStatus = { available: boolean; reason?: string };
type ChipMap = Partial<Record<ToggleKey, ChipStatus>>;

function useChipAvailability(
  store: ReturnType<typeof useLiveStormStore.getState>,
): ChipMap {
  const data = store.data;
  const modelTracks = store.modelTracks;
  const isInvest = data?.storm.classification === "INVEST";
  const bundleLoaded = !!data;
  const tracksLoaded =
    store.modelTracksStatus === "ok" || store.modelTracksStatus === "empty";

  const out: ChipMap = {};

  // Basin overlays — GTWO works without a storm and is basin-scoped,
  // never inappropriate to enable.
  out.showGTWO = { available: true };

  // Track & cone
  if (isInvest) {
    out.showForecastCone = {
      available: false,
      reason: "Invests are pre-advisory — no NHC cone product yet.",
    };
    out.showForecastHistory = {
      available: false,
      reason: "No prior NHC advisories for pre-advisory invests.",
    };
    out.showWindField = {
      available: false,
      reason: "Wind-field cones need an observed track ≥ 25 kt — invests are typically below that threshold.",
    };
  } else if (bundleLoaded) {
    out.showForecastCone = data!.forecastCone
      ? { available: true }
      : {
          available: false,
          reason: "NHC cone product not available for this storm right now (typically only issued for active tropical cyclones).",
        };
    out.showForecastHistory = data!.forecasts.length > 1
      ? { available: true }
      : {
          available: false,
          reason: "No prior advisories to compare — this is either the first advisory or a replay.",
        };
    const hasWindField =
      data!.observedWindField.outerRings.length > 0
      || data!.forecastWindField.outerRings.length > 0;
    out.showWindField = hasWindField
      ? { available: true }
      : {
          available: false,
          reason: "No observed track ≥ 25 kt yet — wind-field cones start once the storm reaches tropical depression strength.",
        };
  }

  // Model ensemble (all four chips key off the same a-deck fetch)
  if (tracksLoaded && modelTracks) {
    const hasTracks = modelTracks.tracks.length > 0;
    const hasEnvelope = modelTracks.ensembleEnvelope !== null;
    const hasAiEnvelope = modelTracks.aiEnvelope !== null;
    out.showModelTracks = hasTracks
      ? { available: true }
      : {
          available: false,
          reason: "No a-deck rows for this system yet. Try again after the next NHC init cycle.",
        };
    out.showEnsembleEnvelope = hasEnvelope
      ? { available: true }
      : {
          available: false,
          reason: "Not enough ensemble members (GEFS + ECMWF-ENS + AI) returned tracks to build a consensus envelope.",
        };
    out.showAiEnvelope = hasAiEnvelope
      ? { available: true }
      : {
          available: false,
          reason: "No AI models (GraphCast, GenCast, AIFS, FourCastNet, Pangu) present in this cycle's a-deck.",
        };
    // Strike probability requires ensemble members. We don't know for
    // certain whether any coastal counties will be within threshold until
    // /ensemble-risk runs, but if there's no ensemble at all, that's a
    // definite no.
    out.showStrikeProbability = hasEnvelope
      ? { available: true }
      : {
          available: false,
          reason: "No ensemble members to derive strike probability from.",
        };
  } else if (store.modelTracksStatus === "error") {
    const reason = "Model a-deck feed unreachable.";
    out.showModelTracks = { available: false, reason };
    out.showEnsembleEnvelope = { available: false, reason };
    out.showAiEnvelope = { available: false, reason };
    out.showStrikeProbability = { available: false, reason };
  }

  // Threat products
  if (isInvest) {
    const reason = "Pre-advisory system — no NHC-issued threat products until an advisory is issued.";
    out.showWatchesWarnings = { available: false, reason };
    out.showSurge = { available: false, reason };
  } else if (bundleLoaded) {
    out.showWatchesWarnings = data!.watchesWarnings.length > 0
      ? { available: true }
      : {
          available: false,
          reason: "No active NHC watches or warnings for this storm's coastline right now.",
        };
    out.showSurge = data!.peakSurge.length > 0
      ? { available: true }
      : {
          available: false,
          reason: "NHC has not issued a peak-surge product for this storm (only issued when a surge threat exists).",
        };
  }
  if (bundleLoaded) {
    out.showAlerts = data!.alerts.length > 0
      ? { available: true }
      : {
          available: false,
          reason: "No non-hurricane NWS alerts (flood/tornado/wind) in this storm's bbox.",
        };
  }

  // Wind & observations
  if (bundleLoaded) {
    out.showWindMap = data!.windMap.length > 0
      ? { available: true }
      : {
          available: false,
          reason: "No surface obs in this bbox — likely an open-ocean storm out of NDBC + land-station range.",
        };
    out.showWindParticles = data!.windMap.length > 0
      ? { available: true }
      : {
          available: false,
          reason: "Wind particles are driven by the same obs pool as the wind-speed map — none available in this bbox.",
        };
    out.showBuoys = data!.buoys.length > 0
      ? { available: true }
      : {
          available: false,
          reason: "No NDBC buoys in this storm's bbox.",
        };
    out.showLand = data!.landStations.length > 0
      ? { available: true }
      : {
          available: false,
          reason: "No NWS land stations in this storm's bbox (likely open-ocean or non-CONUS).",
        };
    out.showSst = data!.sst.length > 0
      ? { available: true }
      : {
          available: false,
          reason: "SST grid unavailable for this bbox.",
        };
  }

  return out;
}

function ChipGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: "0.6rem",
          color: "var(--ink-500)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

/**
 * 2-day vs 5-day vs both toggle for the GTWO overlay. Small three-segment
 * pill, spans two columns so it lives directly under the TWO chip.
 */
/**
 * Compact status line under the TWO chip. Shows loading / error state and
 * a bucket-count summary ("2 high, 1 low") when data is loaded. NHC's KML
 * only ships the 7-day formation envelope as a single product, so there's
 * no window toggle — the previous 2d/5d/both selector was for a two-URL
 * scheme that turned out not to exist.
 */
function GTWOStatusLine({
  store,
}: {
  store: ReturnType<typeof useLiveStormStore.getState>;
}) {
  if (!store.showGTWO) return null;
  const areas = store.gtwoData?.areas ?? [];
  const status = store.gtwoStatus;
  const highCount = areas.filter((a) => a.chanceBucket === "high").length;
  const medCount = areas.filter((a) => a.chanceBucket === "medium").length;
  const lowCount = areas.filter((a) => a.chanceBucket === "low").length;

  return (
    <div style={{ gridColumn: "span 2", display: "grid", gap: 4 }}>
      {status === "loading" && (
        <div style={{ fontSize: "0.62rem", color: "var(--ink-500)" }}>Loading outlook…</div>
      )}
      {status === "error" && (
        <div style={{ fontSize: "0.62rem", color: "var(--error-700)" }}>
          Outlook feed unreachable.
        </div>
      )}
      {status === "ok" && areas.length > 0 && (
        <div style={{ display: "flex", gap: 6, fontSize: "0.62rem", alignItems: "center", flexWrap: "wrap" }}>
          {highCount > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: GTWO_BUCKET_COLOR.high }} />
              <strong>{highCount}</strong> high
            </span>
          )}
          {medCount > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: GTWO_BUCKET_COLOR.medium }} />
              <strong>{medCount}</strong> med
            </span>
          )}
          {lowCount > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: GTWO_BUCKET_COLOR.low }} />
              <strong>{lowCount}</strong> low
            </span>
          )}
          {store.gtwoData?.issuedNote && (
            <span style={{ color: "var(--ink-500)", marginLeft: "auto" }}>
              Issued {store.gtwoData.issuedNote}
            </span>
          )}
        </div>
      )}
      {status === "empty" && (
        <div style={{ fontSize: "0.62rem", color: "var(--ink-500)" }}>
          No active areas — basin is quiet.
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
  variant = "active",
}: {
  label: string;
  rows: LiveStormRow[];
  activeId: string | null;
  onPick: (id: string) => void;
  variant?: "active" | "invest" | "replay";
}) {
  // Loading state so we can show a spinner on the active picker button
  // while the a-deck / bundle fetch is in flight — previously the button
  // gave one instant colour change on click, then went silent for the
  // 1-3 seconds of load, which read as "did my click even work?".
  const isLoading = useLiveStormStore((s) => s.isLoading);
  const modelTracksLoading = useLiveStormStore((s) => s.modelTracksStatus) === "loading";
  const busy = isLoading || modelTracksLoading;

  // Distinct pastel per variant, with an "intensified" version for the
  // active state so the button reads clearly as "on" without abandoning
  // the variant colour scheme. Previously the active state used a
  // brand-blue background regardless of variant — which read as jarring
  // against the yellow invest bg (the "gray with yellow outline" bug the
  // user hit was actually the brand-50 fill against the yellow border).
  const variantStyle: Record<
    "active" | "invest" | "replay",
    {
      idle:   { bg: string; border: string; text: string };
      active: { bg: string; border: string; text: string; dot: string };
      label:  string;
      hint?:  string;
    }
  > = {
    active: {
      idle:   { bg: "var(--ink-50)",  border: "var(--ink-200)",  text: "var(--ink-800)" },
      active: { bg: "var(--brand-50)", border: "var(--brand-600)", text: "var(--brand-800)", dot: "var(--brand-700)" },
      label:  "var(--ink-500)",
    },
    invest: {
      idle:   { bg: "#fef3c7", border: "#fbbf24", text: "#78350f" },
      active: { bg: "#fde68a", border: "#b45309", text: "#78350f", dot: "#b45309" },
      label:  "#78350f",
      hint:   "Pre-advisory invest — model tracks + strike probability available; NHC-issued products (cone, watches) start when an advisory does.",
    },
    replay: {
      idle:   { bg: "#f1f5f9", border: "#cbd5e1", text: "#475569" },
      active: { bg: "#e2e8f0", border: "#475569", text: "#0f172a", dot: "#475569" },
      label:  "#475569",
    },
  };
  const vs = variantStyle[variant];
  return (
    <div>
      <div
        style={{
          fontSize: "0.62rem",
          color: vs.label,
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
          const showSpinner = isActive && busy;
          const state = isActive ? vs.active : vs.idle;
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
                color: state.text,
                background: state.bg,
                border: `${isActive ? 2 : 1}px solid ${state.border}`,
                fontWeight: isActive ? 700 : 400,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
                // Compensate for the +1px border when active so text
                // doesn't shift on toggle.
                paddingLeft: isActive ? 7 : 8,
                paddingRight: isActive ? 7 : 8,
                paddingTop: isActive ? 3 : 4,
                paddingBottom: isActive ? 3 : 4,
              }}
              title={
                isActive
                  ? "Selected — click again to deselect and clear the map."
                  : vs.hint
              }
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.label}
              </span>
              {showSpinner && <PickerSpinner />}
              {isActive && !showSpinner && (
                <span
                  aria-hidden
                  style={{
                    fontSize: "0.8rem",
                    lineHeight: 1,
                    color: vs.active.dot,
                    fontWeight: 700,
                  }}
                >
                  ●
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Small inline spinner for the active picker button while its data is
 * fetching. Pure CSS keyframe — no library dep.
 */
function PickerSpinner() {
  return (
    <>
      <style>{`
        @keyframes ee-storm-picker-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <span
        aria-label="Loading"
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: "50%",
          border: "2px solid var(--brand-200, #93c5fd)",
          borderTopColor: "var(--brand-700, #1d4ed8)",
          animation: "ee-storm-picker-spin 0.8s linear infinite",
        }}
      />
    </>
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

/**
 * LayerChip wrapper that pulls per-chip availability out of the map returned
 * by useChipAvailability. Just spreads {disabled, disabledReason} onto the
 * base LayerChip so the panel-level JSX stays terse.
 */
function SmartChip(props: {
  store: ReturnType<typeof useLiveStormStore.getState>;
  k: ToggleKey;
  label: string;
  hint?: string;
  color: string;
  status: ChipStatus | undefined;
}) {
  const { status, ...rest } = props;
  const disabled = status ? !status.available : false;
  return (
    <LayerChip
      {...rest}
      disabled={disabled}
      disabledReason={disabled ? status?.reason : undefined}
    />
  );
}

function LayerChip({
  store,
  k,
  label,
  hint,
  color,
  disabled,
  disabledReason,
}: {
  store: ReturnType<typeof useLiveStormStore.getState>;
  k: ToggleKey;
  label: string;
  hint?: string;
  color: string;
  // "Disabled" here means the underlying data returned nothing for this
  // storm (or is semantically inapplicable, e.g. NHC cone for an invest).
  // The chip is still CLICKABLE — the user might want to toggle it anyway
  // to see the empty state on the map — but it's visually muted and the
  // tooltip includes the reason so users don't wonder why nothing happens.
  disabled?: boolean;
  disabledReason?: string;
}) {
  const active = store[k] as boolean;
  const baseTitle = hint ? `${label} — ${hint}` : label;
  const title = disabled && disabledReason
    ? `${baseTitle}\n\nNo data for this storm: ${disabledReason}`
    : baseTitle;
  return (
    <button
      type="button"
      onClick={() => store.setToggle(k, !active)}
      title={title}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 7px",
        borderRadius: 4,
        border: `1px solid ${
          disabled
            ? "var(--ink-200)"
            : active ? color : "var(--ink-200)"
        }`,
        background: disabled ? "var(--ink-50)" : active ? "#fff" : "transparent",
        fontSize: "0.7rem",
        color: disabled
          ? "var(--ink-400)"
          : active ? "var(--ink-900)" : "var(--ink-500)",
        opacity: disabled ? 0.55 : active ? 1 : 0.7,
        minHeight: 24,
        textDecoration: disabled ? "line-through" : "none",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 9,
          height: 9,
          borderRadius: 2,
          background: disabled
            ? "transparent"
            : active ? color : "transparent",
          border: `1.5px solid ${disabled ? "var(--ink-300)" : color}`,
          flexShrink: 0,
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </button>
  );
}

/**
 * "Exposed TIV inside NHC watches/warnings" panel section. Groups WWs by
 * family (hurricane / TS / storm surge) and computes rolled-up TIV per
 * family + a combined total across all polygon-bearing WWs.
 *
 * All rollups walk through the same synthetic-point / point-in-polygon
 * machinery wildfire + flood use — flagged synthetic in the note and
 * warned as an upper bound since WWs are threat areas, not observed damage.
 * Zone-coded WWs (no polygon) are counted but excluded from the TIV rollup
 * with an explicit callout.
 */
function WatchWarnExposureSection({ data }: { data: LiveStormBundle }) {
  const [result, setResult] = useState<WatchWarnExposureResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(
    () => new Set(["hurricane", "tropical_storm", "storm_surge", "extreme_wind"]),
  );

  const withGeom = data.watchesWarnings.filter((w) => w.geometry);
  if (withGeom.length === 0 && data.watchesWarningsZoneOnly === 0) return null;

  const familyLabel: Record<string, string> = {
    hurricane: "Hurricane",
    tropical_storm: "Tropical Storm",
    storm_surge: "Storm Surge",
    extreme_wind: "Extreme Wind",
    statement: "Statement",
    other: "Other",
  };
  const familyCounts = withGeom.reduce<Record<string, NHCWatchWarn[]>>(
    (acc, w) => {
      (acc[w.family] ??= []).push(w);
      return acc;
    },
    {},
  );

  async function runExposure() {
    const polygons = withGeom
      .filter((w) => selectedFamilies.has(w.family))
      .map((w) => ({
        id: w.alertId,
        name: `${familyLabel[w.family] ?? w.family} · ${w.event}`,
        geometry: w.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon,
      }));
    if (polygons.length === 0) {
      setError("Select at least one watch/warning family.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await postWatchWarnExposure(polygons);
      setResult(r);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  const toggleFamily = (family: string) => {
    const next = new Set(selectedFamilies);
    if (next.has(family)) next.delete(family);
    else next.add(family);
    setSelectedFamilies(next);
    setResult(null);
  };

  const fmt = (n: number) =>
    n >= 1e9
      ? `${(n / 1e9).toFixed(2)} B`
      : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} M`
      : n.toLocaleString(undefined, { maximumFractionDigits: 0 });

  return (
    <div
      style={{
        background: "#fef2f8",
        border: "1px solid #f9a8d4",
        borderRadius: 4,
        padding: 8,
        fontSize: "0.68rem",
        color: "var(--ink-800)",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ fontWeight: 700, color: "#9d174d", fontSize: "0.7rem" }}>
        Exposed TIV — NHC Watches / Warnings
      </div>
      {data.watchesWarningsZoneOnly > 0 && (
        <div style={{ fontSize: "0.62rem", color: "#78350f", background: "#fef3c7", padding: "3px 5px", borderRadius: 3 }}>
          {data.watchesWarningsZoneOnly} zone-coded WW without polygon — counted but not rolled up here.
        </div>
      )}
      <div style={{ display: "grid", gap: 3 }}>
        {Object.entries(familyCounts).map(([family, ww]) => {
          const on = selectedFamilies.has(family);
          const color = ww[0]?.color ?? "#94a3b8";
          return (
            <label
              key={family}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
                padding: "2px 4px",
                borderRadius: 3,
                background: on ? "rgba(255,255,255,0.7)" : "transparent",
              }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggleFamily(family)}
                style={{ cursor: "pointer" }}
              />
              <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: color }} />
              <span style={{ flex: 1 }}>{familyLabel[family] ?? family}</span>
              <span style={{ color: "var(--ink-500)" }}>{ww.length}</span>
            </label>
          );
        })}
      </div>
      <button
        type="button"
        onClick={runExposure}
        disabled={loading}
        style={{
          all: "unset",
          cursor: loading ? "wait" : "pointer",
          padding: "5px 8px",
          borderRadius: 3,
          background: "#ec4899",
          color: "white",
          textAlign: "center",
          fontWeight: 700,
          fontSize: "0.68rem",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? "Computing…" : "Compute exposed TIV"}
      </button>
      {error && (
        <div style={{ color: "var(--error-700)", fontSize: "0.65rem" }}>{error}</div>
      )}
      {result && (
        <div style={{ display: "grid", gap: 3 }}>
          <div style={{ fontWeight: 700, color: "#0f172a" }}>
            Combined: {fmt(result.combined.totalTiv)} {result.currency} ·{" "}
            {result.combined.locationCount} synthetic locs
          </div>
          {result.combined.byClient.slice(0, 6).map((c) => (
            <div
              key={c.client}
              style={{ display: "flex", justifyContent: "space-between", fontSize: "0.66rem" }}
            >
              <span style={{ color: "var(--ink-700)" }}>{c.client}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {fmt(c.tiv)} · {c.locationCount}
              </span>
            </div>
          ))}
          {result.combined.byClient.length > 6 && (
            <div style={{ fontSize: "0.62rem", color: "var(--ink-500)" }}>
              +{result.combined.byClient.length - 6} more clients
            </div>
          )}
          {result.synthetic && (
            <div style={{ fontSize: "0.6rem", color: "var(--ink-500)", fontStyle: "italic", marginTop: 2 }}>
              Upper bound — synthetic county-scattered points; WWs are threat areas.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Family legend + toggles for the model ensemble spaghetti. Shows counts
 * per family + current-cycle context, and lets an underwriter mute the
 * fifty-strong ensembles when only the AI + deterministic + consensus
 * signal is wanted (or the reverse).
 */
function ModelTracksSection() {
  const status = useLiveStormStore((s) => s.modelTracksStatus);
  const tracks = useLiveStormStore((s) => s.modelTracks);
  const visible = useLiveStormStore((s) => s.visibleFamilies);
  const toggleFamily = useLiveStormStore((s) => s.toggleFamily);

  const familyLabel: Record<ModelFamily, string> = {
    official: "NHC Official",
    consensus: "Consensus (TVCN / HCCA)",
    ai: "AI models",
    gfs_det: "GFS deterministic",
    gfs_mean: "GEFS mean",
    gefs_ens: "GEFS members",
    ecmwf_det: "ECMWF-HRES",
    ecmwf_mean: "ECMWF-ENS mean",
    ecmwf_ens: "ECMWF-ENS members",
    regional: "Regional (HWRF / HMON / HAFS)",
    cmc: "CMC (Canadian)",
    ukmet: "UKMO",
    navgem: "NAVGEM",
    baseline: "Baselines (CLIPER / SHIPS)",
    analysis: "Analysis (CARQ)",
    other: "Other",
  };

  return (
    <div
      style={{
        background: "#faf5ff",
        border: "1px solid #d8b4fe",
        borderRadius: 4,
        padding: 8,
        fontSize: "0.68rem",
        color: "var(--ink-800)",
        display: "grid",
        gap: 4,
      }}
    >
      <div style={{ fontWeight: 700, color: "#6b21a8", fontSize: "0.7rem" }}>
        Model ensemble — GEFS · ECMWF-ENS · AI
      </div>
      {status === "loading" && <div>Loading a-deck…</div>}
      {status === "error" && (
        <div style={{ color: "var(--error-700)" }}>Could not load a-deck.</div>
      )}
      {status === "empty" && (
        <div style={{ fontSize: "0.62rem", color: "#78350f", background: "#fef3c7", padding: 4, borderRadius: 3 }}>
          No a-deck rows yet — very early in the storm's lifecycle. Check back
          after the next NHC advisory.
        </div>
      )}
      {tracks && tracks.tracks.length > 0 && (
        <>
          <div style={{ fontSize: "0.62rem", color: "var(--ink-500)" }}>
            Init cycle {tracks.initCycle} · {tracks.tracks.length} tracks ·{" "}
            {tracks.ensembleEnvelope
              ? `${tracks.ensembleEnvelope.membersUsed}-member envelope`
              : "envelope: n/a"}
          </div>
          <div style={{ display: "grid", gap: 2 }}>
            {tracks.families.map((f) => {
              const on = visible.has(f.family);
              const color = FAMILY_COLOR[f.family] ?? "#a1a1aa";
              return (
                <label
                  key={f.family}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    cursor: "pointer",
                    padding: "2px 4px",
                    borderRadius: 3,
                    background: on ? "rgba(255,255,255,0.7)" : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleFamily(f.family)}
                    style={{ cursor: "pointer" }}
                  />
                  <span
                    style={{
                      display: "inline-block",
                      width: 14,
                      height: 3,
                      background: color,
                      borderRadius: 1,
                    }}
                  />
                  <span style={{ flex: 1 }}>{familyLabel[f.family] ?? f.family}</span>
                  <span style={{ color: "var(--ink-500)", fontSize: "0.62rem" }}>
                    {f.trackCount}
                  </span>
                </label>
              );
            })}
          </div>
          {tracks.notes.length > 0 && (
            <div style={{ fontSize: "0.6rem", color: "var(--ink-500)", fontStyle: "italic" }}>
              {tracks.notes[0]}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Ensemble-risk summary section: threshold slider, top-10 exposed counties,
 * and an intensity-spread sparkline (min/mean/max wind kt per lead time).
 *
 * The sparkline is inline SVG rather than a chart library to stay under
 * the frontend deps discipline the rest of the panel keeps.
 */
function EnsembleRiskSection() {
  const status = useLiveStormStore((s) => s.ensembleRiskStatus);
  const risk = useLiveStormStore((s) => s.ensembleRisk);
  const threshold = useLiveStormStore((s) => s.strikeThresholdNm);
  const setThreshold = useLiveStormStore((s) => s.setStrikeThresholdNm);

  const top = (risk?.strikeByCounty ?? []).slice(0, 8);

  return (
    <div
      style={{
        background: "#fff1f2",
        border: "1px solid #fda4af",
        borderRadius: 4,
        padding: 8,
        fontSize: "0.68rem",
        color: "var(--ink-800)",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ fontWeight: 700, color: "#9f1239", fontSize: "0.7rem" }}>
        Ensemble strike probability + intensity spread
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: "var(--ink-500)", fontSize: "0.62rem", textTransform: "uppercase" }}>
          Threshold
        </span>
        <input
          type="range"
          min={20}
          max={150}
          step={10}
          value={threshold}
          onChange={(e) => setThreshold(+e.target.value)}
          style={{ flex: 1, accentColor: "#dc2626" }}
        />
        <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{threshold} nm</span>
      </div>

      {status === "loading" && <div>Computing…</div>}
      {status === "error" && (
        <div style={{ color: "var(--error-700)" }}>Could not compute risk aggregates.</div>
      )}
      {status === "empty" && risk && (
        <div style={{ fontSize: "0.62rem", color: "#78350f", background: "#fef3c7", padding: 4, borderRadius: 3 }}>
          {risk.notes[0] ?? "No counties within threshold."}
        </div>
      )}
      {risk && risk.strikeByCounty.length > 0 && (
        <>
          <div style={{ fontSize: "0.62rem", color: "var(--ink-500)" }}>
            {risk.ensembleTotal} ensemble members · {risk.strikeByCounty.length} coastal counties within {risk.thresholdNm.toFixed(0)} nm
          </div>
          <div style={{ display: "grid", gap: 2 }}>
            {top.map((c) => (
              <div
                key={c.geoid}
                style={{ display: "flex", justifyContent: "space-between", fontSize: "0.66rem" }}
              >
                <span>
                  <strong>{c.name}</strong>, {c.stateUsps}
                </span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ color: c.strikeProbability >= 0.6 ? "#7f1d1d" : c.strikeProbability >= 0.3 ? "#b45309" : "#475569", fontWeight: 700 }}>
                    {(c.strikeProbability * 100).toFixed(0)}%
                  </span>
                  <span style={{ color: "var(--ink-500)" }}>
                    {" "}· {c.memberCount}/{c.ensembleTotal} · peak {c.maxIntensityKt} kt
                  </span>
                </span>
              </div>
            ))}
          </div>
          {risk.strikeByCounty.length > top.length && (
            <div style={{ fontSize: "0.6rem", color: "var(--ink-500)" }}>
              +{risk.strikeByCounty.length - top.length} more counties on the map
            </div>
          )}
          {risk.intensityByLead.length > 0 && (
            <IntensitySparkline stats={risk.intensityByLead} />
          )}
        </>
      )}
    </div>
  );
}

/** Compact SVG intensity-spread chart. X = lead time (h), Y = wind kt.
 *  Shaded band = min→max across ensemble members; line = mean. */
function IntensitySparkline({
  stats,
}: {
  stats: import("../../api/live").IntensityStat[];
}) {
  if (stats.length < 2) return null;
  const w = 320;
  const h = 90;
  const pad = { l: 32, r: 8, t: 8, b: 20 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const maxHours = Math.max(...stats.map((s) => s.hoursOut));
  const maxKt = Math.max(...stats.map((s) => s.maxKt), 100);
  const minKt = 0;

  const x = (hours: number) => pad.l + (hours / maxHours) * iw;
  const y = (kt: number) => pad.t + ih - ((kt - minKt) / (maxKt - minKt)) * ih;

  // Band polygon (min → max envelope across lead times).
  const upper = stats.map((s) => `${x(s.hoursOut)},${y(s.maxKt)}`).join(" ");
  const lower = stats
    .slice()
    .reverse()
    .map((s) => `${x(s.hoursOut)},${y(s.minKt)}`)
    .join(" ");

  // Mean line.
  const meanPath = stats
    .map((s, i) => `${i === 0 ? "M" : "L"}${x(s.hoursOut)},${y(s.meanKt)}`)
    .join(" ");

  // Y-axis category-boundary reference lines (34 kt = TS, 64 kt = Cat 1,
  // 96 kt = Cat 3). Helps a reader place mean intensity in context without
  // needing a full grid.
  const yRefs = [34, 64, 96].filter((v) => v < maxKt);

  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          fontSize: "0.62rem",
          color: "var(--ink-500)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Intensity spread (kt) by lead time
      </div>
      <svg width={w} height={h} style={{ maxWidth: "100%", height: "auto" }}>
        {yRefs.map((v) => (
          <g key={v}>
            <line
              x1={pad.l}
              x2={w - pad.r}
              y1={y(v)}
              y2={y(v)}
              stroke="#e2e8f0"
              strokeDasharray="2 2"
            />
            <text
              x={pad.l - 3}
              y={y(v) + 3}
              fontSize="8"
              textAnchor="end"
              fill="#94a3b8"
            >
              {v}
            </text>
          </g>
        ))}
        <polygon
          points={`${upper} ${lower}`}
          fill="#fda4af"
          fillOpacity={0.35}
          stroke="none"
        />
        <path d={meanPath} stroke="#dc2626" strokeWidth={2} fill="none" />
        {stats.map((s) => (
          <circle
            key={s.hoursOut}
            cx={x(s.hoursOut)}
            cy={y(s.meanKt)}
            r={2.5}
            fill="#dc2626"
          />
        ))}
        {stats.map((s) => (
          <text
            key={`t-${s.hoursOut}`}
            x={x(s.hoursOut)}
            y={h - 6}
            fontSize="8"
            textAnchor="middle"
            fill="#64748b"
          >
            T+{s.hoursOut}h
          </text>
        ))}
      </svg>
      <div style={{ fontSize: "0.6rem", color: "var(--ink-500)" }}>
        Band = min→max across ensemble; line = mean.
      </div>
    </div>
  );
}

function BundleSummary({ data }: { data: import("../../api/live").LiveStormBundle }) {
  const isInvest = data.storm.classification === "INVEST";
  // Invests get a distinct pale-yellow summary card matching the picker
  // treatment, plus an explicit note that NHC-issued products (cone, surge,
  // watches/warnings) will be empty until an advisory is issued.
  const bg = isInvest ? "#fef3c7" : "var(--brand-50)";
  const border = isInvest ? "#fbbf24" : "var(--brand-400)";
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
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
      {isInvest && (
        <div style={{ fontSize: "0.62rem", color: "#78350f", fontStyle: "italic" }}>
          Pre-advisory invest — enable "Model tracks" + "Strike probability"
          for the ensemble signal. NHC cone / watches / surge remain empty
          until an advisory is issued.
        </div>
      )}
      <div>{data.observedTrack.length} observed fixes · {data.forecasts.length} advisories</div>
      {data.watchesWarnings.length > 0 && (
        <div>
          <strong>{data.watchesWarnings.length}</strong> NHC watches/warnings
          {data.watchesWarningsZoneOnly > 0 && (
            <span style={{ color: "var(--ink-500)" }}>
              {" "}({data.watchesWarningsZoneOnly} zone-only)
            </span>
          )}
        </div>
      )}
      <div>{data.alerts.length} other alerts · {data.buoys.length} buoys</div>
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
