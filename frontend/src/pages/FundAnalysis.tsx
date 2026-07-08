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
  optimizePortfolio,
  scoreCustomPortfolio,
  type AssetSeries,
  type AssumptionOverrideIn,
  type CustomPortfolioResponse,
  type FundAsset,
  type MaxWeightIn,
  type OptimizeResponse,
  type PortfolioPoint,
} from "../api/fundAnalysis";

// Sensible priors for short-history / illiquid assets.
const DEFAULT_OVERRIDES: Record<string, AssumptionOverrideIn> = {
  primary_commodity: {
    assetId: "primary_commodity",
    annualisedReturn: 0.15,
    annualisedVol: 0.28,
    correlationCap: 0.3,
  },
};

// Default concentration cap on CAS Sosin — extreme 2022 drawdown (-77%)
// warrants a hard ceiling by default. User can raise or remove.
const DEFAULT_MAX_WEIGHTS: MaxWeightIn[] = [
  { assetId: "cas_sosin", maxWeight: 0.20 },
];

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
  spy: "S&P 500",
  agg: "US Bonds",
};

export function FundAnalysis() {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(["gator", "bireme", "upslope", "primary_commodity", "cedar_creek", "cas_sosin", "alluvial", "spy", "agg"]),
  );
  const [capital, setCapital] = useState<number>(5_000_000);
  const [riskFreeRate, setRiskFreeRate] = useState<number>(0.04);
  const [respectMin, setRespectMin] = useState<boolean>(true);
  const [overrides, setOverrides] = useState<Record<string, AssumptionOverrideIn>>(DEFAULT_OVERRIDES);
  const [maxWeights, setMaxWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(DEFAULT_MAX_WEIGHTS.map((m) => [m.assetId, m.maxWeight])),
  );
  // Per-asset min-investment overrides — undefined = use catalog default.
  const [minInvOverrides, setMinInvOverrides] = useState<Record<string, number>>({});

  const assetsQuery = useQuery({
    queryKey: ["fund-analysis", "assets"],
    queryFn: fetchFundAssets,
    staleTime: Infinity,
  });

  const optimizeMutation = useMutation({ mutationFn: optimizePortfolio });

  const runOptimize = () => {
    optimizeMutation.mutate({
      assetIds: [...selected],
      totalCapital: capital,
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
                    </td>
                    <td style={S.tdNum}>{PCT(a.annualisedReturn)}</td>
                    <td style={S.tdNum}>{PCT(a.annualisedVol)}</td>
                    <td style={S.tdNum}>{a.nMonths}</td>
                    <td style={S.tdNum}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                        <input
                          type="number"
                          value={eff}
                          min={0}
                          step={50_000}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setMinInv(a.id, Number.isFinite(v) && v >= 0 ? v : null);
                          }}
                          style={{ ...S.input, width: 130, textAlign: "right", background: overridden ? "#fef3c7" : undefined }}
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section style={S.cardTall}>
          <h2 style={S.h2}>Portfolio inputs</h2>
          <label style={S.label}>
            Total investable capital
            <input
              type="number"
              value={capital}
              min={100_000}
              step={100_000}
              onChange={(e) => setCapital(Math.max(100_000, Number(e.target.value) || 100_000))}
              style={S.input}
            />
            <span style={S.hint}>{CURRENCY(capital)}</span>
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
          <p style={S.hint}>
            When on, portfolios that allocate less than a fund's ticket-size to that fund are
            flagged as infeasible.
          </p>

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

      {result && <ResultView result={result} assetById={assetById} riskFreeRate={riskFreeRate} respectMin={respectMin} overrides={overrides} capital={capital} minInvOverrides={minInvOverrides} />}
      {optimizeMutation.isError && (
        <div style={S.err}>{(optimizeMutation.error as Error).message}</div>
      )}
    </div>
  );
}

function Header({ asOf }: { asOf: string | undefined }) {
  return (
    <header style={S.header}>
      <div>
        <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
          <a href="/" style={{ color: "#1e40af", textDecoration: "none" }}>← Back to Exposure Eclipse</a>
        </div>
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>Fund Portfolio Optimizer</h1>
        <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: "0.8rem" }}>
          Markowitz efficient frontier + interactive builder across 7 hedge funds + S&P 500 + US Aggregate Bonds.
          {asOf && <> · Data as of <b>{asOf}</b>.</>}
        </p>
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

