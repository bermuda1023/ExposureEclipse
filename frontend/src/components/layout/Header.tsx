import { BRAND } from "../../brand";
import { useHealth } from "../../api/hooks";
import { BrandMark } from "./BrandMark";

export function Header() {
  const { data, error } = useHealth();
  return (
    <header
      style={{
        height: "var(--header-h)",
        background: "linear-gradient(180deg, var(--brand-900) 0%, var(--brand-800) 100%)",
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        boxShadow: "var(--shadow)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <BrandMark />
        <div>
          <div style={{ fontWeight: 600, fontSize: "1rem", letterSpacing: "0.02em" }}>
            {BRAND.name}{" "}
            <span style={{ fontWeight: 400, opacity: 0.75, fontSize: "0.85rem" }}>
              built by {BRAND.company}
            </span>
          </div>
          <div style={{ fontSize: "0.72rem", opacity: 0.75 }}>
            {BRAND.tagline}
            {"  ·  "}
            {BRAND.domain}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: "0.72rem", opacity: 0.85 }}>
        <a
          href="/fund-analysis"
          style={{
            color: "white",
            background: "rgba(255,255,255,0.14)",
            border: "1px solid rgba(255,255,255,0.28)",
            padding: "5px 12px",
            borderRadius: 999,
            textDecoration: "none",
            fontWeight: 600,
            fontSize: "0.72rem",
            letterSpacing: 0.2,
          }}
          title="Portfolio Optimizer — efficient frontier across live hedge funds + SPY + AGG"
        >
          📊 Fund Portfolio Optimizer
        </a>
        {/* Programmes admin link hidden per request — the page still
            exists at /admin/programmes for direct navigation. */}
        {error && (
          <span
            style={{
              background: "var(--error-500)",
              color: "white",
              padding: "3px 8px",
              borderRadius: 999,
              fontWeight: 600,
            }}
          >
            ● backend unreachable
          </span>
        )}
        {data && (
          <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--ok-500)",
                display: "inline-block",
              }}
              aria-hidden
            />
            <span style={{ opacity: 0.85 }}>
              {BRAND.name} v{data.version}
              {"  ·  "}provider <code style={{ color: "#fff" }}>{data.dataProvider}</code>
            </span>
          </span>
        )}
      </div>
    </header>
  );
}
