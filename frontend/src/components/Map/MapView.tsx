/**
 * Choropleth map — main feature of the workbench.
 *
 * Renders two Mapbox vector tilesets (state + county) and colors them via
 * `feature-state`, joined by FIPS to API data from POST /api/exposures/map.
 *
 *   STATE  layer  ← bermuda1023.tdub0xmgbp11 / fa8d0f12ddc097d30cfe (key: STATE  → 2-digit FIPS)
 *   COUNTY layer  ← bermuda1023.wnwbodo0p98t / b2e6c22804c918d996b3 (key: GEOID  → 5-digit FIPS)
 *
 * Vector tiles → no GeoJSON download; pan/zoom stays smooth at any grain.
 * Auto-level:  zoom < 6.0  → STATE, zoom ≥ 6.0 → COUNTY (drives /api refetch).
 * Hover → tooltip with formula reminders. Click → opens detail panel.
 *
 * Map data comes ONLY from /api/exposures/map (CLAUDE.md rule 1).
 */

import mapboxgl, { type Map as MbMap, type MapMouseEvent } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MapFeature, MapResponse } from "../../api/types";
import { useViewStore } from "../../state/view";
import { AggregationLevel } from "../../types/contracts";
import { formatMoneyCompact } from "../../lib/format";
import { colorForValue, NO_DATA_COLOR, rampForMetric } from "./colorRamp";
import {
  countyGeographyIdFromGeoid,
  partsFromGeographyId,
  stateGeographyIdFromFips,
} from "./fipsToUsps";
import { HurricaneLayer } from "./HurricaneLayer";
import { HurricaneImpactPanel } from "./HurricaneImpactPanel";
import { HazardOverlayLayer } from "./HazardOverlayLayer";
import { HazardOverlayLegend } from "./HazardOverlayLegend";
import { LiveStormLayer } from "./LiveStormLayer";
import { LiveStormPanel } from "./LiveStormPanel";
import { useHurricaneImpactStore } from "../../state/hurricaneImpact";
import { MapTooltip } from "./Tooltip";

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? "";

// Tileset config. Source-layer ids come from /v4/{tileset}.json metadata.
const STATE_TILESET = {
  src: "boundaries-states",
  url: "mapbox://bermuda1023.tdub0xmgbp11",
  layer: "fa8d0f12ddc097d30cfe",
  keyField: "STATE", // 2-digit state FIPS
};
const COUNTY_TILESET = {
  src: "boundaries-counties",
  url: "mapbox://bermuda1023.wnwbodo0p98t",
  layer: "b2e6c22804c918d996b3",
  keyField: "GEOID", // 5-digit county FIPS
};

const STATE_FILL = "state-fill";
const STATE_LINE = "state-line";
const COUNTY_FILL = "county-fill";
const COUNTY_LINE = "county-line";

// Zoom at which the county layer becomes the primary fill (and hover target).
// Drives BOTH the visibility envelopes below AND the hover/click level pick
// so the tooltip works the instant counties are visible — no need to zoom in
// further before the cursor responds.
const COUNTY_THRESHOLD = 4.0;
// Hard cut at COUNTY_THRESHOLD so the visible level + the API-fetch level + the
// hover-target level all flip simultaneously. Previously they overlapped by
// ±0.2–0.4 which produced a band where you saw county polygons but the stats
// were still aggregated at state level.
const STATE_ENV: [number, number] = [0, COUNTY_THRESHOLD];
const COUNTY_ENV: [number, number] = [COUNTY_THRESHOLD, 22];

function levelForZoom(zoom: number): AggregationLevel {
  return zoom >= COUNTY_THRESHOLD ? AggregationLevel.COUNTY : AggregationLevel.STATE;
}

interface Props {
  data: MapResponse | null | undefined;
  isLoading: boolean;
  error: unknown;
}

