/**
 * Fund Analysis page — Markowitz efficient frontier + interactive
 * portfolio builder across the 7 live-manager funds + SPY + AGG.
 *
 * Sections:
 *   1. Asset picker (with strategy chips + warnings)
 *   2. Portfolio inputs (capital, RF rate, min-investment toggle, run btn)
 *   3. Assumption overrides (μ / σ / ρ-cap per asset)
 *   4. Max-weight constraints (concentration caps)
 *   5. Efficient frontier chart
 *   6. Growth of $1 chart (all assets, log scale)
 *   7. Drawdown chart (all assets)
 *   8. Optimal-portfolio cards: Max Sharpe / Max Sortino / Min Var / Min DD
 *   9. Interactive Portfolio Builder — weight sliders + live stats
 *  10. Correlation heatmap
 *  11. Stats table (empirical vs assumed side-by-side)
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  fetchFundAssets,
  fetchRollingStats,
  optimizePortfolio,
  rescoreIr,
  runRobustnessScan,
  scoreCustomPortfolio,
  type AssetSeries,
  type AssumptionOverrideIn,
  type CustomPortfolioResponse,
  type FundAsset,
  type MaxWeightIn,
  type OptimizeResponse,
  type PortfolioPoint,
  type RobustnessResponse,
  type RollingStatsResponse,
} from "../api/fundAnalysis";
import { BRAND } from "../brand";
import { BrandMark } from "../components/layout/BrandMark";

// Sensible priors for short-history / illiquid assets.
const DEFAULT_OVERRIDES: Record<string, AssumptionOverrideIn> = {
  primary_commodity: {
    assetId: "primary_commodity",
    annualisedReturn: 0.15,
    annualisedVol: 0.28,
    correlationCap: 0.3,
  },
};

// No default concentration caps — user can set them per-asset in the
// Concentration Caps card if they want to limit exposure to high-vol
// funds like CAS Sosin.
const DEFAULT_MAX_WEIGHTS: MaxWeightIn[] = [];

// Per-fund default IR benchmarks drawn from each fund's own PDF:
//   Upslope     → HFRX Equity Hedge (Appendix A explicitly benchmarks
//                  the strategy against HFRX EH)
//   Alluvial    → Russell MicroCap TR (their factsheet's benchmark)
//   Cedar Creek → Russell 2000 (they compare AAR against Russell 2000
//                  in their appendix — 8.2% vs their 14.8%)
//   CAS Sosin   → S&P 500 (Sosin's stated objective is to beat SPY)
//   Bireme      → S&P 500 (their factsheet uses SPY)
//   Gator       → S&P 500 (they compare monthly attribution to SPY and
//                  S&P 1500 Financials; SPY is our closest proxy)
//   Primary     → S&P 500 (physical rare-earth funds have no natural
//                  index benchmark; SPY as the default "opportunity
//                  cost of capital" is reasonable)
const DEFAULT_PER_ASSET_BENCHMARKS: Record<string, string> = {
  upslope: "hfrx_eh",
  alluvial: "rmc",
  cedar_creek: "r2k",
  cas_sosin: "spy",
  bireme: "spy",
  gator: "spy",
  primary_commodity: "spy",
  // Contrarius is long-only global equity; MSCI World would be the true
  // benchmark but we don't ship it. SPY is the closest global-equity
  // proxy available in the catalog.
  // Global long-only funds → MSCI World is the natural benchmark
  contrarius: "msci_world",
  orbis_equity: "msci_world",
  // Multi-asset balanced fund → use the multi-strategy hedge fund index
  orbis_balanced: "hfrx_global",
  // Blue Outlier tear sheet benches vs SPY and IWM (Russell 2000);
  // IWM is the closer style match (small/mid value + options overlay).
  blue_outlier: "r2k",
  // ADAR1 deck benches vs S&P 500 TR and XBI; SPY is the closest
  // index we carry (XBI is not in the catalog).
  adar1: "spy",
};

const CURRENCY = (v: number) =>
  v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const PCT = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

const KIND_TINT: Record<string, string> = { hedge_fund: "#3b82f6", reference: "#94a3b8" };

// Distinct colours for the multi-line growth-of-$1 + drawdown charts.
const ASSET_COLOR: Record<string, string> = {
  gator: "#059669",
  bireme: "#7c3aed",
  upslope: "#0891b2",
  primary_commodity: "#ca8a04",
  cedar_creek: "#dc2626",
  cas_sosin: "#db2777",
  alluvial: "#2563eb",
  contrarius: "#0f766e",
  orbis_equity: "#9333ea",
  orbis_balanced: "#c026d3",
  blue_outlier: "#0369a1",
  adar1: "#0d9488",
  spy: "#64748b",
  agg: "#a3a3a3",
};

const SHORT_NAME: Record<string, string> = {
  gator: "Gator",
  bireme: "Bireme",
  upslope: "Upslope",
  primary_commodity: "Primary",
  cedar_creek: "Cedar Creek",
  cas_sosin: "CAS Sosin",
  alluvial: "Alluvial",
  contrarius: "Contrarius",
  orbis_equity: "Orbis Equity",
  orbis_balanced: "Orbis Balanced",
  blue_outlier: "Blue Outlier",
  adar1: "ADAR1",
  spy: "S&P 500",
  agg: "US Bonds",
};

export function FundAnalysis() {
  // Default: live managers + SPY + AGG. HFRX / R2K / RMC / MDY are
  // available in the catalog + benchmark dropdown but unchecked so the
  // asset picker stays readable.
  const [selected, setSelected] = useState<Set<string>>(
    new Set([
      "gator", "bireme", "upslope", "primary_commodity", "cedar_creek",
      "cas_sosin", "alluvial", "contrarius", "orbis_equity", "orbis_balanced",
      "blue_outlier", "adar1",
      "spy", "agg",
    ]),
  );
  const [newCapital, setNewCapital] = useState<number>(1_000_000);
  const [currentInvestments, setCurrentInvestments] = useState<Record<string, number>>({});
  const [noSell, setNoSell] = useState<boolean>(false);
  // Default: only allocate NEW capital; leave current holdings fixed (personal use).
  const [allocateNewOnly, setAllocateNewOnly] = useState<boolean>(true);
  const [netOfFees, setNetOfFees] = useState<boolean>(true);
  const [historyWindow, setHistoryWindow] = useState<string | null>(null);   // null = all
  const [customWindowMonth, setCustomWindowMonth] = useState<string>("2019-01");
  const [benchmarkAssetId, setBenchmarkAssetId] = useState<string>("spy");
  const [perAssetBenchmarks, setPerAssetBenchmarks] = useState<Record<string, string>>(
    { ...DEFAULT_PER_ASSET_BENCHMARKS },
  );
  const [riskFreeRate, setRiskFreeRate] = useState<number>(0.04);
  const [respectMin, setRespectMin] = useState<boolean>(true);
  const [overrides, setOverrides] = useState<Record<string, AssumptionOverrideIn>>(DEFAULT_OVERRIDES);
  const [maxWeights, setMaxWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(DEFAULT_MAX_WEIGHTS.map((m) => [m.assetId, m.maxWeight])),
  );
  const [minInvOverrides, setMinInvOverrides] = useState<Record<string, number>>({});

  const currentTotal = Object.values(currentInvestments).reduce((a, b) => a + b, 0);
  const totalCapital = currentTotal + newCapital;
  const historyWindowStart =
    historyWindow === "custom" ? customWindowMonth : historyWindow;

  const assetsQuery = useQuery({
    queryKey: ["fund-analysis", "assets"],
    queryFn: fetchFundAssets,
    staleTime: Infinity,
  });

  const optimizeMutation = useMutation({ mutationFn: optimizePortfolio });
  const robustnessMutation = useMutation({ mutationFn: runRobustnessScan });

  const runRobustness = () => {
    robustnessMutation.mutate({
      assetIds: [...selected],
      currentInvestments: Object.entries(currentInvestments)
        .filter(([id, amt]) => selected.has(id) && amt > 0)
        .map(([assetId, amount]) => ({ assetId, amount })),
      respectMinInvestment: respectMin,
      noSell,
      allocateNewCapitalOnly: allocateNewOnly,
      netOfFees,
      overrides: Object.values(overrides).filter((o) => selected.has(o.assetId)),
      maxWeights: Object.entries(maxWeights)
        .filter(([id]) => selected.has(id))
        .map(([assetId, maxWeight]) => ({ assetId, maxWeight })),
      minInvestmentOverrides: Object.entries(minInvOverrides)
        .filter(([id]) => selected.has(id))
        .map(([assetId, minInvestment]) => ({ assetId, minInvestment })),
      newCapital,
      samplesPerScenario: 6000,
    });
  };

  const runOptimize = () => {
    optimizeMutation.mutate({
      assetIds: [...selected],
      newCapital,
      currentInvestments: Object.entries(currentInvestments)
        .filter(([id, amt]) => selected.has(id) && amt > 0)
        .map(([assetId, amount]) => ({ assetId, amount })),
      noSell,
      allocateNewCapitalOnly: allocateNewOnly,
      netOfFees,
      historyWindowStart,
      benchmarkAssetId,
      perAssetBenchmarks: Object.entries(perAssetBenchmarks)
        .filter(([id]) => selected.has(id))
        .map(([assetId, benchmarkAssetId]) => ({ assetId, benchmarkAssetId })),
      riskFreeRate,
      respectMinInvestment: respectMin,
      overrides: Object.values(overrides).filter((o) => selected.has(o.assetId)),
      maxWeights: Object.entries(maxWeights)
        .filter(([id]) => selected.has(id))
        .map(([assetId, maxWeight]) => ({ assetId, maxWeight })),
      minInvestmentOverrides: Object.entries(minInvOverrides)
        .filter(([id]) => selected.has(id))
        .map(([assetId, minInvestment]) => ({ assetId, minInvestment })),
      samples: 30_000,
    });
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const setOverride = (id: string, patch: Partial<AssumptionOverrideIn>) => {
    setOverrides((prev) => {
      const cur = prev[id] ?? { assetId: id };
      const merged = { ...cur, ...patch };
      const empty =
        merged.annualisedReturn == null &&
        merged.annualisedVol == null &&
        merged.correlationCap == null;
      const next = { ...prev };
      if (empty) delete next[id];
      else next[id] = merged;
      return next;
    });
  };

  const setMaxWeight = (id: string, val: number | null) => {
    setMaxWeights((prev) => {
      const next = { ...prev };
      if (val == null) delete next[id];
      else next[id] = val;
      return next;
    });
  };

  const setMinInv = (id: string, val: number | null) => {
    setMinInvOverrides((prev) => {
      const next = { ...prev };
      if (val == null) delete next[id];
      else next[id] = val;
      return next;
    });
  };

  const setCurrentInv = (id: string, val: number) => {
    setCurrentInvestments((prev) => {
      const next = { ...prev };
      if (val <= 0) delete next[id];
      else next[id] = val;
      return next;
    });
  };

  const effectiveMinInv = (a: FundAsset) => minInvOverrides[a.id] ?? a.minInvestment;

  const assets = assetsQuery.data?.assets ?? [];
  const assetById = useMemo(() => {
    const m: Record<string, FundAsset> = {};
    for (const a of assets) m[a.id] = a;
    return m;
  }, [assets]);

  const result = optimizeMutation.data;

  return (
    <div style={S.page}>
      <Header asOf={assetsQuery.data?.asOf} />

      <div style={S.grid}>
        <section style={S.card}>
          <h2 style={S.h2}>Assets</h2>
          <p style={S.hint}>{assetsQuery.data?.note}</p>
          <table style={S.table}>
            <thead>
              <tr>
                <th />
                <th style={S.th}>Fund</th>
                <th style={S.thNum}>CAGR</th>
                <th style={S.thNum}>σ (ann)</th>
                <th style={S.thNum}>Months</th>
                <th style={S.thNum}>Currently held ($)</th>
                <th style={S.thNum}>Min Investment (editable)</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const eff = effectiveMinInv(a);
                const overridden = minInvOverrides[a.id] !== undefined && minInvOverrides[a.id] !== a.minInvestment;
                return (
                  <tr key={a.id} style={selected.has(a.id) ? S.rowOn : S.rowOff}>
                    <td>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
                    </td>
                    <td style={S.td}>
                      <div style={{ fontWeight: 600, fontSize: "0.85rem", color: ASSET_COLOR[a.id] }}>
                        {a.name}
                      </div>
                      <div style={S.chipRow}>
                        <span style={{ ...S.chip, background: KIND_TINT[a.kind] }}>
                          {a.kind === "hedge_fund" ? "Hedge Fund" : "Reference"}
                        </span>
                        <span style={S.chipMuted}>{a.strategy}</span>
                      </div>
                      {a.warning && <div style={S.warn}>{a.warning}</div>}
                      {a.docs && a.docs.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                          {a.docs.map((d) => (
                            <a
                              key={d.url}
                              href={d.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                fontSize: "0.72rem",
                                fontWeight: 600,
                                color: "var(--brand-700)",
                                textDecoration: "none",
                              }}
                            >
                              {d.label} ↗
                            </a>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={S.tdNum}>{PCT(a.annualisedReturn)}</td>
                    <td style={S.tdNum}>{PCT(a.annualisedVol)}</td>
                    <td style={S.tdNum}>{a.nMonths}</td>
                    <td style={S.tdNum}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        <DollarInput
                          value={currentInvestments[a.id] ?? 0}
                          onChange={(v) => setCurrentInv(a.id, v)}
                          highlight={(currentInvestments[a.id] ?? 0) > 0 ? "#dbeafe" : undefined}
                          title={(currentInvestments[a.id] ?? 0) > 0
                            ? `Currently invested — will be a floor if "no-sell" is on`
                            : "Enter your current position, if any"}
                        />
                        {(currentInvestments[a.id] ?? 0) > 0 && noSell && totalCapital > 0 && (
                          <span style={S.floorHint}>
                            → hard floor {PCT((currentInvestments[a.id]!) / totalCapital, 2)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={S.tdNum}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <DollarInput
                            value={eff}
                            onChange={(v) => setMinInv(a.id, v)}
                            highlight={overridden ? "#fef3c7" : undefined}
                            title={overridden ? `Overridden from PDF default ${CURRENCY(a.minInvestment)}` : "PDF default"}
                          />
                          {overridden && (
                            <button
                              type="button"
                              onClick={() => setMinInv(a.id, null)}
                              title="Reset to PDF default"
                              style={{ all: "unset", cursor: "pointer", color: "#64748b", fontSize: "0.8rem" }}
                            >
                              ↺
                            </button>
                          )}
                        </div>
                        {respectMin && eff > 0 && totalCapital > 0 && (
                          <span style={S.floorHint}>
                            → soft floor {PCT(eff / totalCapital, 2)}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section style={S.cardTall}>
          <h2 style={S.h2}>Portfolio inputs</h2>

          <div style={S.summaryBox}>
            <div style={S.summaryRow}>
              <span>Currently invested</span>
              <span style={S.summaryVal}>{CURRENCY(currentTotal)}</span>
            </div>
            <div style={S.summaryRow}>
              <span>New capital to deploy</span>
              <span style={S.summaryVal}>{CURRENCY(newCapital)}</span>
            </div>
            <div style={{ ...S.summaryRow, borderTop: "1px solid #cbd5e1", paddingTop: 4, marginTop: 4, fontWeight: 600 }}>
              <span>Total portfolio</span>
              <span style={S.summaryVal}>{CURRENCY(totalCapital)}</span>
            </div>
          </div>

          <label style={S.label}>
            New capital to deploy ($)
            <DollarInput
              value={newCapital}
              onChange={(v) => setNewCapital(v)}
              width={220}
            />
            <span style={S.hint}>Set per-fund current holdings in the Assets table above.</span>
          </label>

          <label style={S.labelRow}>
            <input
              type="checkbox"
              checked={allocateNewOnly}
              onChange={(e) => setAllocateNewOnly(e.target.checked)}
            />
            Allocate new capital only (keep current holdings fixed)
          </label>
          <p style={S.hint}>
            Default on for personal use: optimizer only deploys <em>new</em> dollars; existing
            balances stay put. Turn off to rebalance the full book (current + new).
          </p>

          <label style={S.labelRow}>
            <input
              type="checkbox"
              checked={noSell}
              onChange={(e) => setNoSell(e.target.checked)}
              disabled={allocateNewOnly}
            />
            Don't reduce existing positions (add-only floors)
          </label>
          <p style={S.hint}>
            {allocateNewOnly
              ? "Implied when “new capital only” is on."
              : "If on, current holdings are floors — can add but not sell."}
          </p>

          <label style={S.labelRow}>
            <input type="checkbox" checked={netOfFees} onChange={(e) => setNetOfFees(e.target.checked)} />
            Net of management fees (haircut expected returns)
          </label>
          <p style={S.hint}>
            Applies the listed mgmt fee as an annual drag on expected return. Perf fees are not
            modeled (path-dependent).
          </p>

          <label style={S.label}>
            History window
            <select
              value={historyWindow ?? ""}
              onChange={(e) => setHistoryWindow(e.target.value === "" ? null : e.target.value)}
              style={S.input}
            >
              <option value="">All available history</option>
              <option value="2021-01">Since Jan 2021 (last ~5y)</option>
              <option value="2019-01">Since Jan 2019 (last ~7y)</option>
              <option value="2016-01">Since Jan 2016 (last ~10y)</option>
              <option value="custom">Custom start month…</option>
            </select>
            {historyWindow === "custom" && (
              <input
                type="month"
                value={customWindowMonth}
                onChange={(e) => setCustomWindowMonth(e.target.value)}
                style={{ ...S.input, marginTop: 4 }}
              />
            )}
            <span style={S.hint}>
              Filters monthly returns to this window. Useful to see how a fund's stats look in the
              current regime (e.g. Gator post-2020, when its Sharpe rose from 0.69 to 0.87).
            </span>
          </label>

          <label style={S.label}>
            IR benchmark
            <select
              value={benchmarkAssetId}
              onChange={(e) => setBenchmarkAssetId(e.target.value)}
              style={S.input}
            >
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <span style={S.hint}>
              What the Information Ratio measures active return against. Default S&amp;P 500 for
              "am I beating the market" — switch to AGG for "am I beating bonds," or to any
              individual fund for pair-wise comparison (e.g. Upslope's IR vs. Cedar Creek).
            </span>
          </label>

          <label style={S.label}>
            Risk-free rate (annual)
            <input
              type="number"
              value={(riskFreeRate * 100).toFixed(1)}
              step={0.25}
              min={0}
              max={15}
              onChange={(e) => setRiskFreeRate(Math.max(0, Number(e.target.value) || 0) / 100)}
              style={S.input}
            />
            <span style={S.hint}>{PCT(riskFreeRate)} — used for Sharpe / Sortino</span>
          </label>

          <label style={S.labelRow}>
            <input type="checkbox" checked={respectMin} onChange={(e) => setRespectMin(e.target.checked)} />
            Respect fund minimum investments
          </label>

          <button
            type="button"
            onClick={runOptimize}
            disabled={selected.size < 2 || optimizeMutation.isPending}
            style={S.primaryBtn}
          >
            {optimizeMutation.isPending ? "Optimising…" : `Run optimizer (${selected.size} assets)`}
          </button>
          {selected.size < 2 && <p style={S.warn}>Pick at least 2 assets to run the optimizer.</p>}
        </section>

        <section style={S.card}>
          <h2 style={S.h2}>Assumption overrides</h2>
          <p style={S.hint}>
            Set assumed values to override empirical estimates — critical for short track records
            (Primary Commodity) or extreme-vol funds (CAS Sosin). Correlation cap limits |ρ| between
            this asset and any other.
          </p>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Asset</th>
                <th style={S.thNum}>Assumed μ (ann)</th>
                <th style={S.thNum}>Assumed σ (ann)</th>
                <th style={S.thNum}>ρ cap</th>
              </tr>
            </thead>
            <tbody>
              {assets.filter((a) => selected.has(a.id)).map((a) => {
                const o = overrides[a.id];
                return (
                  <tr key={a.id}>
                    <td style={S.td}>{a.name}</td>
                    <td style={S.tdNum}>
                      <PercentInput
                        value={o?.annualisedReturn ?? null}
                        placeholder={PCT(a.annualisedReturn)}
                        onChange={(v) => setOverride(a.id, { annualisedReturn: v })}
                      />
                    </td>
                    <td style={S.tdNum}>
                      <PercentInput
                        value={o?.annualisedVol ?? null}
                        placeholder={PCT(a.annualisedVol)}
                        onChange={(v) => setOverride(a.id, { annualisedVol: v })}
                      />
                    </td>
                    <td style={S.tdNum}>
                      <PercentInput
                        value={o?.correlationCap ?? null}
                        placeholder="—"
                        onChange={(v) => setOverride(a.id, { correlationCap: v })}
                        max={1}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section style={S.card}>
          <h2 style={S.h2}>Concentration caps</h2>
          <p style={S.hint}>
            Hard ceiling on any one asset's weight. Useful to prevent the optimizer from over-allocating
            to volatile funds (default: CAS Sosin capped at 20%).
          </p>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Asset</th>
                <th style={S.thNum}>Max weight</th>
              </tr>
            </thead>
            <tbody>
              {assets.filter((a) => selected.has(a.id)).map((a) => (
                <tr key={a.id}>
                  <td style={S.td}>{a.name}</td>
                  <td style={S.tdNum}>
                    <PercentInput
                      value={maxWeights[a.id] ?? null}
                      placeholder="none"
                      onChange={(v) => setMaxWeight(a.id, v)}
                      max={1}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {result && (
        <ResultView
          result={result}
          assetById={assetById}
          assets={assets}
          riskFreeRate={riskFreeRate}
          respectMin={respectMin}
          overrides={overrides}
          minInvOverrides={minInvOverrides}
          historyWindowStart={historyWindowStart}
          perAssetBenchmarks={perAssetBenchmarks}
          setPerAssetBenchmark={(id, bid) =>
            setPerAssetBenchmarks((prev) => ({ ...prev, [id]: bid }))
          }
          robustness={robustnessMutation.data}
          onRunRobustness={runRobustness}
          isRobustnessRunning={robustnessMutation.isPending}
        />
      )}
      {optimizeMutation.isError && (
        <div style={S.err}>{(optimizeMutation.error as Error).message}</div>
      )}
    </div>
  );
}

function Header({ asOf }: { asOf: string | undefined }) {
  return (
    <header style={S.header}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <a href="/" aria-label={BRAND.name}><BrandMark size={32} /></a>
        <div>
        <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
          <a href="/" style={{ color: "#1e40af", textDecoration: "none" }}>← Back to {BRAND.name}</a>
        </div>
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>Fund Portfolio Optimizer</h1>
        <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: "0.8rem" }}>
          Markowitz efficient frontier + interactive builder across live hedge funds + S&P 500 + US Aggregate Bonds.
          {asOf && <> · Data as of <b>{asOf}</b>.</>}
        </p>
        </div>
      </div>
    </header>
  );
}

function PercentInput({
  value,
  placeholder,
  onChange,
  max,
}: {
  value: number | null;
  placeholder: string;
  onChange: (v: number | null) => void;
  max?: number;
}) {
  const shown = value == null ? "" : (value * 100).toFixed(1);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <input
        type="number"
        value={shown}
        placeholder={placeholder}
        step={0.5}
        min={-100}
        max={max ? max * 100 : 500}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") onChange(null);
          else onChange(Number(raw) / 100);
        }}
        style={{ ...S.input, width: 75, textAlign: "right" }}
      />
      <span style={{ fontSize: "0.7rem", color: "#64748b" }}>%</span>
    </div>
  );
}

/**
 * Dollar amount input — displays with thousands separators, accepts
 * digits (and optional commas which get stripped). Anything non-numeric
 * is discarded. Empty string = 0.
 *
 * Uses a local text-state so the user can freely edit without the value
 * jumping mid-keystroke.
 */
