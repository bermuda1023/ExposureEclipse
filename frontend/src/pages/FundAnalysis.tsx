/**
 * Fund Analysis page — Markowitz efficient frontier across the six live-
 * manager funds + SPY + AGG (bonds).
 *
 * The user picks a subset, sets total capital (drives the minimum-
 * investment feasibility constraint), and can override each asset's
 * assumed annualised return / vol / correlation cap. The last three
 * matter a lot for the Primary Commodity Fund, whose 18-month history
 * would otherwise produce artificially confident stats.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  fetchFundAssets,
  optimizePortfolio,
  type AssumptionOverrideIn,
  type FundAsset,
  type OptimizeResponse,
  type PortfolioPoint,
} from "../api/fundAnalysis";

// Sensible priors for short-track-record / illiquid assets. Applied by
// default; users can clear/edit them in the overrides section.
const DEFAULT_OVERRIDES: Record<string, AssumptionOverrideIn> = {
  primary_commodity: {
    assetId: "primary_commodity",
    // 18 months of near-linear returns → real physical-metals funds
    // realistically show 15-20% expected + 25-30% vol; correlation to
    // equities capped at 0.3 since niche metals really don't co-move
    // with mainstream cycles.
    annualisedReturn: 0.15,
    annualisedVol: 0.28,
    correlationCap: 0.3,
  },
};

const CURRENCY = (v: number) =>
  v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const PCT = (v: number, digits = 1) =>
  `${(v * 100).toFixed(digits)}%`;

const KIND_LABEL: Record<string, string> = {
  hedge_fund: "Hedge Fund",
  reference: "Reference",
};

const KIND_TINT: Record<string, string> = {
  hedge_fund: "#3b82f6",
  reference: "#94a3b8",
};

export function FundAnalysis() {
  // ─── inputs ───────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(
    new Set(["gator", "bireme", "upslope", "primary_commodity", "cedar_creek", "alluvial", "spy", "agg"]),
  );
  const [capital, setCapital] = useState<number>(5_000_000);
  const [riskFreeRate, setRiskFreeRate] = useState<number>(0.04);
  const [respectMin, setRespectMin] = useState<boolean>(true);
  const [overrides, setOverrides] = useState<Record<string, AssumptionOverrideIn>>(DEFAULT_OVERRIDES);

  const assetsQuery = useQuery({
    queryKey: ["fund-analysis", "assets"],
    queryFn: fetchFundAssets,
    staleTime: Infinity,
  });

  const optimizeMutation = useMutation({
    mutationFn: optimizePortfolio,
  });

  const runOptimize = () => {
    optimizeMutation.mutate({
      assetIds: [...selected],
      totalCapital: capital,
      riskFreeRate,
      respectMinInvestment: respectMin,
      overrides: Object.values(overrides).filter((o) => selected.has(o.assetId)),
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
                <th style={S.thNum}>μ (ann)</th>
                <th style={S.thNum}>σ (ann)</th>
                <th style={S.thNum}>Months</th>
                <th style={S.thNum}>Min Investment</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id} style={selected.has(a.id) ? S.rowOn : S.rowOff}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                    />
                  </td>
                  <td style={S.td}>
                    <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>{a.name}</div>
                    <div style={S.chipRow}>
                      <span style={{ ...S.chip, background: KIND_TINT[a.kind] }}>
                        {KIND_LABEL[a.kind]}
                      </span>
                      <span style={S.chipMuted}>{a.strategy}</span>
                    </div>
                    {a.warning && <div style={S.warn}>{a.warning}</div>}
                  </td>
                  <td style={S.tdNum}>{PCT(a.annualisedReturn)}</td>
                  <td style={S.tdNum}>{PCT(a.annualisedVol)}</td>
                  <td style={S.tdNum}>{a.nMonths}</td>
                  <td style={S.tdNum}>{CURRENCY(a.minInvestment)}</td>
                </tr>
              ))}
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
            <span style={S.hint}>{PCT(riskFreeRate)} — used for Sharpe</span>
          </label>

          <label style={S.labelRow}>
            <input
              type="checkbox"
              checked={respectMin}
              onChange={(e) => setRespectMin(e.target.checked)}
            />
            Respect fund minimum investments
          </label>
          <p style={S.hint}>
            When on, portfolios that allocate less than a fund's ticket-size to that fund are flagged as
            infeasible. Turn off to explore unconstrained frontiers.
          </p>

          <button
            type="button"
            onClick={runOptimize}
            disabled={selected.size < 2 || optimizeMutation.isPending}
            style={S.primaryBtn}
          >
            {optimizeMutation.isPending ? "Optimising…" : `Run optimizer (${selected.size} assets)`}
          </button>
          {selected.size < 2 && (
            <p style={S.warn}>Pick at least 2 assets to run the optimizer.</p>
          )}
        </section>

        <section style={S.card}>
          <h2 style={S.h2}>Assumption overrides</h2>
          <p style={S.hint}>
            Empirical stats can mislead for short track records or illiquid physical assets.
            Set assumed values below to override the empirical estimates; leave blank to use the
            transcribed history. Correlation cap limits |ρ| between this asset and any other.
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
      </div>

      {result && <ResultView result={result} assetById={assetById} />}
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
        <div style={{ fontSize: "0.75rem", color: "var(--ink-500)" }}>
          <a href="/" style={{ color: "var(--brand-700)", textDecoration: "none" }}>← Back to Exposure Eclipse</a>
        </div>
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>Fund Portfolio Optimizer</h1>
        <p style={{ margin: "4px 0 0", color: "var(--ink-500)", fontSize: "0.8rem" }}>
          Markowitz mean-variance frontier across 6 hedge funds + S&P 500 + US Aggregate Bonds.
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
        style={{ ...S.input, width: 70, textAlign: "right" }}
      />
      <span style={{ fontSize: "0.7rem", color: "var(--ink-500)" }}>%</span>
    </div>
  );
}

function ResultView({
  result,
  assetById,
}: {
  result: OptimizeResponse;
  assetById: Record<string, FundAsset>;
}) {
  return (
    <>
      <section style={S.card}>
        <h2 style={S.h2}>Efficient frontier</h2>
        <FrontierChart result={result} assetById={assetById} />
      </section>

      <div style={S.grid2}>
        <PortfolioCard
          title="Max Sharpe (tangency)"
          subtitle={`Best risk-adjusted return at ${PCT(result.riskFreeRate)} risk-free.`}
          portfolio={result.maxSharpe}
          totalCapital={result.totalCapital}
          assetById={assetById}
        />
        <PortfolioCard
          title="Minimum variance"
          subtitle="Lowest-volatility feasible portfolio."
          portfolio={result.minVariance}
          totalCapital={result.totalCapital}
          assetById={assetById}
        />
      </div>

      <section style={S.card}>
        <h2 style={S.h2}>Correlation matrix</h2>
        <p style={S.hint}>Pearson ρ over each pair's overlapping monthly history. Correlation-cap overrides applied where set.</p>
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
              <th style={S.thNum}>Empirical μ</th>
              <th style={S.thNum}>Empirical σ</th>
              <th style={S.thNum}>Months</th>
              <th style={S.thNum}>Overridden?</th>
            </tr>
          </thead>
          <tbody>
            {result.stats.map((s) => {
              const sharpe = s.annualisedVol > 0
                ? (s.annualisedReturn - result.riskFreeRate) / s.annualisedVol
                : 0;
              return (
                <tr key={s.assetId}>
                  <td style={S.td}>{assetById[s.assetId]?.name ?? s.assetId}</td>
                  <td style={S.tdNum}>{PCT(s.annualisedReturn)}</td>
                  <td style={S.tdNum}>{PCT(s.annualisedVol)}</td>
                  <td style={S.tdNum}>{sharpe.toFixed(2)}</td>
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
}: {
  title: string;
  subtitle: string;
  portfolio: PortfolioPoint;
  totalCapital: number;
  assetById: Record<string, FundAsset>;
}) {
  const sortedWeights = Object.entries(portfolio.weights)
    .filter(([, w]) => w > 0.001)
    .sort(([, a], [, b]) => b - a);

  const violators = new Set(portfolio.violatesMinInvestment);

  return (
    <section style={S.card}>
      <h2 style={S.h2}>{title}</h2>
      <p style={S.hint}>{subtitle}</p>
      <div style={S.statRow}>
        <Stat label="Ann. return" value={PCT(portfolio.annualisedReturn)} />
        <Stat label="Ann. volatility" value={PCT(portfolio.annualisedVol)} />
        <Stat label="Sharpe ratio" value={portfolio.sharpe.toFixed(2)} />
      </div>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Asset</th>
            <th style={S.thNum}>Weight</th>
            <th style={S.thNum}>Allocation</th>
            <th style={S.th}>Feasibility</th>
          </tr>
        </thead>
        <tbody>
          {sortedWeights.map(([id, w]) => {
            const asset = assetById[id];
            const allocation = w * totalCapital;
            const viol = violators.has(id);
            return (
              <tr key={id}>
                <td style={S.td}>{asset?.name ?? id}</td>
                <td style={S.tdNum}>{PCT(w, 1)}</td>
                <td style={S.tdNum}>{CURRENCY(allocation)}</td>
                <td style={S.td}>
                  {viol ? (
                    <span style={S.warnPill}>
                      below min {CURRENCY(asset?.minInvestment ?? 0)}
                    </span>
                  ) : (
                    <span style={S.okPill}>ok</span>
                  )}
                </td>
              </tr>
            );
          })}
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

/** Frontier scatter — SVG, no chart library. Plots the efficient frontier
 * curve, marks max-Sharpe and min-variance, and dots each individual asset
 * so the user can see how much diversification adds. */
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

  const points = [
    ...result.frontier,
    result.maxSharpe,
    result.minVariance,
  ];
  const assetDots = result.stats.map((s) => ({
    id: s.assetId,
    vol: s.annualisedVol,
    ret: s.annualisedReturn,
  }));

  const allVols = [...points.map((p) => p.annualisedVol), ...assetDots.map((d) => d.vol)];
  const allRets = [...points.map((p) => p.annualisedReturn), ...assetDots.map((d) => d.ret)];

  const volMax = Math.max(...allVols, 0.3) * 1.05;
  const retMin = Math.min(...allRets, 0);
  const retMax = Math.max(...allRets, 0.25) * 1.05;

  const x = (v: number) => P.left + (v / volMax) * iw;
  const y = (r: number) => P.top + ih - ((r - retMin) / (retMax - retMin || 1)) * ih;

  // Grid
  const volTicks = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4].filter((v) => v <= volMax);
  const retTicks: number[] = [];
  for (let r = Math.floor(retMin / 0.05) * 0.05; r <= retMax; r += 0.05) retTicks.push(r);

  const frontierPath = result.frontier
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.annualisedVol)},${y(p.annualisedReturn)}`)
    .join(" ");

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={W} height={H} style={{ display: "block", background: "#fafbfc" }}>
        {/* grid */}
        {volTicks.map((v) => (
          <g key={`gx${v}`}>
            <line x1={x(v)} y1={P.top} x2={x(v)} y2={P.top + ih} stroke="#e2e8f0" strokeWidth={1} />
            <text x={x(v)} y={P.top + ih + 16} textAnchor="middle" fontSize={11} fill="#64748b">
              {PCT(v, 0)}
            </text>
          </g>
        ))}
        {retTicks.map((r) => (
          <g key={`gy${r}`}>
            <line x1={P.left} y1={y(r)} x2={P.left + iw} y2={y(r)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={P.left - 6} y={y(r) + 4} textAnchor="end" fontSize={11} fill="#64748b">
              {PCT(r, 0)}
            </text>
          </g>
        ))}
        {/* axes labels */}
        <text x={P.left + iw / 2} y={H - 6} textAnchor="middle" fontSize={12} fill="#334155">
          Volatility (annualised)
        </text>
        <text x={14} y={P.top + ih / 2} transform={`rotate(-90 14 ${P.top + ih / 2})`} textAnchor="middle" fontSize={12} fill="#334155">
          Expected return (annualised)
        </text>

        {/* frontier */}
        <path d={frontierPath} stroke="#1e40af" strokeWidth={2.5} fill="none" opacity={0.9} />

        {/* asset dots */}
        {assetDots.map((d) => (
          <g key={d.id}>
            <circle cx={x(d.vol)} cy={y(d.ret)} r={4.5} fill="#94a3b8" opacity={0.65} />
            <text x={x(d.vol) + 7} y={y(d.ret) - 6} fontSize={10} fill="#475569">
              {assetById[d.id]?.name.split(" ")[0] ?? d.id}
            </text>
          </g>
        ))}

        {/* max-sharpe + min-var markers */}
        <circle cx={x(result.maxSharpe.annualisedVol)} cy={y(result.maxSharpe.annualisedReturn)} r={8} fill="#dc2626" stroke="#fff" strokeWidth={2} />
        <text x={x(result.maxSharpe.annualisedVol) + 12} y={y(result.maxSharpe.annualisedReturn) + 4} fontSize={11} fill="#991b1b" fontWeight={600}>
          Max Sharpe
        </text>

        <circle cx={x(result.minVariance.annualisedVol)} cy={y(result.minVariance.annualisedReturn)} r={7} fill="#059669" stroke="#fff" strokeWidth={2} />
        <text x={x(result.minVariance.annualisedVol) + 12} y={y(result.minVariance.annualisedReturn) - 8} fontSize={11} fill="#065f46" fontWeight={600}>
          Min Var
        </text>
      </svg>
    </div>
  );
}

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
                {assetById[id]?.name.split(" ")[0] ?? id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ids.map((i) => (
            <tr key={i}>
              <td style={{ ...S.td, fontSize: "0.75rem", fontWeight: 600 }}>
                {assetById[i]?.name.split(" ")[0] ?? i}
              </td>
              {ids.map((j) => {
                const r = result.correlation[i][j];
                const c = corrColor(r);
                return (
                  <td key={j} style={{
                    ...S.tdNum,
                    background: c,
                    color: Math.abs(r) > 0.5 ? "white" : "#334155",
                    fontWeight: i === j ? 700 : 500,
                    fontSize: "0.75rem",
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
  card: {
    background: "white",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
    boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
  },
  cardTall: {
    background: "white",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  },
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
  warn: { color: "#b45309", fontSize: "0.7rem", marginTop: 4 },
  err: { background: "#fee2e2", color: "#991b1b", padding: 12, borderRadius: 6, marginBottom: 16 },
  statRow: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12 },
  stat: { background: "#f8fafc", borderRadius: 6, padding: "8px 10px" },
  statLabel: { fontSize: "0.68rem", color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4 },
  statValue: { fontSize: "1.15rem", fontWeight: 700, color: "#0f172a" },
  warnPill: { display: "inline-block", background: "#fef3c7", color: "#92400e", padding: "1px 8px", borderRadius: 999, fontSize: "0.68rem", fontWeight: 600 },
  okPill: { display: "inline-block", background: "#dcfce7", color: "#166534", padding: "1px 8px", borderRadius: 999, fontSize: "0.68rem", fontWeight: 600 },
};