export function MapView({ data, isLoading, error }: Props) {
  const setLevel = useViewStore((s) => s.setAggregationLevel);
  const setSelected = useViewStore((s) => s.setSelectedGeographyId);
  const selected = useViewStore((s) => s.selectedGeographyId);
  const aggregationLevel = useViewStore((s) => s.aggregationLevel);
  const metric = useViewStore((s) => s.metric);
  const yoyMode = useViewStore((s) => s.yoyMode);

  const features = data?.features ?? [];
  const ramp = useMemo(
    () => rampForMetric(metric, features, { signed: yoyMode }),
    [metric, features, yoyMode],
  );
  const valuesByGeographyId = useMemo(() => {
    const m = new Map<string, MapFeature>();
    for (const f of features) m.set(f.geographyId, f);
    return m;
  }, [features]);

  const hasToken = TOKEN.length > 0;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MbMap | null>(null);
  const [mapInstance, setMapInstance] = useState<MbMap | null>(null);
  const styleReadyRef = useRef(false);
  // Track which feature ids currently have state set so we can clear stale ones.
  const stateSetIdsRef = useRef<Set<string>>(new Set());
  const countySetIdsRef = useRef<Set<string>>(new Set());

  const [hovered, setHovered] = useState<MapFeature | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // ── Map init ──
  useEffect(() => {
    if (!hasToken || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-97, 38],
      zoom: 3.6,
      minZoom: 2,
      maxZoom: 12,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new mapboxgl.ScaleControl({ unit: "imperial" }), "bottom-left");

    map.on("load", () => {
      // ── State source + layers ──
      map.addSource(STATE_TILESET.src, {
        type: "vector",
        url: STATE_TILESET.url,
        promoteId: { [STATE_TILESET.layer]: STATE_TILESET.keyField },
      });
      map.addLayer({
        id: STATE_FILL,
        type: "fill",
        source: STATE_TILESET.src,
        "source-layer": STATE_TILESET.layer,
        minzoom: STATE_ENV[0],
        maxzoom: STATE_ENV[1],
        paint: {
          "fill-color": [
            "coalesce",
            ["feature-state", "fill"],
            NO_DATA_COLOR,
          ],
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hasData"], false],
            0.8,
            0.04,
          ],
        },
      });
      map.addLayer({
        id: STATE_LINE,
        type: "line",
        source: STATE_TILESET.src,
        "source-layer": STATE_TILESET.layer,
        minzoom: STATE_ENV[0],
        maxzoom: STATE_ENV[1],
        paint: { "line-color": "#2c3a52", "line-width": 0.8, "line-opacity": 0.7 },
      });

      // ── County source + layers ──
      map.addSource(COUNTY_TILESET.src, {
        type: "vector",
        url: COUNTY_TILESET.url,
        promoteId: { [COUNTY_TILESET.layer]: COUNTY_TILESET.keyField },
      });
      map.addLayer({
        id: COUNTY_FILL,
        type: "fill",
        source: COUNTY_TILESET.src,
        "source-layer": COUNTY_TILESET.layer,
        minzoom: COUNTY_ENV[0],
        maxzoom: COUNTY_ENV[1],
        paint: {
          "fill-color": [
            "coalesce",
            ["feature-state", "fill"],
            NO_DATA_COLOR,
          ],
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "hasData"], false],
            0.8,
            0.04,
          ],
        },
      });
      // Hazard overlay choropleth — sits above the exposure choropleth so a
      // selected peril (tornado/hail/wildfire) replaces the data wash. Always
      // present; visibility is flipped by HazardOverlayLayer when a peril is
      // active vs cleared.
      map.addLayer({
        id: "county-hazard-fill",
        type: "fill",
        source: COUNTY_TILESET.src,
        "source-layer": COUNTY_TILESET.layer,
        minzoom: 0,
        maxzoom: COUNTY_ENV[1],
        layout: { visibility: "none" },
        paint: {
          "fill-color": [
            "coalesce",
            ["feature-state", "hazardColor"],
            "rgba(0,0,0,0)",
          ],
          "fill-opacity": 0.72,
        },
      });
      map.addLayer({
        id: COUNTY_LINE,
        type: "line",
        // Lift the COUNTY_THRESHOLD floor so impact-highlighted county
        // outlines remain visible at low zoom too — without the data
        // wash overpainting them.
        source: COUNTY_TILESET.src,
        "source-layer": COUNTY_TILESET.layer,
        minzoom: 0,
        maxzoom: COUNTY_ENV[1],
        paint: {
          "line-color": [
            "case",
            // Focused (clicked in the impact detail panel) takes priority over
            // the generic storm-hit outline so the user can see WHICH impacted
            // county they just picked. Bright red so it stands out from the
            // darker red stormHit ring.
            ["==", ["feature-state", "stormFocused"], true],
            "#ef4444",
            ["==", ["feature-state", "stormHit"], true],
            "#dc2626",
            "#2c3a52",
          ],
          "line-width": [
            "case",
            ["==", ["feature-state", "stormFocused"], true],
            5.0,
            ["==", ["feature-state", "stormHit"], true],
            2.2,
            0.3,
          ],
          "line-blur": [
            "case",
            ["==", ["feature-state", "stormFocused"], true],
            3,
            0,
          ],
          "line-opacity": [
            "case",
            ["==", ["feature-state", "stormFocused"], true],
            1.0,
            ["==", ["feature-state", "stormHit"], true],
            0.95,
            // Fade county outlines in/out around the COUNTY_THRESHOLD so
            // we don't see a wall of county borders at country zoom.
            [
              "interpolate",
              ["linear"],
              ["zoom"],
              COUNTY_THRESHOLD - 0.4, 0,
              COUNTY_THRESHOLD, 0.6,
            ],
          ],
        },
      });

      // Inner fill glow for the focused county — light red tint over the
      // existing choropleth so the county appears to gently pulse without
      // hiding its data.
      map.addLayer({
        id: "county-focus-fill",
        type: "fill",
        source: COUNTY_TILESET.src,
        "source-layer": COUNTY_TILESET.layer,
        minzoom: 0,
        maxzoom: COUNTY_ENV[1],
        paint: {
          "fill-color": "#ef4444",
          "fill-opacity": [
            "case",
            ["==", ["feature-state", "stormFocused"], true],
            0.28,
            0,
          ],
        },
      });

      styleReadyRef.current = true;
      // First-paint sync of any data that arrived before the style was ready.
      flushFeatureState();
    });

    // Mapbox: feature-state set BEFORE a tile loads doesn't always apply to
    // newly-loaded tiles. Reapply stormHit highlights whenever the county
    // source finishes loading new tiles (the choropleth flush handles itself).
    map.on("sourcedata", (ev) => {
      if (ev.sourceId !== COUNTY_TILESET.src) return;
      if (!ev.isSourceLoaded) return;
      for (const id of hitIdsRef.current) {
        map.setFeatureState(
          { source: COUNTY_TILESET.src, sourceLayer: COUNTY_TILESET.layer, id },
          { stormHit: true },
        );
      }
      const focused = focusedGeoidRef.current;
      if (focused) {
        map.setFeatureState(
          { source: COUNTY_TILESET.src, sourceLayer: COUNTY_TILESET.layer, id: focused },
          { stormFocused: true },
        );
      }
    });

    mapRef.current = map;
    setMapInstance(map);

    // ResizeObserver: re-fit the canvas to the container after panel collapse,
    // resize, drag, or window resize. Mapbox only listens to window-resize by
    // default; arbitrary container size changes aren't observed.
    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        try {
          map.resize();
        } catch {
          /* map removed mid-flight */
        }
      });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(resizeFrame);
      map.remove();
      mapRef.current = null;
      setMapInstance(null);
      styleReadyRef.current = false;
      stateSetIdsRef.current.clear();
      countySetIdsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken]);

  // ── Zoom → aggregationLevel ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let frame = 0;
    const handler = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = levelForZoom(map.getZoom());
        if (next !== useViewStore.getState().aggregationLevel) {
          setLevel(next);
        }
      });
    };
    map.on("zoomend", handler);
    return () => {
      map.off("zoomend", handler);
      cancelAnimationFrame(frame);
    };
  }, [setLevel, hasToken]);

  // ── Hover + click handlers ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMove = (e: MapMouseEvent) => {
      const z = map.getZoom();
      const isCounty = z >= COUNTY_THRESHOLD;
      const layer = isCounty ? COUNTY_FILL : STATE_FILL;
      const feats = map.queryRenderedFeatures(e.point, { layers: [layer] });
      const props = feats[0]?.properties as Record<string, unknown> | undefined;
      const gid = isCounty
        ? countyGeographyIdFromGeoid(props?.GEOID as string | undefined)
        : stateGeographyIdFromFips(props?.STATE as string | undefined);
      if (gid) {
        const apiFeat = valuesByGeographyId.get(gid);
        if (apiFeat) {
          setHovered(apiFeat);
          setCursor({ x: e.point.x, y: e.point.y });
          map.getCanvas().style.cursor = "pointer";
          return;
        }
      }
      setHovered(null);
      setCursor(null);
      map.getCanvas().style.cursor = "";
    };
    const onLeave = () => {
      setHovered(null);
      setCursor(null);
      map.getCanvas().style.cursor = "";
    };
    const onClick = (e: MapMouseEvent) => {
      const z = map.getZoom();
      const isCounty = z >= COUNTY_THRESHOLD;
      const layer = isCounty ? COUNTY_FILL : STATE_FILL;
      const feats = map.queryRenderedFeatures(e.point, { layers: [layer] });
      const props = feats[0]?.properties as Record<string, unknown> | undefined;
      const gid = isCounty
        ? countyGeographyIdFromGeoid(props?.GEOID as string | undefined)
        : stateGeographyIdFromFips(props?.STATE as string | undefined);
      if (gid) setSelected(gid);
    };

    map.on("mousemove", onMove);
    map.on("mouseleave", onLeave);
    map.on("click", onClick);
    return () => {
      map.off("mousemove", onMove);
      map.off("mouseleave", onLeave);
      map.off("click", onClick);
    };
  }, [valuesByGeographyId, setSelected]);

  // ── Sync API data → feature-state ──
  function flushFeatureState() {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;

    const targetIsCounty = aggregationLevel === AggregationLevel.COUNTY;
    const targetSrc = targetIsCounty ? COUNTY_TILESET : STATE_TILESET;
    const targetIdSetRef = targetIsCounty ? countySetIdsRef : stateSetIdsRef;
    const otherIdSetRef = targetIsCounty ? stateSetIdsRef : countySetIdsRef;
    const otherSrc = targetIsCounty ? STATE_TILESET : COUNTY_TILESET;

    // Clear feature-state on the OTHER level so old colors don't linger.
    for (const id of otherIdSetRef.current) {
      map.removeFeatureState({ source: otherSrc.src, sourceLayer: otherSrc.layer, id });
    }
    otherIdSetRef.current.clear();

    // Diff current → desired ids for the active level.
    const desired = new Set<string>();
    for (const f of features) {
      const { level, stateFips, countyGeoid } = partsFromGeographyId(f.geographyId);
      const id = targetIsCounty ? countyGeoid : stateFips;
      if (!id) continue;
      // Only color rows whose level matches the current map level.
      if (targetIsCounty && level !== "county") continue;
      if (!targetIsCounty && level !== "state") continue;
      desired.add(id);
      map.setFeatureState(
        { source: targetSrc.src, sourceLayer: targetSrc.layer, id },
        {
          fill: colorForValue(f.metricValue, ramp),
          hasData: true,
        },
      );
    }
    // Clear any previously-painted ids that are no longer in the response.
    for (const id of targetIdSetRef.current) {
      if (!desired.has(id)) {
        map.removeFeatureState({ source: targetSrc.src, sourceLayer: targetSrc.layer, id });
      }
    }
    targetIdSetRef.current = desired;
  }

  useEffect(() => {
    flushFeatureState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, ramp, aggregationLevel]);

  // ── Sync hurricane-impact county highlights via feature-state ──
  const impactStormId = useHurricaneImpactStore((s) => s.activeStormId);
  const impactData = useHurricaneImpactStore((s) => s.data);
  const hitIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !styleReadyRef.current) return;
    // Clear previous hits.
    for (const id of hitIdsRef.current) {
      m.removeFeatureState(
        { source: COUNTY_TILESET.src, sourceLayer: COUNTY_TILESET.layer, id },
        "stormHit",
      );
    }
    hitIdsRef.current.clear();
    if (!impactData) return;
    for (const c of impactData.counties) {
      m.setFeatureState(
        { source: COUNTY_TILESET.src, sourceLayer: COUNTY_TILESET.layer, id: c.geoid },
        { stormHit: true },
      );
      hitIdsRef.current.add(c.geoid);
    }
    // Fly to the impacted-county footprint so the user immediately sees it.
    if (impactData.bbox) {
      const [w, s, e, n] = impactData.bbox;
      m.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: { top: 60, right: 380, bottom: 80, left: 60 }, duration: 900, maxZoom: 7 },
      );
    }
  }, [impactData, impactStormId]);

  // ── Spotlight the county the user just clicked in the impact detail panel ──
  const focusedGeoid = useHurricaneImpactStore((s) => s.focusedGeoid);
  const focusedGeoidRef = useRef<string | null>(null);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !styleReadyRef.current) return;
    // Drop the previous focus, if any.
    const prev = focusedGeoidRef.current;
    if (prev && prev !== focusedGeoid) {
      m.removeFeatureState(
        { source: COUNTY_TILESET.src, sourceLayer: COUNTY_TILESET.layer, id: prev },
        "stormFocused",
      );
    }
    focusedGeoidRef.current = focusedGeoid;
    if (!focusedGeoid) return;
    m.setFeatureState(
      { source: COUNTY_TILESET.src, sourceLayer: COUNTY_TILESET.layer, id: focusedGeoid },
      { stormFocused: true },
    );
    // Center the map on the focused county centroid so it's never off-screen,
    // but only nudge — don't zoom past where the user already is.
    const c = impactData?.counties.find((x) => x.geoid === focusedGeoid);
    if (c) {
      m.easeTo({
        center: [c.centroidLon, c.centroidLat],
        duration: 600,
        zoom: Math.max(m.getZoom(), 6),
      });
    }
  }, [focusedGeoid, impactData]);

  // ── Render ──
  if (!hasToken) {
    return (
      <FallbackTable
        data={data}
        isLoading={isLoading}
        error={error}
        selected={selected}
        onSelect={setSelected}
      />
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <HurricaneLayer map={mapInstance} />
      <HurricaneImpactPanel />
      <HazardOverlayLayer map={mapInstance} />
      <HazardOverlayLegend />
      <LiveStormLayer map={mapInstance} />
      <LiveStormPanel />
      {isLoading && (
        <Pill>
          <Spinner />
          Updating
        </Pill>
      )}
      {error ? (
        <Pill tone="error">
          Failed to load map: {String((error as Error)?.message ?? error)}
        </Pill>
      ) : null}
      <ZoomLevelIndicator level={aggregationLevel} />
      {hovered && cursor && data && (
        <div
          style={{
            position: "absolute",
            left: clamp(cursor.x + 14, 8, 1200),
            top: clamp(cursor.y + 14, 8, 1000),
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <MapTooltip
            feature={hovered}
            currency={data.currency}
            aggregationLevel={aggregationLevel}
            selectedMetric={metric}
            yoyMode={yoyMode}
          />
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 10,
        left: 10,
        zIndex: 4,
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
        background: tone === "error" ? "var(--error-100)" : "var(--ink-0)",
        color: tone === "error" ? "var(--error-700)" : "var(--ink-700)",
        border: `1px solid ${tone === "error" ? "var(--error-500)" : "var(--ink-300)"}`,
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: "0.74rem",
        boxShadow: "var(--shadow)",
      }}
    >
      {children}
    </div>
  );
}

function ZoomLevelIndicator({ level }: { level: AggregationLevel }) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 10,
        right: 10,
        zIndex: 4,
        background: "var(--ink-0)",
        border: "1px solid var(--ink-300)",
        padding: "5px 10px",
        borderRadius: 999,
        fontSize: "0.74rem",
        color: "var(--ink-700)",
        boxShadow: "var(--shadow)",
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
      }}
      title="Aggregation level auto-switches based on zoom"
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: "var(--brand-500)",
          display: "inline-block",
        }}
        aria-hidden
      />
      Zoom-level: <strong style={{ color: "var(--ink-900)" }}>{level}</strong>
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: "50%",
        border: "2px solid var(--ink-300)",
        borderTopColor: "var(--brand-500)",
        display: "inline-block",
        animation: "ee-spin 0.8s linear infinite",
      }}
    >
      <style>{`@keyframes ee-spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

function FallbackTable({
  data,
  isLoading,
  error,
  selected,
  onSelect,
}: {
  data: MapResponse | null | undefined;
  isLoading: boolean;
  error: unknown;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div style={{ padding: 12 }}>
      <div
        style={{
          background: "var(--warn-100)",
          border: "1px solid var(--warn-500)",
          color: "var(--warn-700)",
          padding: 8,
          borderRadius: 4,
          fontSize: "0.8rem",
          marginBottom: 10,
        }}
      >
        <strong>VITE_MAPBOX_TOKEN is not configured.</strong> Showing the same data as a
        table so the workflow stays usable.
      </div>
      {isLoading && <p>Loading map data…</p>}
      {error ? (
        <p style={{ color: "var(--error-700)" }}>
          Failed: {String((error as Error)?.message ?? error)}
        </p>
      ) : null}
      {data && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--ink-200)" }}>
              <th style={{ padding: "4px 8px" }}>Geography</th>
              <th style={{ padding: "4px 8px", textAlign: "right" }}>TIV</th>
              <th style={{ padding: "4px 8px", textAlign: "right" }}>Locations</th>
              <th style={{ padding: "4px 8px" }}>Geometry</th>
              <th style={{ padding: "4px 8px" }} />
            </tr>
          </thead>
          <tbody>
            {data.features.map((f) => {
              const isSel = f.geographyId === selected;
              return (
                <tr key={f.geographyId} style={{ background: isSel ? "var(--brand-100)" : undefined }}>
                  <td style={{ padding: "4px 8px" }}>{f.geographyName ?? f.geographyId}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {formatMoneyCompact(f.tiv, data.currency)}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right" }}>
                    {f.locationCount?.toLocaleString() ?? "—"}
                  </td>
                  <td style={{ padding: "4px 8px" }}>{f.hasGeometry ? "✓" : "missing"}</td>
                  <td style={{ padding: "4px 8px" }}>
                    <button onClick={() => onSelect(isSel ? null : f.geographyId)}>
                      {isSel ? "Selected" : "Open detail"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
