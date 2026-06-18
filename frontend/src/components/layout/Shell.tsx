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
import { useSelectionStore } from "../../state/selection";
import { useViewStore } from "../../state/view";
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
  const cedentId = useSelectionStore((s) => s.cedentId);
  const officeKey = useSelectionStore((s) => s.officeKey);
  const chainId = useSelectionStore((s) => s.chainId);
  const programmeId = useSelectionStore((s) => s.programmeId);
  const comparisonProgrammeId = useSelectionStore((s) => s.comparisonProgrammeId);
  const cedentsQuery = useCedents();
  const aggregationLevel = useViewStore((s) => s.aggregationLevel);
  const metric = useViewStore((s) => s.metric);
  const yoyMode = useViewStore((s) => s.yoyMode);
  const perils = useViewStore((s) => s.perils);
  const filters = useFiltersStore();
  const [pivotOpen, setPivotOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  // Resolve office selection → chainIds (the cedent tree knows which chains
  // belong to that office).
  const officeChainIds = useMemo<string[]>(() => {
    if (!officeKey || !cedentsQuery.data) return [];
    const cedent = cedentsQuery.data.cedents.find((c) => c.cedentId === officeKey.cedentId);
    if (!cedent) return [];
    return cedent.chains.filter((ch) => ch.office === officeKey.office).map((ch) => ch.chainId);
  }, [officeKey, cedentsQuery.data]);

  const mapRequest = useMemo<MapRequest | null>(() => {
    if (!cedentId && !chainId && !programmeId && officeChainIds.length === 0) return null;
    return {
      cedentId,
      chainId,
      chainIds: officeChainIds.length > 0 ? officeChainIds : undefined,
      programmeId,
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
    cedentId,
    chainId,
    programmeId,
    officeChainIds,
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
  const hasSelection = Boolean(mapRequest);

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