function DollarInput({
  value,
  onChange,
  width = 130,
  highlight,
  title,
  placeholder,
}: {
  value: number;
  onChange: (v: number) => void;
  width?: number;
  highlight?: string;
  title?: string;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const display = focused
    ? draft
    : value > 0
      ? value.toLocaleString("en-US")
      : "";
  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      placeholder={placeholder ?? "0"}
      onFocus={() => {
        setDraft(value > 0 ? String(value) : "");
        setFocused(true);
      }}
      onChange={(e) => {
        // While focused we let anything through but only feed digits to
        // the parent — this keeps typing 1000000 fluid.
        const stripped = e.target.value.replace(/[^0-9]/g, "");
        setDraft(stripped);
        onChange(stripped === "" ? 0 : Number(stripped));
      }}
      onBlur={() => setFocused(false)}
      style={{ ...S.input, width, textAlign: "right", background: highlight, fontVariantNumeric: "tabular-nums" }}
      title={title}
    />
  );
}

function ResultView({
  result,
  assetById,
  assets,
  riskFreeRate,
  respectMin,
  overrides,
  minInvOverrides,
  historyWindowStart,
  perAssetBenchmarks,
  setPerAssetBenchmark,
  robustness,
  onRunRobustness,
  isRobustnessRunning,
}: {
  result: OptimizeResponse;
  assetById: Record<string, FundAsset>;
  assets: FundAsset[];
  riskFreeRate: number;
  respectMin: boolean;
  overrides: Record<string, AssumptionOverrideIn>;
  minInvOverrides: Record<string, number>;
  historyWindowStart: string | null;
  perAssetBenchmarks: Record<string, string>;
  setPerAssetBenchmark: (assetId: string, benchmarkAssetId: string) => void;
  robustness: RobustnessResponse | undefined;
  onRunRobustness: () => void;
  isRobustnessRunning: boolean;
}) {
  const capital = result.totalCapital;
  const hasCurrent = result.currentTotal > 0;

  // Live per-asset IR — seeded from the last optimize response, then
  // updated on-the-fly via /rescore-ir whenever the user changes a
  // benchmark dropdown. Keyed by assetId so unaffected rows persist.
  type IrRow = { informationRatio: number; trackingError: number; benchmarkAssetId: string; benchmarkName: string };
  const [liveIr, setLiveIr] = useState<Record<string, IrRow>>(() => {
    const m: Record<string, IrRow> = {};
    for (const s of result.stats) {
      m[s.assetId] = {
        informationRatio: s.informationRatio,
        trackingError: s.trackingError,
        benchmarkAssetId: s.benchmarkAssetId,
        benchmarkName: s.benchmarkName,
      };
    }
    return m;
  });
  const [pendingIr, setPendingIr] = useState(false);

  // Whenever the user's per-asset benchmark map changes, debounce-refetch.
  useEffect(() => {
    const t = setTimeout(() => {
      setPendingIr(true);
      rescoreIr({
        assetIds: result.stats.map((s) => s.assetId),
        perAssetBenchmarks: Object.entries(perAssetBenchmarks)
          .filter(([id]) => result.stats.some((s) => s.assetId === id))
          .map(([assetId, benchmarkAssetId]) => ({ assetId, benchmarkAssetId })),
        defaultBenchmarkAssetId: result.benchmarkAssetId,
        historyWindowStart,
      })
        .then((resp) => {
          setLiveIr((prev) => {
            const next = { ...prev };
            for (const r of resp.rows) {
              next[r.assetId] = {
                informationRatio: r.informationRatio,
                trackingError: r.trackingError,
                benchmarkAssetId: r.benchmarkAssetId,
                benchmarkName: r.benchmarkName,
              };
            }
            return next;
          });
        })
        .finally(() => setPendingIr(false));
    }, 180);
    return () => clearTimeout(t);
    // Re-run any time the per-asset benchmark map changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perAssetBenchmarks, historyWindowStart, result.benchmarkAssetId]);

  return (
    <>
      <section style={S.banner}>
        <div>
          <strong>Total portfolio:</strong> {CURRENCY(capital)}
          {hasCurrent && <> · <strong>Current:</strong> {CURRENCY(result.currentTotal)} · <strong>New capital:</strong> {CURRENCY(result.newCapital)}</>}
        </div>
        <div>
          <strong>History window:</strong> {historyWindowStart ?? "All"} · {result.effectiveWindowMonths} months in view
        </div>
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>Efficient frontier</h2>
        <p style={S.hint}>Each dot = one random portfolio; curve = Pareto-optimal set. Red = Max Sharpe, purple = Max Sortino, green = Min Variance, teal = Min Drawdown, grey = individual assets.</p>
        <FrontierChart result={result} assetById={assetById} />
      </section>

      <RobustnessCard
        data={robustness}
        assetById={assetById}
        onRun={onRunRobustness}
        isRunning={isRobustnessRunning}
        heldAssetIds={new Set(
          Object.entries(result.currentInvestments)
            .filter(([, v]) => v > 0)
            .map(([id]) => id),
        )}
      />

      <ManagerDriftCard
        assets={assets}
        historyWindowStart={historyWindowStart}
        perAssetBenchmarks={perAssetBenchmarks}
      />

      <div style={S.grid2}>
        <section style={S.card}>
          <h2 style={S.h2}>Growth of $1 (log scale)</h2>
          <p style={S.hint}>Compounded per-asset equity curves. Each fund starts at $1 on its inception month.</p>
          <GrowthChart series={result.assetSeries} assetById={assetById} />
        </section>
        <section style={S.card}>
          <h2 style={S.h2}>Drawdown</h2>
          <p style={S.hint}>Peak-to-trough loss over time. CAS Sosin's 2022 -77% is the standout risk in the set.</p>
          <DrawdownChart series={result.assetSeries} assetById={assetById} />
        </section>
      </div>

      <div style={S.grid5}>
        <PortfolioCard title="Max Sharpe" subtitle="Best risk-adjusted (vs. RF)" portfolio={result.maxSharpe} totalCapital={result.totalCapital} currentInv={result.currentInvestments} assetById={assetById} accent="#dc2626" />
        <PortfolioCard title="Max Sortino" subtitle="Best downside-adjusted" portfolio={result.maxSortino} totalCapital={result.totalCapital} currentInv={result.currentInvestments} assetById={assetById} accent="#7c3aed" />
        <PortfolioCard title="Max Info Ratio" subtitle={`Best active alpha vs ${result.benchmarkName.split(" ")[0]}`} portfolio={result.maxInformationRatio} totalCapital={result.totalCapital} currentInv={result.currentInvestments} assetById={assetById} accent="#ea580c" />
        <PortfolioCard title="Min Variance" subtitle="Lowest vol" portfolio={result.minVariance} totalCapital={result.totalCapital} currentInv={result.currentInvestments} assetById={assetById} accent="#059669" />
        <PortfolioCard title="Min Drawdown" subtitle="Smallest historical loss" portfolio={result.minDrawdown} totalCapital={result.totalCapital} currentInv={result.currentInvestments} assetById={assetById} accent="#0891b2" />
      </div>

      <section style={S.card}>
        <h2 style={S.h2}>Interactive portfolio builder</h2>
        <p style={S.hint}>
          Drag the sliders to build any portfolio. Weights auto-normalise. Live stats + equity curve
          update in real time. Start from a preset to seed a portfolio.
        </p>
        <InteractiveBuilder
          result={result}
          assetById={assetById}
          riskFreeRate={riskFreeRate}
          respectMin={respectMin}
          overrides={overrides}
          capital={capital}
          minInvOverrides={minInvOverrides}
          historyWindowStart={historyWindowStart}
        />
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>Correlation matrix</h2>
        <p style={S.hint}>Pearson ρ over each pair's overlapping monthly history; correlation-cap overrides applied where set.</p>
        <CorrelationMatrix result={result} assetById={assetById} />
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>
          Asset stats (post-override){" "}
          {pendingIr && <span style={{ ...S.hint, fontSize: "0.7rem", color: "#3b82f6" }}>· recomputing IR…</span>}
        </h2>
        <p style={S.hint}>
          <b>Portfolio-level</b> IR is measured vs <b>{result.benchmarkName}</b> (the top-level
          benchmark). <b>Per-asset</b> IR uses each row's chosen benchmark below — defaulted
          to the benchmark each fund's own factsheet uses (Upslope→HFRX EH, Alluvial→Russell
          MicroCap, Cedar Creek→Russell 2000). Change the dropdown per row and the IR updates
          live — no re-optimize required.<br />
          Rule-of-thumb IR scale (Grinold &amp; Kahn):{" "}
          <span style={{ ...S.chipMuted, color: "#059669", fontWeight: 600 }}>&gt; 0.75 very good</span>
          {" · "}<span style={{ ...S.chipMuted, color: "#059669" }}>0.5–0.75 good</span>
          {" · "}<span style={{ ...S.chipMuted, color: "#65a30d" }}>0.25–0.5 decent</span>
          {" · "}<span style={{ ...S.chipMuted, color: "#94a3b8" }}>~0 no alpha</span>
          {" · "}<span style={{ ...S.chipMuted, color: "#dc2626", fontWeight: 600 }}>&lt; 0 worse than benchmark</span>
        </p>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Asset</th>
              <th style={S.thNum}>μ (ann)</th>
              <th style={S.thNum}>σ (ann)</th>
              <th style={S.thNum}>Sharpe</th>
              <th style={S.th}>IR benchmark</th>
              <th style={S.thNum}>IR</th>
              <th style={S.thNum}>Tracking err.</th>
              <th style={S.thNum}>Max DD</th>
              <th style={S.thNum}>Months</th>
            </tr>
          </thead>
          <tbody>
            {result.stats.map((s) => {
              const sharpe =
                s.annualisedVol > 0 ? (s.annualisedReturn - result.riskFreeRate) / s.annualisedVol : 0;
              const seriesForAsset = result.assetSeries.find((x) => x.assetId === s.assetId);
              // Use the LIVE IR row (updated on-the-fly via /rescore-ir)
              // rather than the frozen server value from the last optimize.
              const ir = liveIr[s.assetId] ?? {
                informationRatio: s.informationRatio,
                trackingError: s.trackingError,
                benchmarkAssetId: s.benchmarkAssetId,
                benchmarkName: s.benchmarkName,
              };
              const isBench = s.assetId === ir.benchmarkAssetId;
              return (
                <tr key={s.assetId}>
                  <td style={S.td}>{assetById[s.assetId]?.name ?? s.assetId}</td>
                  <td style={S.tdNum}>{PCT(s.annualisedReturn)}</td>
                  <td style={S.tdNum}>{PCT(s.annualisedVol)}</td>
                  <td style={S.tdNum}>{sharpe.toFixed(2)}</td>
                  <td style={S.td}>
                    <select
                      value={perAssetBenchmarks[s.assetId] ?? ir.benchmarkAssetId}
                      onChange={(e) => setPerAssetBenchmark(s.assetId, e.target.value)}
                      style={{ ...S.input, fontSize: "0.7rem", padding: "3px 6px" }}
                    >
                      {assets.map((a) => (
                        <option key={a.id} value={a.id} disabled={a.id === s.assetId}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ ...S.tdNum, color: !isBench && ir.informationRatio > 0 ? "#059669" : (ir.informationRatio < 0 ? "#dc2626" : "#94a3b8"), fontWeight: 600, transition: "color 0.15s" }}>
                    {isBench ? "—" : (ir.informationRatio !== 0 ? ir.informationRatio.toFixed(2) : "—")}
                  </td>
                  <td style={S.tdNum}>{isBench ? "—" : (ir.trackingError > 0 ? PCT(ir.trackingError) : "—")}</td>
                  <td style={{ ...S.tdNum, color: "#dc2626" }}>{PCT(seriesForAsset?.maxDrawdown ?? 0)}</td>
                  <td style={S.tdNum}>{s.nMonths}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

// ─────────────────────── Manager Drift card ───────────────────────

function ManagerDriftCard({
  assets,
  historyWindowStart,
  perAssetBenchmarks,
}: {
  assets: FundAsset[];
  historyWindowStart: string | null;
  perAssetBenchmarks: Record<string, string>;
}) {
  const funds = useMemo(() => assets.filter((a) => a.kind === "hedge_fund"), [assets]);
  const [selectedFund, setSelectedFund] = useState<string>(funds[0]?.id ?? "");
  const [benchmarkId, setBenchmarkId] = useState<string>("spy");
  const [windowMonths, setWindowMonths] = useState<number>(36);

  useEffect(() => {
    // Default benchmark to the fund's per-asset default when the fund changes.
    if (selectedFund && perAssetBenchmarks[selectedFund]) {
      setBenchmarkId(perAssetBenchmarks[selectedFund]);
    }
  }, [selectedFund, perAssetBenchmarks]);

  useEffect(() => {
    if (!selectedFund && funds[0]) setSelectedFund(funds[0].id);
  }, [funds, selectedFund]);

  const query = useQuery({
    queryKey: ["rolling-stats", selectedFund, benchmarkId, windowMonths, historyWindowStart],
    queryFn: () => fetchRollingStats({
      assetId: selectedFund,
      benchmarkAssetId: benchmarkId,
      windowMonths,
      historyWindowStart,
      riskFreeRate: 0.04,
    }),
    enabled: !!selectedFund,
    staleTime: 60_000,
  });

  return (
    <section style={S.card}>
      <h2 style={S.h2}>Manager drift + data adequacy</h2>
      <p style={S.hint}>
        Answers <b>"Do I have enough data?"</b> and <b>"Has the manager's behaviour changed?"</b>
        Splits the fund's history into first-half vs second-half, compares CAGR / vol / Sharpe,
        and flags meaningful shifts. Also shows rolling {windowMonths}-month statistics so you
        can spot trends visually. Data-adequacy classification tells you how much confidence to
        put in the numbers.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
        <label style={{ ...S.label, marginBottom: 0, minWidth: 220 }}>
          Fund
          <select value={selectedFund} onChange={(e) => setSelectedFund(e.target.value)} style={S.input}>
            {funds.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <label style={{ ...S.label, marginBottom: 0, minWidth: 220 }}>
          Benchmark
          <select value={benchmarkId} onChange={(e) => setBenchmarkId(e.target.value)} style={S.input}>
            {assets.map((a) => (
              <option key={a.id} value={a.id} disabled={a.id === selectedFund}>{a.name}</option>
            ))}
          </select>
        </label>
        <label style={{ ...S.label, marginBottom: 0, minWidth: 140 }}>
          Rolling window
          <select value={windowMonths} onChange={(e) => setWindowMonths(Number(e.target.value))} style={S.input}>
            <option value={24}>24 months</option>
            <option value={36}>36 months</option>
            <option value={60}>60 months</option>
            <option value={120}>120 months</option>
          </select>
        </label>
      </div>

      {query.isLoading && <p style={S.hint}>Computing…</p>}
      {query.data && <DriftResult data={query.data} />}
    </section>
  );
}

function DriftResult({ data }: { data: RollingStatsResponse }) {
  const ADEQUACY_COLOR: Record<string, string> = {
    unreliable: "#dc2626",
    sparse: "#d97706",
    decent: "#059669",
    strong: "#0f766e",
  };
  const SEVERITY_COLOR: Record<string, string> = {
    minor: "#94a3b8",
    notable: "#d97706",
    significant: "#dc2626",
  };
  // Signed formatter with sign + colour hint
  const signed = (v: number, digits = 1) =>
    (v > 0 ? "+" : "") + PCT(v, digits);
  const signedNum = (v: number, digits = 2) =>
    (v > 0 ? "+" : "") + v.toFixed(digits);

  return (
    <>
      <div style={{ ...S.calloutInfo, background: "#eef2ff", border: "1px solid #c7d2fe", color: "#312e81" }}>
        <b style={{ color: ADEQUACY_COLOR[data.dataAdequacy] }}>{data.dataAdequacy.toUpperCase()}</b>
        {" — "}{data.dataAdequacyMessage}
      </div>

      {data.splitNearCrisis && (
        <div style={S.calloutInfo}>
          ⚠ <b>Split-sample warning:</b> {data.splitCrisisNote}
        </div>
      )}

      <div style={{ ...S.grid2, marginBottom: 12 }}>
        <div style={S.card}>
          <h3 style={{ ...S.h2, fontSize: "0.85rem", marginBottom: 8 }}>
            Split-sample comparison
          </h3>
          <p style={{ ...S.hint, marginBottom: 6 }}>
            <b>First half:</b> {data.firstHalfStart} → {data.firstHalfEnd} ·{" "}
            <b>Second half:</b> {data.secondHalfStart} → {data.secondHalfEnd}
          </p>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Period</th>
                <th style={S.thNum}>Fund CAGR</th>
                <th style={S.thNum}>Bench CAGR</th>
                <th style={S.thNum}>Alpha</th>
                <th style={S.thNum}>Vol</th>
                <th style={S.thNum}>Sharpe</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={S.td}>
                  1st half
                  <div style={{ ...S.chipMuted, fontSize: "0.6rem" }}>
                    {data.firstHalfStart}<br />→ {data.firstHalfEnd}
                  </div>
                </td>
                <td style={S.tdNum}>{PCT(data.firstHalfCagr)}</td>
                <td style={S.tdNumMuted}>{PCT(data.benchFirstHalfCagr)}</td>
                <td style={{ ...S.tdNum, color: data.alphaFirstHalf > 0 ? "#059669" : "#dc2626", fontWeight: 600 }}>
                  {signed(data.alphaFirstHalf)}
                </td>
                <td style={S.tdNum}>{PCT(data.firstHalfVol)}</td>
                <td style={S.tdNum}>{data.firstHalfSharpe.toFixed(2)}</td>
              </tr>
              <tr>
                <td style={S.td}>
                  2nd half
                  <div style={{ ...S.chipMuted, fontSize: "0.6rem" }}>
                    {data.secondHalfStart}<br />→ {data.secondHalfEnd}
                  </div>
                </td>
                <td style={S.tdNum}>{PCT(data.secondHalfCagr)}</td>
                <td style={S.tdNumMuted}>{PCT(data.benchSecondHalfCagr)}</td>
                <td style={{ ...S.tdNum, color: data.alphaSecondHalf > 0 ? "#059669" : "#dc2626", fontWeight: 600 }}>
                  {signed(data.alphaSecondHalf)}
                </td>
                <td style={S.tdNum}>{PCT(data.secondHalfVol)}</td>
                <td style={S.tdNum}>{data.secondHalfSharpe.toFixed(2)}</td>
              </tr>
              <tr style={{ background: "#f8fafc", fontWeight: 600 }}>
                <td style={S.td}>Full period</td>
                <td style={S.tdNum}>{PCT(data.fullPeriodCagr)}</td>
                <td style={S.tdNumMuted}>{PCT(data.benchFullCagr)}</td>
                <td style={{ ...S.tdNum, color: data.alphaFull > 0 ? "#059669" : "#dc2626", fontWeight: 600 }}>
                  {signed(data.alphaFull)}
                </td>
                <td style={S.tdNum}>{PCT(data.fullPeriodVol)}</td>
                <td style={S.tdNum}>{data.fullPeriodSharpe.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
          <p style={{ ...S.hint, marginTop: 8 }}>
            <b>Alpha</b> = Fund CAGR − Benchmark CAGR over the same months. This isolates
            manager drift from market regime — a fund's raw CAGR could halve just because the
            market halved, but its alpha would still be stable if the manager isn't drifting.
          </p>
        </div>

        <div style={S.card}>
          <h3 style={{ ...S.h2, fontSize: "0.85rem", marginBottom: 8 }}>
            Drift flags + rolling-trend slopes
          </h3>
          {data.driftFlags.map((f) => (
            <div key={f.metric} style={{
              marginBottom: 8,
              padding: "6px 10px",
              borderLeft: `3px solid ${SEVERITY_COLOR[f.severity]}`,
              background: "#f8fafc",
              borderRadius: 4,
              fontSize: "0.75rem",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span><b>{f.metric}</b> — <span style={{ color: SEVERITY_COLOR[f.severity], fontWeight: 600 }}>{f.severity.toUpperCase()}</span></span>
                <span style={{ color: f.change > 0 ? "#059669" : "#dc2626", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {f.change > 0 ? "+" : ""}{f.metric === "Sharpe" ? f.change.toFixed(2) : PCT(f.change)}
                </span>
              </div>
              <div style={{ color: "#475569", fontSize: "0.7rem", marginTop: 3 }}>{f.interpretation}</div>
            </div>
          ))}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e2e8f0" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 600, marginBottom: 4, color: "#0f172a" }}>
              Trend slopes (change per year, robust to crash placement):
            </div>
            <div style={{ fontSize: "0.7rem", color: "#475569", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
              <div>CAGR: <b style={{ color: data.trendSlopeCagr < -0.005 ? "#dc2626" : data.trendSlopeCagr > 0.005 ? "#059669" : "#334155" }}>{signed(data.trendSlopeCagr, 2)}/yr</b></div>
              <div>Vol: <b style={{ color: data.trendSlopeVol > 0.005 ? "#dc2626" : data.trendSlopeVol < -0.005 ? "#059669" : "#334155" }}>{signed(data.trendSlopeVol, 2)}/yr</b></div>
              <div>Sharpe: <b style={{ color: data.trendSlopeSharpe < -0.05 ? "#dc2626" : data.trendSlopeSharpe > 0.05 ? "#059669" : "#334155" }}>{signedNum(data.trendSlopeSharpe, 2)}/yr</b></div>
            </div>
            <p style={{ ...S.hint, fontSize: "0.62rem", marginTop: 4 }}>
              Linear regression through the rolling-window series — a single crisis at the split
              point barely moves this, but a genuine drift trend does.
            </p>
          </div>
        </div>
      </div>

      <div style={S.card}>
        <h3 style={{ ...S.h2, fontSize: "0.85rem", marginBottom: 4 }}>
          Rolling {data.windowMonths}-month statistics vs {data.benchmarkName}
        </h3>
        <p style={S.hint}>Watch for trends — a steadily rising vol line means the fund quietly got more aggressive; a falling correlation means it started acting less like the benchmark.</p>
        <RollingStatsChart data={data} />
      </div>
    </>
  );
}

function RollingStatsChart({ data }: { data: RollingStatsResponse }) {
  const W = 780;
  const H = 320;
  const P = { top: 12, right: 100, bottom: 26, left: 55 };
  const iw = W - P.left - P.right;
  const ih = H - P.top - P.bottom;

  const [hover, setHover] = useState<number | null>(null);

  if (data.windows.length < 2) {
    return <p style={S.hint}>Not enough windows to plot ({data.windows.length}). Try a shorter rolling window or a fund with more history.</p>;
  }

  const parseMonth = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    return y! + (mm! - 1) / 12;
  };
  const months = data.windows.map((w) => parseMonth(w.endMonth));
  const xMin = months[0]!;
  const xMax = months[months.length - 1]!;

  // Multi-axis: CAGR + Vol on left (%), Sharpe + IR + Corr on right (unitless)
  const leftMin = Math.min(0, ...data.windows.map((w) => Math.min(w.cagr, w.vol)));
  const leftMax = Math.max(...data.windows.map((w) => Math.max(w.cagr, w.vol)));
  const rightMin = Math.min(-1, ...data.windows.map((w) => Math.min(w.sharpe, w.informationRatio, w.correlation)));
  const rightMax = Math.max(2, ...data.windows.map((w) => Math.max(w.sharpe, w.informationRatio, w.correlation)));

  const x = (m: string) => P.left + ((parseMonth(m) - xMin) / (xMax - xMin || 1)) * iw;
  const yL = (v: number) => P.top + ih - ((v - leftMin) / (leftMax - leftMin || 1)) * ih;
  const yR = (v: number) => P.top + ih - ((v - rightMin) / (rightMax - rightMin || 1)) * ih;

  const yearStep = Math.max(1, Math.floor((xMax - xMin) / 6));
  const xTicks: string[] = [];
  for (let yr = Math.ceil(xMin); yr <= Math.floor(xMax); yr += yearStep) xTicks.push(`${yr}-01`);

  const path = (fn: (w: typeof data.windows[0]) => number) =>
    data.windows.map((w, i) => `${i === 0 ? "M" : "L"}${x(w.endMonth)},${fn(w)}`).join(" ");
  const cagrD = path((w) => yL(w.cagr));
  const volD = path((w) => yL(w.vol));
  const sharpeD = path((w) => yR(w.sharpe));
  const irD = path((w) => yR(w.informationRatio));
  const corrD = path((w) => yR(w.correlation));

  const series = [
    { name: "CAGR", color: "#1e40af", d: cagrD, unit: "%", axis: "left" },
    { name: "Vol", color: "#dc2626", d: volD, unit: "%", axis: "left" },
    { name: "Sharpe", color: "#059669", d: sharpeD, unit: "", axis: "right" },
    { name: "IR", color: "#ea580c", d: irD, unit: "", axis: "right" },
    { name: `Corr vs bench`, color: "#7c3aed", d: corrD, unit: "", axis: "right" },
  ];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < data.windows.length; i++) {
      const d = Math.abs(x(data.windows[i]!.endMonth) - mx);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    setHover(bestI);
  };

  return (
    <div>
      <svg width={W} height={H} style={{ background: "#fafbfc", cursor: "crosshair" }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {/* Left y-axis grid + labels */}
        {[-0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5].filter((v) => v >= leftMin && v <= leftMax).map((v) => (
          <g key={`gl${v}`}>
            <line x1={P.left} y1={yL(v)} x2={P.left + iw} y2={yL(v)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={P.left - 6} y={yL(v) + 3} textAnchor="end" fontSize={10} fill="#64748b">{PCT(v, 0)}</text>
          </g>
        ))}
        {/* Right y-axis labels */}
        {[-1, 0, 0.5, 1, 1.5, 2].filter((v) => v >= rightMin && v <= rightMax).map((v) => (
          <text key={`gr${v}`} x={P.left + iw + 6} y={yR(v) + 3} textAnchor="start" fontSize={10} fill="#64748b">{v.toFixed(1)}</text>
        ))}
        {/* X ticks */}
        {xTicks.map((m) => (
          <g key={`gx${m}`}>
            <line x1={x(m)} y1={P.top} x2={x(m)} y2={P.top + ih} stroke="#eef2f7" strokeWidth={1} />
            <text x={x(m)} y={P.top + ih + 14} textAnchor="middle" fontSize={10} fill="#64748b">{m.slice(0, 4)}</text>
          </g>
        ))}

        {/* Zero line for right axis (Sharpe, IR, corr = 0 is a meaningful reference) */}
        <line x1={P.left} y1={yR(0)} x2={P.left + iw} y2={yR(0)} stroke="#cbd5e1" strokeDasharray="3,3" />

        {series.map((s) => (
          <path key={s.name} d={s.d} stroke={s.color} strokeWidth={1.8} fill="none" opacity={0.85} />
        ))}

        {hover !== null && (
          <line x1={x(data.windows[hover]!.endMonth)} y1={P.top} x2={x(data.windows[hover]!.endMonth)} y2={P.top + ih} stroke="#334155" strokeDasharray="3,3" opacity={0.5} />
        )}

        <text x={14} y={P.top + ih / 2} transform={`rotate(-90 14 ${P.top + ih / 2})`} textAnchor="middle" fontSize={11} fill="#334155">
          Left: CAGR / Vol
        </text>
        <text x={P.left + iw + 80} y={P.top + ih / 2} transform={`rotate(90 ${P.left + iw + 80} ${P.top + ih / 2})`} textAnchor="middle" fontSize={11} fill="#334155">
          Right: Sharpe / IR / Corr
        </text>

        {/* Legend */}
        {series.map((s, i) => (
          <g key={`leg${s.name}`}>
            <line x1={P.left + iw + 8} y1={P.top + 8 + i * 14} x2={P.left + iw + 20} y2={P.top + 8 + i * 14} stroke={s.color} strokeWidth={2} />
            <text x={P.left + iw + 24} y={P.top + 11 + i * 14} fontSize={10} fill="#334155">{s.name}</text>
          </g>
        ))}
      </svg>
      {hover !== null && (
        <div style={S.chartTooltip}>
          <b>{data.windows[hover]!.endMonth}</b>
          <span> · CAGR {PCT(data.windows[hover]!.cagr)}</span>
          <span> · Vol {PCT(data.windows[hover]!.vol)}</span>
          <span> · Sharpe {data.windows[hover]!.sharpe.toFixed(2)}</span>
          <span> · IR {data.windows[hover]!.informationRatio.toFixed(2)}</span>
          <span> · Corr {data.windows[hover]!.correlation.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────── Robustness Scan card ───────────────────────

function RobustnessCard({
  data,
  assetById,
  onRun,
  isRunning,
  heldAssetIds,
}: {
  data: RobustnessResponse | undefined;
  assetById: Record<string, FundAsset>;
  onRun: () => void;
  isRunning: boolean;
  heldAssetIds: Set<string>;
}) {
  return (
    <section style={S.card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h2 style={S.h2}>Fund robustness scan</h2>
          <p style={S.hint}>
            Runs the optimizer across <b>24 scenarios</b> (4 history windows × 3 risk-free rates × Max Sharpe + Max Sortino) and reports how often each fund appears in the winning portfolio. Uses <b>all your current settings</b> — overrides, min investments, concentration caps, current holdings, and no-sell if on.
          </p>
        </div>
        <button
          onClick={onRun}
          disabled={isRunning}
          style={{ ...S.primaryBtn, width: "auto", padding: "8px 16px" }}
        >
          {isRunning ? "Scanning… (~7s)" : data ? "Re-run scan" : "Run robustness scan"}
        </button>
      </div>
      {heldAssetIds.size > 0 && (
        <div style={S.calloutInfo}>
          ⚠ <b>Heads up:</b> you have {heldAssetIds.size} current position(s). If <b>no-sell</b> is on, held
          funds will show 100% frequency because we're forcing them to stay ≥ their current weight —
          that's constraint-driven, not merit. Turn no-sell OFF and re-run to see the merit-based
          picture. Held funds are marked <span style={S.forcedPill}>🔒 held</span> in the table below.
          <br />
          <br />
          <b>Why median weights match certain floors:</b> the sampler applies
          <code style={{ background: "#fef3c7", padding: "0 4px", borderRadius: 3 }}>max(soft min-investment floor when in sample, hard no-sell floor always)</code>.
          The final floor is the LARGER of your min-investment (as % of total capital) and your
          current-holding (as % of total capital). Look at the assets table — the small purple
          "→ soft floor" and "→ hard floor" hints below each dollar input show the actual %
          being applied per fund.
        </div>
      )}
      {!data && !isRunning && (
        <p style={{ ...S.hint, marginTop: 8, fontStyle: "italic" }}>
          Click "Run robustness scan" to see which funds are consistent picks regardless of your history window / RF rate / objective choices.
        </p>
      )}
      {data && <RobustnessTable data={data} assetById={assetById} heldAssetIds={heldAssetIds} />}
    </section>
  );
}

function RobustnessTable({
  data,
  assetById,
  heldAssetIds,
}: {
  data: RobustnessResponse;
  assetById: Record<string, FundAsset>;
  heldAssetIds: Set<string>;
}) {
  const CLASS_TINT: Record<string, string> = {
    core: "#059669",
    situational: "#d97706",
    peripheral: "#94a3b8",
  };
  const CLASS_BG: Record<string, string> = {
    core: "#dcfce7",
    situational: "#fef3c7",
    peripheral: "#f1f5f9",
  };
  const CLASS_LABEL: Record<string, string> = {
    core: "CORE",
    situational: "SITUATIONAL",
    peripheral: "PERIPHERAL",
  };
  const CLASS_HINT: Record<string, string> = {
    core: "In ≥ 2/3 of scenarios — pick with confidence",
    situational: "Regime-dependent — only helps under specific assumptions",
    peripheral: "Rarely helps — dominated by other funds",
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, marginTop: 8 }}>
        {(["core", "situational", "peripheral"] as const).map((k) => (
          <span key={k} style={{ ...S.chip, background: CLASS_TINT[k], fontSize: "0.65rem" }}>
            {CLASS_LABEL[k]}: {CLASS_HINT[k]}
          </span>
        ))}
      </div>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Fund</th>
            <th style={S.th}>Class</th>
            <th style={S.th}>Selection frequency</th>
            <th style={S.thNum}>%</th>
            <th style={S.thNum}>Median wt</th>
            <th style={S.thNum}>Median wt<br />(when picked)</th>
            <th style={S.thNum}>Max wt</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => {
            const isHeld = heldAssetIds.has(r.assetId);
            // "Forced core" heuristic: fund is currently held AND classified
            // as core with 100% frequency — that's the constraint doing it,
            // not merit.
            const forcedCore = isHeld && r.classification === "core" && r.selectionFrequency >= 0.99;
            return (
            <tr key={r.assetId} style={{ background: CLASS_BG[r.classification], opacity: r.classification === "peripheral" ? 0.7 : 1 }}>
              <td style={{ ...S.td, fontWeight: 600, color: ASSET_COLOR[r.assetId] }}>
                {assetById[r.assetId]?.name ?? r.assetId}
                {isHeld && <span style={{ ...S.forcedPill, marginLeft: 6 }} title="You currently hold this fund">🔒 held</span>}
              </td>
              <td style={S.td}>
                <span style={{ ...S.chip, background: CLASS_TINT[r.classification], fontSize: "0.6rem" }}>
                  {CLASS_LABEL[r.classification]}
                </span>
                {forcedCore && (
                  <div style={{ fontSize: "0.6rem", color: "#92400e", marginTop: 2, fontStyle: "italic" }}>
                    forced by no-sell
                  </div>
                )}
              </td>
              <td style={S.td}>
                <div style={{ background: "#e2e8f0", borderRadius: 3, height: 14, position: "relative", width: 180 }}>
                  <div
                    style={{
                      background: CLASS_TINT[r.classification],
                      width: `${r.selectionFrequency * 100}%`,
                      height: "100%",
                      borderRadius: 3,
                      transition: "width 0.4s",
                    }}
                  />
                  <span style={{
                    position: "absolute",
                    left: 6,
                    top: 0,
                    lineHeight: "14px",
                    fontSize: "0.65rem",
                    fontWeight: 600,
                    color: r.selectionFrequency > 0.35 ? "white" : "#334155",
                  }}>
                    {(r.selectionFrequency * 100).toFixed(0)}%
                  </span>
                </div>
              </td>
              <td style={S.tdNum}>{(r.selectionFrequency * 100).toFixed(0)}%</td>
              <td style={S.tdNum}>{PCT(r.medianWeight, 1)}</td>
              <td style={S.tdNum}>{r.medianWeightWhenSelected > 0 ? PCT(r.medianWeightWhenSelected, 1) : "—"}</td>
              <td style={S.tdNum}>{PCT(r.maxWeight, 1)}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ ...S.hint, marginTop: 10 }}>
        Scanned across {data.totalScenarios} scenarios. "Selection frequency" = fraction of scenarios where the fund got &gt;5% weight in the winning portfolio.
        A CORE fund appears in most scenarios and is a defensible pick regardless of your specific assumption choices; a
        SITUATIONAL fund only helps in some regimes; a PERIPHERAL fund rarely helps because other funds dominate it.
      </p>
    </div>
  );
}

function PortfolioCard({
  title,
  subtitle,
  portfolio,
  totalCapital,
  currentInv,
  assetById,
  accent,
}: {
  title: string;
  subtitle: string;
  portfolio: PortfolioPoint;
  totalCapital: number;
  currentInv: Record<string, number>;
  assetById: Record<string, FundAsset>;
  accent: string;
}) {
  // Show every asset that either has an allocation OR has a current position
  // — so users can see "Sell $X" as a clear delta on funds they hold today.
  const idsWithCurrent = Object.entries(currentInv).filter(([, v]) => v > 0).map(([id]) => id);
  const idsInPortfolio = Object.entries(portfolio.weights).filter(([, w]) => w > 0.005).map(([id]) => id);
  const allIds = Array.from(new Set([...idsInPortfolio, ...idsWithCurrent]));
  const rows = allIds
    .map((id) => {
      const w = portfolio.weights[id] ?? 0;
      const proposed = w * totalCapital;
      const current = currentInv[id] ?? 0;
      const delta = proposed - current;
      return { id, w, proposed, current, delta };
    })
    .sort((a, b) => b.proposed - a.proposed);
  const violators = new Set(portfolio.violatesMinInvestment);
  const hasCurrent = Object.values(currentInv).some((v) => v > 0);

  return (
    <section style={{ ...S.card, borderTop: `3px solid ${accent}`, marginBottom: 0 }}>
      <h2 style={{ ...S.h2, color: accent }}>{title}</h2>
      <p style={S.hint}>{subtitle}</p>
      <div style={S.statGridSmall}>
        <Stat label="Return" value={PCT(portfolio.annualisedReturn)} />
        <Stat label="Vol" value={PCT(portfolio.annualisedVol)} />
        <Stat label="Sharpe" value={portfolio.sharpe.toFixed(2)} />
        <Stat label="Sortino" value={portfolio.sortino !== 0 ? portfolio.sortino.toFixed(2) : "—"} />
        <Stat label="IR" value={portfolio.informationRatio !== 0 ? portfolio.informationRatio.toFixed(2) : "—"} />
        <Stat label="Max DD" value={portfolio.maxDrawdown < -0.0001 ? PCT(portfolio.maxDrawdown) : "0.0%"} />
      </div>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Fund</th>
            <th style={S.thNum}>%</th>
            <th style={S.thNum}>Target</th>
            {hasCurrent && <th style={S.thNum}>Current</th>}
            {hasCurrent && <th style={S.thNum}>Δ (add/sell)</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, w, proposed, current, delta }) => (
            <tr key={id}>
              <td style={{ ...S.td, color: ASSET_COLOR[id], fontWeight: 600 }}>{SHORT_NAME[id] ?? id}</td>
              <td style={S.tdNum}>{PCT(w, 1)}</td>
              <td style={S.tdNum}>{CURRENCY(proposed)}</td>
              {hasCurrent && <td style={S.tdNumMuted}>{current > 0 ? CURRENCY(current) : "—"}</td>}
              {hasCurrent && (
                <td style={{
                  ...S.tdNum,
                  color: delta > 0.5 ? "#059669" : delta < -0.5 ? "#dc2626" : "#94a3b8",
                  fontWeight: Math.abs(delta) > 1000 ? 600 : 400,
                }}>
                  {Math.abs(delta) < 0.5 ? "—" : (delta > 0 ? "+" : "") + CURRENCY(delta)}
                </td>
              )}
              {violators.has(id) && (
                <td style={S.tdNum}>
                  <span style={S.warnPill} title={`Below min ${CURRENCY(assetById[id]?.minInvestment ?? 0)}`}>⚠</span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.stat}>
      <div style={S.statLabel}>{label}</div>
      <div style={S.statValue}>{value}</div>
    </div>
  );
}

// ─────────────────────── Efficient Frontier chart ───────────────────────

function FrontierChart({
  result,
  assetById,
}: {
  result: OptimizeResponse;
  assetById: Record<string, FundAsset>;
}) {
  const W = 780;
  const H = 380;
  const P = { top: 20, right: 20, bottom: 40, left: 60 };
  const iw = W - P.left - P.right;
  const ih = H - P.top - P.bottom;

  const points = [...result.frontier, result.maxSharpe, result.maxSortino, result.maxInformationRatio, result.minVariance, result.minDrawdown];
  const assetDots = result.stats.map((s) => ({ id: s.assetId, vol: s.annualisedVol, ret: s.annualisedReturn }));

  const allVols = [...points.map((p) => p.annualisedVol), ...assetDots.map((d) => d.vol)];
  const allRets = [...points.map((p) => p.annualisedReturn), ...assetDots.map((d) => d.ret)];

  const volMax = Math.max(...allVols, 0.3) * 1.05;
  const retMin = Math.min(...allRets, 0);
  const retMax = Math.max(...allRets, 0.25) * 1.05;

  const x = (v: number) => P.left + (v / volMax) * iw;
  const y = (r: number) => P.top + ih - ((r - retMin) / (retMax - retMin || 1)) * ih;

  const volTicks = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4].filter((v) => v <= volMax);
  const retTicks: number[] = [];
  for (let r = Math.floor(retMin / 0.05) * 0.05; r <= retMax; r += 0.05) retTicks.push(r);

  const frontierPath = result.frontier
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.annualisedVol)},${y(p.annualisedReturn)}`)
    .join(" ");

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={W} height={H} style={{ display: "block", background: "#fafbfc" }}>
        {volTicks.map((v) => (
          <g key={`gx${v}`}>
            <line x1={x(v)} y1={P.top} x2={x(v)} y2={P.top + ih} stroke="#e2e8f0" strokeWidth={1} />
            <text x={x(v)} y={P.top + ih + 16} textAnchor="middle" fontSize={11} fill="#64748b">{PCT(v, 0)}</text>
          </g>
        ))}
        {retTicks.map((r) => (
          <g key={`gy${r}`}>
            <line x1={P.left} y1={y(r)} x2={P.left + iw} y2={y(r)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={P.left - 6} y={y(r) + 4} textAnchor="end" fontSize={11} fill="#64748b">{PCT(r, 0)}</text>
          </g>
        ))}
        <text x={P.left + iw / 2} y={H - 6} textAnchor="middle" fontSize={12} fill="#334155">Volatility (annualised)</text>
        <text x={14} y={P.top + ih / 2} transform={`rotate(-90 14 ${P.top + ih / 2})`} textAnchor="middle" fontSize={12} fill="#334155">Expected return (annualised)</text>
        <path d={frontierPath} stroke="#1e40af" strokeWidth={2.5} fill="none" opacity={0.9} />
        {assetDots.map((d) => (
          <g key={d.id}>
            <circle cx={x(d.vol)} cy={y(d.ret)} r={5} fill={ASSET_COLOR[d.id] ?? "#94a3b8"} opacity={0.85} stroke="#fff" strokeWidth={1.5} />
            <text x={x(d.vol) + 8} y={y(d.ret) - 5} fontSize={10} fill="#475569">
              {SHORT_NAME[d.id] ?? assetById[d.id]?.name.split(" ")[0]}
            </text>
          </g>
        ))}
        <FrontierMarker x={x(result.maxSharpe.annualisedVol)} y={y(result.maxSharpe.annualisedReturn)} label="Max Sharpe" color="#dc2626" />
        <FrontierMarker x={x(result.maxSortino.annualisedVol)} y={y(result.maxSortino.annualisedReturn)} label="Max Sortino" color="#7c3aed" dy={-14} />
        <FrontierMarker x={x(result.maxInformationRatio.annualisedVol)} y={y(result.maxInformationRatio.annualisedReturn)} label="Max IR" color="#ea580c" dy={14} />
        <FrontierMarker x={x(result.minVariance.annualisedVol)} y={y(result.minVariance.annualisedReturn)} label="Min Var" color="#059669" />
        <FrontierMarker x={x(result.minDrawdown.annualisedVol)} y={y(result.minDrawdown.annualisedReturn)} label="Min DD" color="#0891b2" dy={28} />
      </svg>
    </div>
  );
}

function FrontierMarker({ x, y, label, color, dy = 0 }: { x: number; y: number; label: string; color: string; dy?: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={7} fill={color} stroke="#fff" strokeWidth={2} />
      <text x={x + 12} y={y + 4 + dy} fontSize={11} fill={color} fontWeight={600}>{label}</text>
    </g>
  );
}

// ─────────────────────── Growth-of-$1 chart ───────────────────────

function GrowthChart({
  series,
  assetById,
}: {
  series: AssetSeries[];
  assetById: Record<string, FundAsset>;
}) {
  const W = 540;
  const H = 340;
  const P = { top: 10, right: 100, bottom: 40, left: 55 };
  const iw = W - P.left - P.right;
  const ih = H - P.top - P.bottom;

  // Collect all months for x-axis span
  const allMonths = Array.from(new Set(series.flatMap((s) => s.months))).sort();
  if (allMonths.length === 0) return null;
  const minMonth = allMonths[0]!;
  const maxMonth = allMonths[allMonths.length - 1]!;

  const parseMonth = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    return y! + (mm! - 1) / 12;
  };
  const xMin = parseMonth(minMonth);
  const xMax = parseMonth(maxMonth);
  const maxEq = Math.max(1, ...series.flatMap((s) => s.equity));

  const x = (m: string) => P.left + ((parseMonth(m) - xMin) / (xMax - xMin || 1)) * iw;
  const y = (v: number) => P.top + ih - (Math.log(v) / Math.log(maxEq)) * ih;

  const xTicks: string[] = [];
  const yearStep = Math.max(1, Math.floor((xMax - xMin) / 6));
  for (let yr = Math.ceil(xMin); yr <= Math.floor(xMax); yr += yearStep) {
    xTicks.push(`${yr}-01`);
  }
  const yTicks = [1, 2, 5, 10, 20, 50].filter((v) => v <= maxEq * 1.1);

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={W} height={H} style={{ display: "block", background: "#fafbfc" }}>
        {xTicks.map((m) => (
          <g key={`gx${m}`}>
            <line x1={x(m)} y1={P.top} x2={x(m)} y2={P.top + ih} stroke="#e2e8f0" strokeWidth={1} />
            <text x={x(m)} y={P.top + ih + 16} textAnchor="middle" fontSize={10} fill="#64748b">
              {m.slice(0, 4)}
            </text>
          </g>
        ))}
        {yTicks.map((v) => (
          <g key={`gy${v}`}>
            <line x1={P.left} y1={y(v)} x2={P.left + iw} y2={y(v)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={P.left - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="#64748b">
              ${v}
            </text>
          </g>
        ))}
        <line x1={P.left} y1={y(1)} x2={P.left + iw} y2={y(1)} stroke="#cbd5e1" strokeDasharray="3,3" />

        {series.map((s) => {
          const d = s.months
            .map((m, i) => `${i === 0 ? "M" : "L"}${x(m)},${y(s.equity[i]!)}`)
            .join(" ");
          return (
            <path
              key={s.assetId}
              d={d}
              stroke={ASSET_COLOR[s.assetId] ?? "#94a3b8"}
              strokeWidth={1.6}
              fill="none"
              opacity={0.9}
            />
          );
        })}

        {/* legend */}
        {series.map((s, i) => (
          <g key={`leg${s.assetId}`}>
            <line
              x1={P.left + iw + 10}
              y1={P.top + 12 + i * 16}
              x2={P.left + iw + 25}
              y2={P.top + 12 + i * 16}
              stroke={ASSET_COLOR[s.assetId] ?? "#94a3b8"}
              strokeWidth={2}
            />
            <text
              x={P.left + iw + 30}
              y={P.top + 15 + i * 16}
              fontSize={10}
              fill="#334155"
            >
              {SHORT_NAME[s.assetId] ?? assetById[s.assetId]?.name.split(" ")[0]}
            </text>
          </g>
        ))}

        <text x={14} y={P.top + ih / 2} transform={`rotate(-90 14 ${P.top + ih / 2})`} textAnchor="middle" fontSize={11} fill="#334155">
          Growth of $1 (log)
        </text>
      </svg>
    </div>
  );
}

// ─────────────────────── Drawdown chart ───────────────────────

function DrawdownChart({
  series,
  assetById,
}: {
  series: AssetSeries[];
  assetById: Record<string, FundAsset>;
}) {
  const W = 540;
  const H = 340;
  const P = { top: 10, right: 100, bottom: 40, left: 55 };
  const iw = W - P.left - P.right;
  const ih = H - P.top - P.bottom;

  const allMonths = Array.from(new Set(series.flatMap((s) => s.months))).sort();
  if (allMonths.length === 0) return null;
  const minMonth = allMonths[0]!;
  const maxMonth = allMonths[allMonths.length - 1]!;

  const parseMonth = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    return y! + (mm! - 1) / 12;
  };
  const xMin = parseMonth(minMonth);
  const xMax = parseMonth(maxMonth);

  const worstDD = Math.min(...series.flatMap((s) => s.drawdown), -0.05);

  const x = (m: string) => P.left + ((parseMonth(m) - xMin) / (xMax - xMin || 1)) * iw;
  const y = (v: number) => P.top + (v / worstDD) * ih;

  const xTicks: string[] = [];
  const yearStep = Math.max(1, Math.floor((xMax - xMin) / 6));
  for (let yr = Math.ceil(xMin); yr <= Math.floor(xMax); yr += yearStep) {
    xTicks.push(`${yr}-01`);
  }
  const yTicks: number[] = [];
  for (let v = 0; v >= worstDD - 0.05; v -= 0.1) yTicks.push(v);

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={W} height={H} style={{ display: "block", background: "#fafbfc" }}>
        {xTicks.map((m) => (
          <g key={`gx${m}`}>
            <line x1={x(m)} y1={P.top} x2={x(m)} y2={P.top + ih} stroke="#e2e8f0" strokeWidth={1} />
            <text x={x(m)} y={P.top + ih + 16} textAnchor="middle" fontSize={10} fill="#64748b">{m.slice(0, 4)}</text>
          </g>
        ))}
        {yTicks.map((v) => (
          <g key={`gy${v}`}>
            <line x1={P.left} y1={y(v)} x2={P.left + iw} y2={y(v)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={P.left - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="#64748b">{PCT(v, 0)}</text>
          </g>
        ))}

        {series.map((s) => {
          const d = s.months
            .map((m, i) => `${i === 0 ? "M" : "L"}${x(m)},${y(s.drawdown[i]!)}`)
            .join(" ");
          return (
            <path key={s.assetId} d={d} stroke={ASSET_COLOR[s.assetId] ?? "#94a3b8"} strokeWidth={1.4} fill="none" opacity={0.85} />
          );
        })}

        {series.map((s, i) => (
          <g key={`leg${s.assetId}`}>
            <line x1={P.left + iw + 10} y1={P.top + 12 + i * 16} x2={P.left + iw + 25} y2={P.top + 12 + i * 16} stroke={ASSET_COLOR[s.assetId] ?? "#94a3b8"} strokeWidth={2} />
            <text x={P.left + iw + 30} y={P.top + 15 + i * 16} fontSize={10} fill="#334155">
              {SHORT_NAME[s.assetId] ?? assetById[s.assetId]?.name.split(" ")[0]}
            </text>
          </g>
        ))}

        <text x={14} y={P.top + ih / 2} transform={`rotate(-90 14 ${P.top + ih / 2})`} textAnchor="middle" fontSize={11} fill="#334155">
          Drawdown from peak
        </text>
      </svg>
    </div>
  );
}

// ─────────────────────── Interactive builder ───────────────────────

function InteractiveBuilder({
  result,
  assetById,
  riskFreeRate,
  respectMin,
  overrides,
  capital,
  minInvOverrides,
  historyWindowStart,
}: {
  result: OptimizeResponse;
  assetById: Record<string, FundAsset>;
  riskFreeRate: number;
  respectMin: boolean;
  overrides: Record<string, AssumptionOverrideIn>;
  capital: number;
  minInvOverrides: Record<string, number>;
  historyWindowStart: string | null;
}) {
  const ids = result.stats.map((s) => s.assetId);

  // Seed weights from Max Sharpe by default.
  const [weights, setWeights] = useState<Record<string, number>>(() => {
    const w: Record<string, number> = {};
    ids.forEach((id) => (w[id] = result.maxSharpe.weights[id] ?? 0));
    return w;
  });

  const [live, setLive] = useState<CustomPortfolioResponse | null>(null);
  const [pending, setPending] = useState(false);

  // Debounced scoring on weight change.
  useEffect(() => {
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    if (total <= 0) return;
    setPending(true);
    const t = setTimeout(() => {
      scoreCustomPortfolio({
        weights,
        riskFreeRate,
        totalCapital: capital,
        respectMinInvestment: respectMin,
        historyWindowStart,
        benchmarkAssetId: result.benchmarkAssetId,
        netOfFees: true,
        overrides: Object.values(overrides),
        minInvestmentOverrides: Object.entries(minInvOverrides).map(([assetId, minInvestment]) => ({ assetId, minInvestment })),
      })
        .then((r) => setLive(r))
        .finally(() => setPending(false));
    }, 200);
    return () => clearTimeout(t);
  }, [weights, riskFreeRate, capital, respectMin, overrides, minInvOverrides, historyWindowStart, result.benchmarkAssetId]);

  const seedFrom = (preset: PortfolioPoint) => {
    const w: Record<string, number> = {};
    ids.forEach((id) => (w[id] = preset.weights[id] ?? 0));
    setWeights(w);
  };

  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  const normalised = total > 0 ? Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / total])) : weights;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          <button style={S.pillBtn} onClick={() => seedFrom(result.maxSharpe)}>Seed: Max Sharpe</button>
          <button style={S.pillBtn} onClick={() => seedFrom(result.maxSortino)}>Seed: Max Sortino</button>
          <button style={S.pillBtn} onClick={() => seedFrom(result.maxInformationRatio)}>Seed: Max IR</button>
          <button style={S.pillBtn} onClick={() => seedFrom(result.minVariance)}>Seed: Min Var</button>
          <button style={S.pillBtn} onClick={() => seedFrom(result.minDrawdown)}>Seed: Min DD</button>
          {result.currentTotal > 0 && (
            <button
              style={{ ...S.pillBtn, background: "#dbeafe", borderColor: "#93c5fd" }}
              onClick={() => {
                const w: Record<string, number> = {};
                for (const id of ids) w[id] = (result.currentInvestments[id] ?? 0) / result.totalCapital;
                setWeights(w);
              }}
              title="Seed sliders from your current allocation (as % of total portfolio)"
            >
              Seed: Current
            </button>
          )}
          <button style={S.pillBtn} onClick={() => setWeights(Object.fromEntries(ids.map((id) => [id, 1 / ids.length])))}>Equal weight</button>
          <button style={S.pillBtn} onClick={() => setWeights(Object.fromEntries(ids.map((id) => [id, 0])))}>Zero</button>
        </div>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Asset</th>
              <th style={{ ...S.th, width: "50%" }}>Weight</th>
              <th style={S.thNum}>%</th>
              <th style={S.thNum}>$</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const w = normalised[id] ?? 0;
              return (
                <tr key={id}>
                  <td style={{ ...S.td, color: ASSET_COLOR[id], fontWeight: 600 }}>
                    {SHORT_NAME[id] ?? assetById[id]?.name.split(" ")[0]}
                  </td>
                  <td style={S.td}>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={0.5}
                      value={weights[id]! * 100 || 0}
                      onChange={(e) => {
                        const v = Number(e.target.value) / 100;
                        setWeights({ ...weights, [id]: v });
                      }}
                      style={{ width: "100%", accentColor: ASSET_COLOR[id] }}
                    />
                  </td>
                  <td style={S.tdNum}>{PCT(w, 1)}</td>
                  <td style={S.tdNum}>{CURRENCY(w * capital)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        {live && (
          <>
            <div style={S.statGridWide}>
              <Stat label="Return" value={PCT(live.portfolio.annualisedReturn)} />
              <Stat label="Vol" value={PCT(live.portfolio.annualisedVol)} />
              <Stat label="Sharpe" value={live.portfolio.sharpe.toFixed(2)} />
              <Stat label="Sortino" value={live.portfolio.sortino !== 0 ? live.portfolio.sortino.toFixed(2) : "—"} />
              <Stat label="IR (vs SPY)" value={live.portfolio.informationRatio !== 0 ? live.portfolio.informationRatio.toFixed(2) : "—"} />
              <Stat label="Max DD" value={live.portfolio.maxDrawdown < -0.0001 ? PCT(live.portfolio.maxDrawdown) : "0.0%"} />
            </div>
            {live.portfolio.violatesMinInvestment.length > 0 && (
              <div style={{ ...S.warn, marginTop: 6 }}>
                ⚠ {live.portfolio.violatesMinInvestment.length} allocation(s) below ticket-size minimum
              </div>
            )}
            <CustomEquityChart response={live} />
          </>
        )}
        {pending && !live && <div style={S.hint}>Scoring…</div>}
      </div>
    </div>
  );
}

/** "Nice" ticks for a log-scale axis: 1–2–5 mantissas per decade, refined
 *  if the visible range is too narrow to yield ≥4 ticks; linear fallback
 *  for very tight ranges (e.g. a 2-year window hovering around $1). */
function niceLogTicks(lo: number, hi: number): number[] {
  const mantissaSets = [
    [1, 2, 5],
    [1, 1.5, 2, 3, 5, 7],
    [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8],
  ];
  const kLo = Math.floor(Math.log10(lo));
  const kHi = Math.ceil(Math.log10(hi));
  for (const ms of mantissaSets) {
    const ticks: number[] = [];
    for (let k = kLo; k <= kHi; k++)
      for (const m of ms) {
        const v = m * 10 ** k;
        if (v >= lo && v <= hi) ticks.push(v);
      }
    if (ticks.length >= 4) return ticks;
  }
  const out: number[] = [];
  for (let i = 0; i <= 4; i++) out.push(Number((lo + ((hi - lo) * i) / 4).toPrecision(3)));
  return out;
}

const fmtEqTick = (v: number) =>
  "$" + (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2).replace(/0$/, "").replace(/\.$/, ""));

function CustomEquityChart({ response }: { response: CustomPortfolioResponse }) {
  const W = 640;
  const eqH = 220;
  const ddH = 110;
  const P = { top: 12, right: 24, bottom: 26, left: 64 };
  const iw = W - P.left - P.right;
  const totalH = P.top + eqH + 22 + ddH + P.bottom;

  const [hover, setHover] = useState<number | null>(null); // month index

  if (response.equity.length < 2) return null;

  const months = response.equityMonths;
  const parseMonth = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    return y! + (mm! - 1) / 12;
  };
  const xs = months.map(parseMonth);
  const xMin = xs[0]!;
  const xMax = xs[xs.length - 1]!;

  // Benchmark aligned to the portfolio window, rebased at portfolio start (from backend).
  const spy = response.benchMonths.map((m, i) => ({ month: m, eq: response.benchEquity[i]!, dd: response.benchDrawdown[i]! }));
  const benchIdxByMonth = new Map(spy.map((p, i) => [p.month, i]));

  const maxEq = Math.max(...response.equity, ...spy.map((s) => s.eq), 1);
  const minEq = Math.min(...response.equity, ...spy.map((s) => s.eq), 1);
  // No floor clamp — a portfolio that halves must stay on-scale.
  const logMin = Math.log(minEq * 0.97);
  const logMax = Math.log(maxEq * 1.06);

  const x = (m: string) => P.left + ((parseMonth(m) - xMin) / (xMax - xMin || 1)) * iw;
  const eqY = (v: number) => P.top + eqH - ((Math.log(v) - logMin) / (logMax - logMin || 1)) * eqH;

  const worstDD = Math.min(...response.drawdown, ...spy.map((s) => s.dd), -0.05) * 1.08;
  const ddTop = P.top + eqH + 22;
  const ddYY = (v: number) => ddTop + ((v - 0) / (worstDD - 0 || -1)) * ddH;

  // Grid ticks
  const yearStep = Math.max(1, Math.floor((xMax - xMin) / 6));
  const xTicks: string[] = [];
  for (let yr = Math.ceil(xMin); yr <= Math.floor(xMax); yr += yearStep) xTicks.push(`${yr}-01`);
  const eqTicks = niceLogTicks(Math.exp(logMin), Math.exp(logMax));
  const ddStep = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25].find((s) => Math.abs(worstDD) / s <= 5.5) ?? 0.25;
  const ddTicks: number[] = [];
  for (let v = 0; v >= worstDD; v -= ddStep) ddTicks.push(Number(v.toFixed(4)));

  const portfolioD = months.map((m, i) => `${i === 0 ? "M" : "L"}${x(m)},${eqY(response.equity[i]!)}`).join(" ");
  const spyD = spy.length > 0
    ? spy.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.month)},${eqY(p.eq)}`).join(" ")
    : "";
  const ddD = months.map((m, i) => `${i === 0 ? "M" : "L"}${x(m)},${ddYY(response.drawdown[i]!)}`).join(" ");
  const ddArea = months.map((m, i) => `L${x(m)},${ddYY(response.drawdown[i]!)}`).join(" ");
  const ddAreaFull = `M${x(months[0]!)},${ddYY(0)} ${ddArea} L${x(months[months.length - 1]!)},${ddYY(0)} Z`;
  const benchDdD = spy.length > 0
    ? spy.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.month)},${ddYY(p.dd)}`).join(" ")
    : "";

  // Hover interaction
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    // Find nearest month by x
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < months.length; i++) {
      const d = Math.abs(x(months[i]!) - mx);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    setHover(bestI);
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div style={S.chartLegend}>
        <span style={{ ...S.chartLegendItem, color: "#1e40af" }}>
          <span style={{ ...S.chartLegendSwatch, background: "#1e40af" }} />
          Your portfolio
        </span>
        {spy.length > 0 && (
          <span style={{ ...S.chartLegendItem, color: "#94a3b8" }}>
            <span style={{ ...S.chartLegendSwatch, background: "#94a3b8", height: 2 }} />
            {response.benchName || "S&P 500"} (from portfolio start)
          </span>
        )}
        <span style={{ ...S.chartLegendItem, color: "#dc2626" }}>
          <span style={{ ...S.chartLegendSwatch, background: "#dc2626", opacity: 0.4 }} />
          Portfolio drawdown
        </span>
        {spy.length > 0 && (
          <span style={{ ...S.chartLegendItem, color: "#94a3b8" }}>
            <span style={{ ...S.chartLegendSwatch, background: "#94a3b8", height: 2 }} />
            Index drawdown
          </span>
        )}
      </div>
      <svg
        width={W}
        height={totalH}
        style={{ display: "block", background: "#fafbfc", borderRadius: 4, cursor: "crosshair" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* ── Equity panel ── */}
        <text x={14} y={P.top + eqH / 2} transform={`rotate(-90 14 ${P.top + eqH / 2})`} textAnchor="middle" fontSize={11} fill="#334155">
          Growth of $1 (log scale)
        </text>
        {/* Y grid */}
        {eqTicks.map((v) => (
          <g key={`eqy${v}`}>
            <line x1={P.left} y1={eqY(v)} x2={P.left + iw} y2={eqY(v)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={P.left - 6} y={eqY(v) + 3} textAnchor="end" fontSize={10} fill="#64748b">
              {fmtEqTick(v)}
            </text>
          </g>
        ))}
        {/* $1 baseline emphasis */}
        <line x1={P.left} y1={eqY(1)} x2={P.left + iw} y2={eqY(1)} stroke="#cbd5e1" strokeDasharray="3,3" />
        {/* X grid */}
        {xTicks.map((m) => (
          <line key={`ex${m}`} x1={x(m)} y1={P.top} x2={x(m)} y2={P.top + eqH} stroke="#eef2f7" strokeWidth={1} />
        ))}
        {/* SPY line — grey, behind portfolio */}
        {spyD && <path d={spyD} stroke="#94a3b8" strokeWidth={1.5} fill="none" opacity={0.85} />}
        {/* Portfolio line */}
        <path d={portfolioD} stroke="#1e40af" strokeWidth={2.2} fill="none" />
        {/* Hover marker on portfolio */}
        {hover !== null && (
          <>
            <line x1={x(months[hover]!)} y1={P.top} x2={x(months[hover]!)} y2={P.top + eqH + 22 + ddH} stroke="#334155" strokeWidth={1} strokeDasharray="4,4" opacity={0.5} />
            <circle cx={x(months[hover]!)} cy={eqY(response.equity[hover]!)} r={4} fill="#1e40af" stroke="#fff" strokeWidth={2} />
            {spy.length > 0 && (() => {
              const sIdx = benchIdxByMonth.get(months[hover]!);
              if (sIdx === undefined) return null;
              return <circle cx={x(months[hover]!)} cy={eqY(spy[sIdx]!.eq)} r={3.5} fill="#94a3b8" stroke="#fff" strokeWidth={1.5} />;
            })()}
          </>
        )}

        {/* Panel divider */}
        <line x1={P.left} y1={P.top + eqH + 10} x2={P.left + iw} y2={P.top + eqH + 10} stroke="#cbd5e1" strokeWidth={1} />

        {/* ── Drawdown panel ── */}
        <text x={14} y={ddTop + ddH / 2} transform={`rotate(-90 14 ${ddTop + ddH / 2})`} textAnchor="middle" fontSize={11} fill="#334155">
          Drawdown
        </text>
        {ddTicks.map((v) => (
          <g key={`ddy${v}`}>
            <line x1={P.left} y1={ddYY(v)} x2={P.left + iw} y2={ddYY(v)} stroke="#fee2e2" strokeWidth={1} />
            <text x={P.left - 6} y={ddYY(v) + 3} textAnchor="end" fontSize={10} fill="#64748b">
              {PCT(v, 0)}
            </text>
          </g>
        ))}
        {xTicks.map((m) => (
          <g key={`ddx${m}`}>
            <line x1={x(m)} y1={ddTop} x2={x(m)} y2={ddTop + ddH} stroke="#fef2f2" strokeWidth={1} />
            <text x={x(m)} y={ddTop + ddH + 14} textAnchor="middle" fontSize={10} fill="#64748b">
              {m.slice(0, 4)}
            </text>
          </g>
        ))}
        <path d={ddAreaFull} fill="#dc2626" opacity={0.15} />
        {benchDdD && <path d={benchDdD} stroke="#94a3b8" strokeWidth={1.4} fill="none" opacity={0.9} />}
        <path d={ddD} stroke="#dc2626" strokeWidth={1.6} fill="none" />
        {hover !== null && (
          <>
            <circle cx={x(months[hover]!)} cy={ddYY(response.drawdown[hover]!)} r={3.5} fill="#dc2626" stroke="#fff" strokeWidth={1.5} />
            {(() => {
              const sIdx = benchIdxByMonth.get(months[hover]!);
              if (sIdx === undefined) return null;
              return <circle cx={x(months[hover]!)} cy={ddYY(spy[sIdx]!.dd)} r={3} fill="#94a3b8" stroke="#fff" strokeWidth={1.5} />;
            })()}
          </>
        )}
      </svg>

      {/* Tooltip below the chart */}
      {hover !== null && (
        <div style={S.chartTooltip}>
          <b>{months[hover]}</b>
          <span> · portfolio {CURRENCY(response.equity[hover]!)}</span>
          <span style={{ color: "#dc2626" }}> (DD {PCT(response.drawdown[hover]!)})</span>
          {(() => {
            const sIdx = benchIdxByMonth.get(months[hover]!);
            return sIdx !== undefined ? (
              <span style={{ color: "#64748b" }}>
                {" "}· index {CURRENCY(spy[sIdx]!.eq)} (DD {PCT(spy[sIdx]!.dd)})
              </span>
            ) : null;
          })()}
        </div>
      )}

      {/* Window + max-DD caption — makes explicit what period the stats cover */}
      <div style={{ ...S.hint, marginTop: 4 }}>
        Window: {months[0]} → {months[months.length - 1]} ({months.length} mo = overlapping history of the
        selected funds). Max DD in window: portfolio{" "}
        <b style={{ color: "#dc2626" }}>{PCT(Math.min(...response.drawdown))}</b>
        {spy.length > 0 && (
          <>
            {" "}· {response.benchName || "index"} <b style={{ color: "#64748b" }}>{PCT(response.benchMaxDrawdown)}</b>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────── Correlation matrix ───────────────────────

function CorrelationMatrix({
  result,
  assetById,
}: {
  result: OptimizeResponse;
  assetById: Record<string, FundAsset>;
}) {
  const ids = result.stats.map((s) => s.assetId);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={S.table}>
        <thead>
          <tr>
            <th />
            {ids.map((id) => (
              <th key={id} style={{ ...S.th, fontSize: "0.7rem", writingMode: "vertical-rl", transform: "rotate(180deg)", padding: "8px 4px" }}>
                {SHORT_NAME[id] ?? assetById[id]?.name.split(" ")[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ids.map((i) => (
            <tr key={i}>
              <td style={{ ...S.td, fontSize: "0.75rem", fontWeight: 600, color: ASSET_COLOR[i] }}>
                {SHORT_NAME[i] ?? assetById[i]?.name.split(" ")[0]}
              </td>
              {ids.map((j) => {
                const r = result.correlation[i][j];
                return (
                  <td key={j} style={{
                    ...S.tdNum,
                    background: corrColor(r),
                    color: Math.abs(r) > 0.5 ? "white" : "#334155",
                    fontWeight: i === j ? 700 : 500,
                    fontSize: "0.72rem",
                  }}>
                    {r.toFixed(2)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function corrColor(r: number): string {
  if (r >= 0.8) return "#dc2626";
  if (r >= 0.5) return "#f97316";
  if (r >= 0.2) return "#fde047";
  if (r >= -0.2) return "#f1f5f9";
  if (r >= -0.5) return "#93c5fd";
  return "#3b82f6";
}

// ─── styles ─────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  page: { padding: 24, maxWidth: 1400, margin: "0 auto", fontFamily: "system-ui, -apple-system, sans-serif" },
  header: { marginBottom: 20 },
  grid: { display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginBottom: 16 },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 },
  grid4: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 },
  grid5: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 16 },
  card: {
    background: "white",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  },
  cardTall: { background: "white", border: "1px solid #e2e8f0", borderRadius: 8, padding: 16, marginBottom: 16 },
  h2: { margin: "0 0 8px", fontSize: "1rem" },
  hint: { fontSize: "0.72rem", color: "#64748b", margin: "0 0 12px" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" },
  th: { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #e2e8f0", fontSize: "0.72rem", color: "#475569", fontWeight: 600 },
  thNum: { textAlign: "right", padding: "6px 8px", borderBottom: "1px solid #e2e8f0", fontSize: "0.72rem", color: "#475569", fontWeight: 600 },
  td: { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" },
  tdNum: { padding: "6px 8px", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontVariantNumeric: "tabular-nums" },
  tdNumMuted: { padding: "6px 8px", borderBottom: "1px solid #f1f5f9", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "#94a3b8", fontSize: "0.72rem" },
  rowOn: { background: "white" },
  rowOff: { background: "#f8fafc", opacity: 0.7 },
  chipRow: { display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap", alignItems: "center" },
  chip: { display: "inline-block", padding: "1px 6px", borderRadius: 999, color: "white", fontSize: "0.62rem", fontWeight: 600 },
  chipMuted: { fontSize: "0.7rem", color: "#64748b" },
  label: { display: "flex", flexDirection: "column", gap: 3, marginBottom: 12, fontSize: "0.78rem", color: "#334155" },
  labelRow: { display: "flex", gap: 6, alignItems: "center", marginBottom: 6, fontSize: "0.8rem", color: "#334155" },
  input: { padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: "0.85rem", fontFamily: "inherit" },
  primaryBtn: {
    marginTop: 12,
    padding: "10px 16px",
    background: "#1e40af",
    color: "white",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: "0.85rem",
    fontWeight: 600,
    width: "100%",
  },
  pillBtn: {
    padding: "4px 10px",
    background: "#e0e7ff",
    color: "#1e40af",
    border: "1px solid #c7d2fe",
    borderRadius: 999,
    cursor: "pointer",
    fontSize: "0.7rem",
    fontWeight: 600,
  },
  warn: { color: "#b45309", fontSize: "0.7rem", marginTop: 4 },
  err: { background: "#fee2e2", color: "#991b1b", padding: 12, borderRadius: 6, marginBottom: 16 },
  statGrid: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, marginBottom: 8 },
  statGridSmall: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, marginBottom: 8 },
  statGridWide: { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6, marginBottom: 6 },
  stat: { background: "#f8fafc", borderRadius: 4, padding: "4px 6px" },
  statLabel: { fontSize: "0.6rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.3 },
  statValue: { fontSize: "0.95rem", fontWeight: 700, color: "#0f172a", fontVariantNumeric: "tabular-nums" },
  warnPill: { display: "inline-block", background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 999, fontSize: "0.65rem", fontWeight: 700 },
  banner: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "#eef2ff",
    border: "1px solid #c7d2fe",
    borderRadius: 6,
    padding: "8px 14px",
    fontSize: "0.78rem",
    color: "#312e81",
    marginBottom: 12,
  },
  summaryBox: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    padding: "8px 10px",
    marginBottom: 12,
    fontSize: "0.75rem",
  },
  summaryRow: { display: "flex", justifyContent: "space-between", padding: "2px 0", color: "#334155" },
  summaryVal: { fontVariantNumeric: "tabular-nums", fontWeight: 500 },
  chartLegend: {
    display: "flex",
    gap: 16,
    marginBottom: 6,
    fontSize: "0.7rem",
    color: "#334155",
    padding: "0 4px",
  },
  chartLegendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontWeight: 500,
  },
  chartLegendSwatch: {
    display: "inline-block",
    width: 14,
    height: 3,
    borderRadius: 2,
  },
  calloutInfo: {
    background: "#fef3c7",
    border: "1px solid #fde68a",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: "0.72rem",
    color: "#92400e",
    marginTop: 6,
    marginBottom: 8,
    lineHeight: 1.55,
  },
  forcedPill: {
    display: "inline-block",
    background: "#e0e7ff",
    color: "#3730a3",
    padding: "1px 6px",
    borderRadius: 999,
    fontSize: "0.6rem",
    fontWeight: 700,
  },
  floorHint: {
    fontSize: "0.6rem",
    color: "#7c3aed",
    fontFamily: "monospace",
    fontStyle: "italic",
    lineHeight: 1,
  },
  chartTooltip: {
    marginTop: 4,
    padding: "5px 10px",
    background: "#f1f5f9",
    borderRadius: 4,
    fontSize: "0.72rem",
    color: "#334155",
    fontVariantNumeric: "tabular-nums",
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
};
