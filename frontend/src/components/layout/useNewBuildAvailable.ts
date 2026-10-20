import { useEffect, useState } from "react";
import { isNewerBuildServed, runningEntryScript } from "../../build";

const CHECK_INTERVAL_MS = 60_000;

/**
 * An open tab keeps running the bundle it first loaded, so fixes deployed
 * since then are invisible until the user reloads. Poll index.html (served
 * with must-revalidate) and report when it references a different bundle.
 */
export function useNewBuildAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const running = runningEntryScript();
    if (running === null || available) return;
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch("/", { cache: "no-store" });
        if (!res.ok) return;
        const html = await res.text();
        if (!cancelled && isNewerBuildServed(running, html)) setAvailable(true);
      } catch {
        // Offline or transient network failure: try again on the next tick.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    void check();
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [available]);

  return available;
}
