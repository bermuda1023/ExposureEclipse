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
      <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: "0.72rem", opacity: 0.85 }}>
        <a
          href="/admin/programmes"
          style={{
            color: "white",
            opacity: 0.9,
            textDecoration: "none",
            padding: "4px 10px",
            borderRadius: 4,
            background: "rgba(255,255,255,0.10)",
            fontWeight: 600,
          }}
          title="Treaty metadata + EDM linkage admin"
        >
          Programmes admin →
        </a>
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
    <svg
      width="36"
      height="36"
      viewBox="0 0 40 40"
      aria-hidden
      style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))" }}
    >
      <defs>
        {/* Corona ring — soft amber halo around the eclipse */}
        <radialGradient id="ee-corona" cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="#d97706" stopOpacity="0" />
          <stop offset="78%" stopColor="#fbbf24" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#fde68a" stopOpacity="0" />
        </radialGradient>
        {/* Sun disc — warm gradient */}
        <radialGradient id="ee-sun" cx="40%" cy="40%" r="70%">
          <stop offset="0%" stopColor="#fde68a" />
          <stop offset="60%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#d97706" />
        </radialGradient>
        {/* Moon/occluder — navy with a subtle highlight on the right edge */}
        <radialGradient id="ee-moon" cx="65%" cy="40%" r="65%">
          <stop offset="0%" stopColor="#1f4a85" />
          <stop offset="100%" stopColor="#0a1f3a" />
        </radialGradient>
      </defs>

      {/* Corona / glow */}
      <circle cx="20" cy="20" r="19" fill="url(#ee-corona)" />
      {/* Sun disc */}
      <circle cx="20" cy="20" r="14" fill="url(#ee-sun)" />
      {/* Eclipse occluder — slightly offset to give the crescent */}
      <circle cx="23.5" cy="18.5" r="13.5" fill="url(#ee-moon)" />
      {/* Bright limb highlight on the visible crescent edge */}
      <path
        d="M 9.2 13 A 14 14 0 0 0 9.2 27"
        stroke="#fef3c7"
        strokeWidth="0.7"
        fill="none"
        opacity="0.9"
      />
    </svg>
  );
}