function ResultView({
  result,
  assetById,
  riskFreeRate,
  respectMin,
  overrides,
  capital,
  minInvOverrides,
}: {
  result: OptimizeResponse;
  assetById: Record<string, FundAsset>;
  riskFreeRate: number;
  respectMin: boolean;
  overrides: Record<string, AssumptionOverrideIn>;
  capital: number;
  minInvOverrides: Record<string, number>;
}) {
  return (
    <>
      <section style={S.card}>
        <h2 style={S.h2}>Efficient frontier</h2>
        <p style={S.hint}>Each dot = one random portfolio; curve = Pareto-optimal set. Red = Max Sharpe, purple = Max Sortino, green = Min Variance, teal = Min Drawdown, grey = individual assets.</p>
        <FrontierChart result={result} assetById={assetById} />
      </section>

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

      <div style={S.grid4}>
        <PortfolioCard title="Max Sharpe" subtitle="Best risk-adjusted (vs. RF)" portfolio={result.maxSharpe} totalCapital={result.totalCapital} assetById={assetById} accent="#dc2626" />
        <PortfolioCard title="Max Sortino" subtitle="Best downside-adjusted" portfolio={result.maxSortino} totalCapital={result.totalCapital} assetById={assetById} accent="#7c3aed" />
        <PortfolioCard title="Min Variance" subtitle="Lowest vol" portfolio={result.minVariance} totalCapital={result.totalCapital} assetById={assetById} accent="#059669" />
        <PortfolioCard title="Min Drawdown" subtitle="Smallest historical loss" portfolio={result.minDrawdown} totalCapital={result.totalCapital} assetById={assetById} accent="#0891b2" />
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
        />
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>Correlation matrix</h2>
        <p style={S.hint}>Pearson ρ over each pair's overlapping monthly history; correlation-cap overrides applied where set.</p>
        <CorrelationMatrix result={result} assetById={assetById} />
      </section>

      <section style={S.card}>
        <h2 style={S.h2}>Asset stats (post-override)</h2>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Asset</th>
              <th style={S.thNum}>μ (ann)</th>
              <th style={S.thNum}>σ (ann)</th>
              <th style={S.thNum}>Sharpe</th>
              <th style={S.thNum}>Max DD</th>
              <th style={S.thNum}>Empirical μ</th>
              <th style={S.thNum}>Empirical σ</th>
              <th style={S.thNum}>Months</th>
              <th style={S.thNum}>Overridden?</th>
            </tr>
          </thead>
          <tbody>
            {result.stats.map((s) => {
              const sharpe =
                s.annualisedVol > 0 ? (s.annualisedReturn - result.riskFreeRate) / s.annualisedVol : 0;
              const seriesForAsset = result.assetSeries.find((x) => x.assetId === s.assetId);
              return (
                <tr key={s.assetId}>
                  <td style={S.td}>{assetById[s.assetId]?.name ?? s.assetId}</td>
                  <td style={S.tdNum}>{PCT(s.annualisedReturn)}</td>
                  <td style={S.tdNum}>{PCT(s.annualisedVol)}</td>
                  <td style={S.tdNum}>{sharpe.toFixed(2)}</td>
                  <td style={{ ...S.tdNum, color: "#dc2626" }}>{PCT(seriesForAsset?.maxDrawdown ?? 0)}</td>
                  <td style={S.tdNumMuted}>{PCT(s.empiricalReturn)}</td>
                  <td style={S.tdNumMuted}>{PCT(s.empiricalVol)}</td>
                  <td style={S.tdNum}>{s.nMonths}</td>
                  <td style={S.tdNum}>{s.isOverridden ? "✓" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

function PortfolioCard({
  title,
  subtitle,
  portfolio,
  totalCapital,
  assetById,
  accent,
}: {
  title: string;
  subtitle: string;
  portfolio: PortfolioPoint;
  totalCapital: number;
  assetById: Record<string, FundAsset>;
  accent: string;
}) {
  const sortedWeights = Object.entries(portfolio.weights)
    .filter(([, w]) => w > 0.005)
    .sort(([, a], [, b]) => b - a);
  const violators = new Set(portfolio.violatesMinInvestment);
  return (
    <section style={{ ...S.card, borderTop: `3px solid ${accent}`, marginBottom: 0 }}>
      <h2 style={{ ...S.h2, color: accent }}>{title}</h2>
      <p style={S.hint}>{subtitle}</p>
      <div style={S.statGrid}>
        <Stat label="Return" value={PCT(portfolio.annualisedReturn)} />
        <Stat label="Vol" value={PCT(portfolio.annualisedVol)} />
        <Stat label="Sharpe" value={portfolio.sharpe.toFixed(2)} />
        <Stat label="Sortino" value={portfolio.sortino > 0 ? portfolio.sortino.toFixed(2) : "—"} />
        <Stat label="Max DD" value={portfolio.maxDrawdown < 0 ? PCT(portfolio.maxDrawdown) : "—"} />
      </div>
      <table style={S.table}>
        <tbody>
          {sortedWeights.map(([id, w]) => (
            <tr key={id}>
              <td style={{ ...S.td, color: ASSET_COLOR[id] }}>{SHORT_NAME[id] ?? id}</td>
              <td style={S.tdNum}>{PCT(w, 1)}</td>
              <td style={S.tdNum}>{CURRENCY(w * totalCapital)}</td>
              <td style={S.tdNum}>
                {violators.has(id) ? (
                  <span style={S.warnPill} title={`Below min ${CURRENCY(assetById[id]?.minInvestment ?? 0)}`}>
                    ⚠
                  </span>
                ) : null}
              </td>
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

  const points = [...result.frontier, result.maxSharpe, result.maxSortino, result.minVariance, result.minDrawdown];
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
        <FrontierMarker x={x(result.minVariance.annualisedVol)} y={y(result.minVariance.annualisedReturn)} label="Min Var" color="#059669" />
        <FrontierMarker x={x(result.minDrawdown.annualisedVol)} y={y(result.minDrawdown.annualisedReturn)} label="Min DD" color="#0891b2" dy={14} />
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
}: {
  result: OptimizeResponse;
  assetById: Record<string, FundAsset>;
  riskFreeRate: number;
  respectMin: boolean;
  overrides: Record<string, AssumptionOverrideIn>;
  capital: number;
  minInvOverrides: Record<string, number>;
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
        overrides: Object.values(overrides),
        minInvestmentOverrides: Object.entries(minInvOverrides).map(([assetId, minInvestment]) => ({ assetId, minInvestment })),
      })
        .then((r) => setLive(r))
        .finally(() => setPending(false));
    }, 200);
    return () => clearTimeout(t);
  }, [weights, riskFreeRate, capital, respectMin, overrides, minInvOverrides]);

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
          <button style={S.pillBtn} onClick={() => seedFrom(result.minVariance)}>Seed: Min Var</button>
          <button style={S.pillBtn} onClick={() => seedFrom(result.minDrawdown)}>Seed: Min DD</button>
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
              <Stat label="Sortino" value={live.portfolio.sortino > 0 ? live.portfolio.sortino.toFixed(2) : "—"} />
              <Stat label="Max DD" value={live.portfolio.maxDrawdown < 0 ? PCT(live.portfolio.maxDrawdown) : "—"} />
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

function CustomEquityChart({ response }: { response: CustomPortfolioResponse }) {
  const W = 540;
  const H = 250;
  const P = { top: 10, right: 20, bottom: 30, left: 55 };
  const iw = W - P.left - P.right;
  const ih = H - P.top - P.bottom;

  if (response.equity.length < 2) return null;

  const parseMonth = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    return y! + (mm! - 1) / 12;
  };
  const xs = response.equityMonths.map(parseMonth);
  const xMin = xs[0]!;
  const xMax = xs[xs.length - 1]!;
  const maxEq = Math.max(...response.equity, 1);

  const x = (m: string) => P.left + ((parseMonth(m) - xMin) / (xMax - xMin || 1)) * iw;
  const y = (v: number) => P.top + ih - (Math.log(v) / Math.log(maxEq)) * ih;

  const equityD = response.equityMonths
    .map((m, i) => `${i === 0 ? "M" : "L"}${x(m)},${y(response.equity[i]!)}`)
    .join(" ");

  const worstDD = Math.min(...response.drawdown, -0.05);
  const yDD = (v: number) => P.top + ih - ((v - worstDD) / (-worstDD)) * ih;
  const ddD = response.equityMonths
    .map((m, i) => `${i === 0 ? "M" : "L"}${x(m)},${yDD(response.drawdown[i]!)}`)
    .join(" ");

  return (
    <svg width={W} height={H} style={{ display: "block", background: "#fafbfc", marginTop: 12 }}>
      <text x={14} y={P.top + ih / 2} transform={`rotate(-90 14 ${P.top + ih / 2})`} textAnchor="middle" fontSize={11} fill="#334155">
        Equity growth (log)
      </text>
      <path d={equityD} stroke="#1e40af" strokeWidth={2} fill="none" />
      <path d={ddD} stroke="#dc2626" strokeWidth={1} fill="none" opacity={0.55} strokeDasharray="2,2" />
      <text x={P.left + iw - 5} y={P.top + 14} textAnchor="end" fontSize={10} fill="#1e40af">Growth of $1 ↑</text>
      <text x={P.left + iw - 5} y={P.top + ih - 6} textAnchor="end" fontSize={10} fill="#dc2626">Drawdown ↓</text>
    </svg>
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
  statGridWide: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 6 },
  stat: { background: "#f8fafc", borderRadius: 4, padding: "4px 6px" },
  statLabel: { fontSize: "0.6rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.3 },
  statValue: { fontSize: "0.95rem", fontWeight: 700, color: "#0f172a", fontVariantNumeric: "tabular-nums" },
  warnPill: { display: "inline-block", background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 999, fontSize: "0.65rem", fontWeight: 700 },
};
