import { useEffect, useState } from "react";
import { Shell } from "./components/layout/Shell";
import { AdminProgrammes } from "./pages/AdminProgrammes";
import { FundAnalysis } from "./pages/FundAnalysis";

/** Tiny path-based router — no react-router dependency for a multi-page app.
 * `/admin/programmes` → admin; `/fund-analysis` → portfolio optimizer;
 * anything else → Shell. Browser back/forward + reload work because we
 * use the real URL + popstate. */
function usePath(): string {
  const [path, setPath] = useState<string>(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export default function App() {
  const path = usePath();
  if (path.startsWith("/admin/programmes")) return <AdminProgrammes />;
  if (path.startsWith("/fund-analysis")) return <FundAnalysis />;
  return <Shell />;
}
