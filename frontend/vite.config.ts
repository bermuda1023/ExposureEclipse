import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// docs/STACK_AND_SETUP.md — frontend on :5173, /api proxied to backend :8000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: false,
      },
    },
  },
  build: {
    // Mapbox GL JS is ~1.8 MB minified and lazy-loaded via the MapView dynamic
    // import (Shell.tsx). Rollup naturally splits it into its own async chunk,
    // so it stays off the critical path. Raise the warning limit accordingly
    // — the default 500 KB would just be noise for an app whose central widget
    // is a map. Anything above this threshold IS an unexpected regression.
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/tests/setup.ts"],
  },
});
