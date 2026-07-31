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
      // Keep: this prefix still covers /animate/stream (+ /status, /cancel), which is
      // the only animate endpoint left. The one-shot POST /animate was deleted.
      "/animate": "http://127.0.0.1:5000",
      "/export": "http://127.0.0.1:5000",
      "/fonts": "http://127.0.0.1:5000",
      "/fluid": "http://127.0.0.1:5000",
      "/logs": "http://127.0.0.1:5000",
      "/projects": "http://127.0.0.1:5000",
      "/audio": "http://127.0.0.1:5000",
      "/spectrogram": "http://127.0.0.1:5000",
      "/assets": "http://127.0.0.1:5000",
      "/asset-proxy": "http://127.0.0.1:5000",
      "/asset-clip": "http://127.0.0.1:5000",
      "/asset-from-youtube": "http://127.0.0.1:5000",
      "/generate-image": "http://127.0.0.1:5000",
      "/stylize": "http://127.0.0.1:5000",
      "/dream": "http://127.0.0.1:5000",
      "/settings": "http://127.0.0.1:5000",
    },
  },
  // `npm run test` — pure-logic unit tests default to node; DOM interaction tests
  // opt into jsdom per-file with `// @vitest-environment jsdom`.
  test: {
    environment: "node",
    include: ["src/**/*.test.{js,jsx,ts,tsx}"],
    // One global afterEach(cleanup) instead of a copy per DOM test — see setup.ts.
    setupFiles: ["./src/__tests__/setup.ts"],
    coverage: {
      // A ratchet, not a target — the same shape as pyproject.toml's `fail_under` for
      // the backend.
      //
      // Measured 79.2% statements / 78.7% branches / 60.6% functions (2026-07-27), after
      // wave 5 deleted the `?ui=next` losing arms: the old shell and its export screen
      // were ~600 lines at 0%, so the number moved 8 points without a test being written.
      // That is exactly why this is set AFTER the deletions and not before — the figure
      // was unknowable until they landed.
      //
      // 75/75/70/55 leaves room for a normal feature commit while still failing loudly if
      // a large untested surface arrives at once. ⚠ Re-measure when you touch this; the
      // previous comment cited a figure that was two waves stale.
      thresholds: { statements: 75, lines: 75, branches: 70, functions: 55 },
      exclude: [
        // Prose, not logic: the in-app user guide is one long JSX document per section.
        // Counting it would let real code rot behind a number that documentation props up
        // — and a test already guards its anchors, which is the property that matters.
        "src/components/docs/**",
        // Generated (`make gen-params`) — covered by the codegen no-diff test instead.
        "src/lib/fluidParams.js",
        "src/lib/graph/generated.ts",
        "src/**/*.test.{js,jsx,ts,tsx}",
        "src/__tests__/**",
        "src/main.jsx",
        "**/*.config.js",
        // Build output. Only present if someone ran `npm run build` first — CI does not,
        // but a local `make coverage` after a build would otherwise score the bundle at 0%
        // and fail the thresholds for a reason that has nothing to do with the tests.
        "dist/**",
      ],
    },
  },
});
