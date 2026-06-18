import { useHealth } from "../../api/hooks";

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
        <Logo />
        <div>
          <div style={{ fontWeight: 600, fontSize: "1rem", letterSpacing: "0.01em" }}>
            Exposure Eclipse
          </div>
          <div style={{ fontSize: "0.72rem", opacity: 0.75 }}>
            Property Cat exposure management workbench
          </div>
        </div>
      </div>
      <div style={{ fontSize: "0.72rem", opacity: 0.85 }}>
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
              <code style={{ color: "#fff" }}>{data.service}</code> v{data.version}
              {"  ·  "}provider <code style={{ color: "#fff" }}>{data.dataProvider}</code>
            </span>
          </span>
        )}
      </div>
    </header>
  );
}

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="13" fill="#0a1f3a" stroke="#3f80c5" strokeWidth="2" />
      <path d="M5 16 a11 11 0 0 1 22 0 Z" fill="#3f80c5" opacity="0.65" />
      <circle cx="16" cy="16" r="4" fill="#d97706" />
    </svg>
  );
}
