/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the UI on :5173 and proxies API calls to Flask (:5000).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // NOTE: every backend route prefix must be listed here or the frontend 404s.
      "/upload": "http://127.0.0.1:5000",
      "/upload-asset": "http://127.0.0.1:5000",
      "/segment": "http://127.0.0.1:5000",
      "/jobs": "http://127.0.0.1:5000",
      "/extract": "http://127.0.0.1:5000",
      "/resolve": "http://127.0.0.1:5000",
      "/playground": "http://127.0.0.1:5000",
      "/animate": "http://127.0.0.1:5000",
      "/export": "http://127.0.0.1:5000",
      "/fonts": "http://127.0.0.1:5000",
      "/fluid": "http://127.0.0.1:5000",
      "/logs": "http://127.0.0.1:5000",
      "/projects": "http://127.0.0.1:5000",
      "/audio": "http://127.0.0.1:5000",
      "/spectrogram": "http://127.0.0.1:5000",
      "/assets": "http://127.0.0.1:5000",
      "/asset-from-youtube": "http://127.0.0.1:5000",
    },
  },
  // `npm run test` — pure-logic unit tests default to node; DOM interaction tests
  // opt into jsdom per-file with `// @vitest-environment jsdom`.
  test: {
    environment: "node",
    include: ["src/**/*.test.{js,jsx,ts,tsx}"],
  },
});
