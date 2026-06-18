/**
 * App shell — map-dominant, resizable, with collapsible side panels.
 *
 *   ┌─ Header ─────────────────────────────────────────────────────────────┐
 *   │ CedentTree      ║   MapPanel (dominant)                 ║ DetailPane │
 *   │ (resizable +    ║   ────────────────────────────────────║ (resizable │
 *   │  collapsible)   ║   Map (fills)                         ║  + collaps │
 *   │                 ║   ────────────────────────────────────║   ible)    │
 *   │                 ║   Pivot (collapsible)                 ║            │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Selection model: pick a cedent / chain / programme in the rail. YoY auto-
 * pairs the latest year of a chain with its prior unless overridden via the
 * chain's "Compare vs" dropdown. Peril multi-select up top filters everything.
 */

import { lazy, Suspense, useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useCedents, useMapData } from "../../api/hooks";
import { useFiltersStore } from "../../state/filters";
import { useScopeFiltersStore } from "../../state/scopeFilters";
import { useSelectionStore } from "../../state/selection";
import { useViewStore } from "../../state/view";
import { useEffectiveScope } from "../../state/useEffectiveScope";
// Mapbox GL JS is ~1.8 MB minified — lazy-load so it stays off the critical path.
const MapView = lazy(() =>
  import("../Map/MapView").then((m) => ({ default: m.MapView })),
);
import { HurricaneControls } from "../Map/HurricaneControls";
import { MetricSelector } from "../Map/MetricSelector";
import { PerilSelector } from "../Map/PerilSelector";
import { YoyToggle } from "../Map/YoyToggle";
import { CedentTree } from "../CedentTree/CedentTree";
import { DetailPanel } from "../DetailPanel/DetailPanel";
import { ExportButton } from "../ExportButton/ExportButton";
import { Pivot } from "../Pivot/Pivot";
import { Header } from "./Header";
import { WarningsPanel } from "./WarningsPanel";
import type { MapRequest } from "../../api/types";

