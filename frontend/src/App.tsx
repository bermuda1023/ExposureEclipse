import { useEffect, useState } from "react";
import { Shell } from "./components/layout/Shell";
import { AdminProgrammes } from "./pages/AdminProgrammes";

/** Tiny path-based router — no react-router dependency for a 2-page app.
 * `/admin/programmes` → admin page; anything else → Shell. Browser back/
 * forward + reload work because we use the real URL + popstate. */
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
  return <Shell />;
}
