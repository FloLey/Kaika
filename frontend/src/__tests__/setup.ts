// Global test setup — runs before every test file (vite.config.js `test.setupFiles`).
//
// Unmounts anything a test rendered, so trees don't leak into the next test in the file.
// This was hand-rolled in 8 DOM test files and MISSING from 4 others
// (boxPadStability, streamRender, syncedPlayback, portalTarget) — boxPadStability renders
// four times, so its later assertions were querying a document that still held the
// earlier mounts. Doing it here closes the whole class: a new DOM test can't forget.
//
// The `document` guard matters: vite.config.js sets `environment: "node"` and DOM tests
// opt into jsdom per-file with `// @vitest-environment jsdom`. In a node-environment file
// there is no DOM and `cleanup()` would throw, so every non-DOM test would fail.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  if (typeof document !== "undefined") cleanup();
});