export function Shell() {
  const scope = useEffectiveScope();
  const comparisonProgrammeId = useSelectionStore((s) => s.comparisonProgrammeId);
  const aggregationLevel = useViewStore((s) => s.aggregationLevel);
  const metric = useViewStore((s) => s.metric);
  const yoyMode = useViewStore((s) => s.yoyMode);
  const perils = useViewStore((s) => s.perils);
  const filters = useFiltersStore();
  const [pivotOpen, setPivotOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  // Effective scope (selection ∪ scope-filter ∪ portfolio fallback) is
  // resolved by useEffectiveScope so every consumer (map, pivot, export,
  // hurricane impact) sees the SAME set of programmes.

  const mapRequest = useMemo<MapRequest | null>(() => {
    return {
      cedentId: scope.cedentId,
      chainId: scope.chainId,
      chainIds: scope.chainIds,
      programmeId: scope.programmeId,
      aggregationLevel,
      metric,
      filters: {
        peril: filters.peril,
        occupancy: filters.occupancy,
        distanceToCoast: filters.distanceToCoast,
        geocoding: filters.geocoding,
        construction: filters.construction,
        numberOfStories: filters.numberOfStories,
        yearBuilt: filters.yearBuilt,
      },
      comparisonProgrammeId,
      perils,
      yoyMode,
    };
  }, [
    scope.cedentId,
    scope.chainId,
    scope.programmeId,
    scope.chainIds,
    comparisonProgrammeId,
    aggregationLevel,
    metric,
    yoyMode,
    perils,
    filters.peril,
    filters.occupancy,
    filters.distanceToCoast,
    filters.geocoding,
    filters.construction,
    filters.numberOfStories,
    filters.yearBuilt,
  ]);

  const mapQuery = useMapData(mapRequest);
  const featureWarnings = mapQuery.data?.features.flatMap((f) => f.warnings) ?? [];
  const allWarnings = [...(mapQuery.data?.warnings ?? []), ...featureWarnings];
  const hasSelection = true; // portfolio mode is always a valid view

  const layoutKey = `ee-cols-${leftOpen ? "L" : "x"}-${rightOpen ? "R" : "x"}`;

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100vh" }}>
      <Header />
      <div style={{ display: "flex", minHeight: 0, minWidth: 0 }}>
        {!leftOpen && (
          <CollapsedSidebar side="left" onOpen={() => setLeftOpen(true)} label="Cedents" />
        )}

        <PanelGroup
          direction="horizontal"
          autoSaveId={layoutKey}
          style={{ flex: "1 1 0%", minWidth: 0, minHeight: 0 }}
        >
          {leftOpen && (
            <>
              <Panel
                id="left-rail"
                order={1}
                defaultSize={22}
                minSize={16}
                maxSize={38}
                style={{
                  background: "var(--ink-0)",
                  borderRight: "1px solid var(--ink-200)",
                  position: "relative",
                }}
              >
                <CedentTree />
                <CollapseTab side="right" onClick={() => setLeftOpen(false)} />
              </Panel>
              <ResizeGutter direction="vertical" />
            </>
          )}

          <Panel
            id="center"
            order={2}
            defaultSize={leftOpen && rightOpen ? 56 : 80}
            minSize={30}
          >
            <PanelGroup direction="vertical" autoSaveId={`${layoutKey}-rows`}>
              <Panel id="map-row" order={1} defaultSize={pivotOpen ? 65 : 100} minSize={30}>
                <section
                  style={{
                    display: "grid",
                    gridTemplateRows: "auto 1fr",
                    height: "100%",
                    background: "var(--ink-0)",
                  }}
                >
                  <MapToolbar />
                  <div style={{ position: "relative", minHeight: 0 }}>
                    {!hasSelection ? (
                      <EmptyState />
                    ) : (
                      <Suspense
                        fallback={
                          <div style={{ padding: 16, color: "var(--ink-500)" }}>
                            Loading map module…
                          </div>
                        }
                      >
                        <MapView
                          data={mapQuery.data}
                          isLoading={mapQuery.isLoading}
                          error={mapQuery.error}
                        />
                      </Suspense>
                    )}
                  </div>
                </section>
              </Panel>

              {pivotOpen ? (
                <>
                  <ResizeGutter direction="horizontal" />
                  <Panel id="pivot-row" order={2} defaultSize={35} minSize={18} collapsible>
                    <section
                      style={{
                        display: "grid",
                        gridTemplateRows: "auto 1fr",
                        height: "100%",
                        background: "var(--ink-0)",
                        borderTop: "1px solid var(--ink-200)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 14px",
                          borderBottom: "1px solid var(--ink-200)",
                          background: "var(--ink-50)",
                        }}
                      >
                        <h3
                          style={{
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            color: "var(--ink-600)",
                          }}
                        >
                          Pivot workbench
                        </h3>
                        <button
                          className="ghost"
                          onClick={() => setPivotOpen(false)}
                          aria-label="Hide pivot"
                          style={{ fontSize: "0.72rem" }}
                        >
                          Hide ▾
                        </button>
                      </div>
                      <div style={{ height: "100%", overflow: "auto", padding: 12 }}>
                        <Pivot />
                      </div>
                    </section>
                  </Panel>
                </>
              ) : (
                <PivotHandle onOpen={() => setPivotOpen(true)} />
              )}
            </PanelGroup>
          </Panel>

          {rightOpen && (
            <>
              <ResizeGutter direction="vertical" />
              <Panel
                id="right-rail"
                order={3}
                defaultSize={22}
                minSize={16}
                maxSize={38}
                style={{
                  background: "var(--ink-50)",
                  borderLeft: "1px solid var(--ink-200)",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    overflow: "auto",
                    padding: 12,
                    display: "grid",
                    gap: 12,
                    alignContent: "start",
                  }}
                >
                  <Card>
                    <SectionTitle>Detail</SectionTitle>
                    <DetailPanel />
                  </Card>
                  <Card>
                    <SectionTitle>Warnings</SectionTitle>
                    <WarningsPanel warnings={allWarnings} />
                  </Card>
                </div>
                <CollapseTab side="left" onClick={() => setRightOpen(false)} />
              </Panel>
            </>
          )}
        </PanelGroup>

        {!rightOpen && (
          <CollapsedSidebar side="right" onOpen={() => setRightOpen(true)} label="Detail" />
        )}
      </div>
    </div>
  );
}

/**
 * Tiny chip showing what scope the map is currently rendering: explicit deal
 * selection (cedent / chain / programme name) or the in-force portfolio
 * aggregate when nothing is selected. Lets the user know they're looking at
 * everything in-force vs a single deal.
 */
function PortfolioScopeBadge() {
  const sel = useSelectionStore();
  const scope = useScopeFiltersStore();
  const { data } = useCedents();
  const scopeBits = [
    scope.offices.length ? `${scope.offices.length} office${scope.offices.length === 1 ? "" : "s"}` : null,
    scope.regions.length ? `${scope.regions.length} region${scope.regions.length === 1 ? "" : "s"}` : null,
    scope.underwriters.length ? `${scope.underwriters.length} UW` : null,
  ].filter(Boolean);
  let label = scopeBits.length > 0 ? `Filtered scope · ${scopeBits.join(" · ")}` : "Portfolio · in-force";
  let isExplicit = false;
  if (sel.programmeId) {
    const prog = data?.cedents
      .flatMap((c) => c.chains.flatMap((ch) => ch.programmes))
      .find((p) => p.programmeId === sel.programmeId);
    label = prog ? `${prog.programmeName}` : sel.programmeId;
    isExplicit = true;
  } else if (sel.chainId) {
    const chain = data?.cedents
      .flatMap((c) => c.chains)
      .find((ch) => ch.chainId === sel.chainId);
    label = chain ? `${chain.chainName}` : sel.chainId;
    isExplicit = true;
  } else if (sel.officeKey) {
    const cedent = data?.cedents.find((c) => c.cedentId === sel.officeKey!.cedentId);
    label = cedent
      ? `${cedent.cedentName} · ${sel.officeKey.office}`
      : sel.officeKey.office;
    isExplicit = true;
  } else if (sel.cedentId) {
    const cedent = data?.cedents.find((c) => c.cedentId === sel.cedentId);
    label = cedent?.cedentName ?? sel.cedentId;
    isExplicit = true;
  }
  return (
    <span
      title={isExplicit ? "Active selection — click 'Clear' to return to portfolio" : "Showing every currently-in-force bound programme"}
      style={{
        fontSize: "0.66rem",
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: isExplicit ? "var(--brand-700)" : "var(--ink-700)",
        background: isExplicit ? "var(--brand-50)" : "#f3f4f6",
        border: `1px solid ${isExplicit ? "var(--brand-400)" : "#d1d5db"}`,
        padding: "2px 8px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {isExplicit ? null : (
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981" }} />
      )}
      {label}
    </span>
  );
}

function MapToolbar() {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 14px",
        borderBottom: "1px solid var(--ink-200)",
        background: "var(--ink-50)",
        gap: 10,
        rowGap: 6,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", rowGap: 6 }}>
        <h2 style={{ fontSize: "0.85rem", fontWeight: 600 }}>Exposure map</h2>
        <PortfolioScopeBadge />
        <PerilSelector />
        <HurricaneControls />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", rowGap: 6 }}>
        <MetricSelector />
        <YoyToggle />
        <ExportButton />
      </div>
    </div>
  );
}

function PivotHandle({ onOpen }: { onOpen: () => void }) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--ink-200)",
        background: "var(--ink-50)",
        padding: "4px 14px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--ink-500)",
          fontWeight: 700,
        }}
      >
        Pivot workbench (hidden)
      </span>
      <button className="ghost" onClick={onOpen} style={{ fontSize: "0.72rem" }}>
        Show ▴
      </button>
    </div>
  );
}

function CollapsedSidebar({
  side,
  onOpen,
  label,
}: {
  side: "left" | "right";
  onOpen: () => void;
  label: string;
}) {
  return (
    <div
      style={{
        width: 26,
        background: "var(--ink-100)",
        borderLeft: side === "right" ? "1px solid var(--ink-200)" : undefined,
        borderRight: side === "left" ? "1px solid var(--ink-200)" : undefined,
        display: "grid",
        placeItems: "center",
      }}
    >
      <button
        onClick={onOpen}
        title={`Show ${label}`}
        aria-label={`Show ${label}`}
        style={{
          all: "unset",
          cursor: "pointer",
          padding: "12px 4px",
          color: "var(--ink-700)",
          fontSize: "0.72rem",
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          writingMode: "vertical-rl",
          textOrientation: "mixed",
          transform: side === "left" ? "rotate(180deg)" : undefined,
        }}
      >
        {side === "left" ? "▶ " : "◀ "}
        {label}
      </button>
    </div>
  );
}

function CollapseTab({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const style: React.CSSProperties = {
    position: "absolute",
    top: 12,
    zIndex: 3,
    background: "var(--ink-0)",
    border: "1px solid var(--ink-300)",
    borderRadius: 999,
    width: 22,
    height: 22,
    display: "grid",
    placeItems: "center",
    color: "var(--ink-700)",
    fontSize: "0.7rem",
    padding: 0,
    boxShadow: "var(--shadow-sm)",
  };
  if (side === "right") style.right = 6;
  else style.left = 6;
  return (
    <button onClick={onClick} title="Hide panel" aria-label="Hide panel" style={style}>
      {side === "right" ? "◀" : "▶"}
    </button>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section
      style={{
        background: "var(--ink-0)",
        border: "1px solid var(--ink-200)",
        borderRadius: "var(--radius)",
        padding: 12,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      {children}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: "0.68rem",
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--ink-500)",
        marginBottom: 8,
      }}
    >
      {children}
    </h3>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        textAlign: "center",
        height: "100%",
        padding: 20,
        color: "var(--ink-500)",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          background: "var(--brand-100)",
          color: "var(--brand-700)",
          display: "grid",
          placeItems: "center",
          marginBottom: 14,
          fontSize: 26,
        }}
        aria-hidden
      >
        ⌖
      </div>
      <div
        style={{
          fontWeight: 600,
          color: "var(--ink-700)",
          marginBottom: 4,
          fontSize: "0.95rem",
        }}
      >
        Pick a cedent, chain, or programme
      </div>
      <div style={{ fontSize: "0.85rem", maxWidth: 360 }}>
        Use the left rail. Clicking a <strong>cedent</strong> unions all its chains;
        a <strong>chain</strong> auto-compares latest vs prior; a <strong>programme</strong>
        is the most granular view. The peril selector above filters everything.
      </div>
    </div>
  );
}

function ResizeGutter({ direction }: { direction: "vertical" | "horizontal" }) {
  return (
    <PanelResizeHandle
      style={{
        background: "var(--ink-200)",
        width: direction === "vertical" ? 4 : "100%",
        height: direction === "horizontal" ? 4 : "100%",
        cursor: direction === "vertical" ? "col-resize" : "row-resize",
        flexShrink: 0,
        transition: "background 80ms",
      }}
    />
  );
}
