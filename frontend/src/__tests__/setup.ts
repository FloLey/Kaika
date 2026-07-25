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

// jsdom implements neither media playback nor canvas, so BoxPad's `play()`/`pause()` and
// any `getContext("2d")` printed a "Not implemented" stack trace on every green run — ~20
// lines of red-looking output per suite. Noise trains you to skim test output, and this
// repo has direct experience of what that costs: wave 1 exists because a segment rendering
// 79 frozen frames out of 80 shipped through a green suite.
//
// STUBBED, not silenced. A console filter would also hide real errors from these APIs;
// no-op implementations make the calls succeed, so a test that genuinely depends on
// playback can spy on them instead of fighting the environment.
if (typeof window !== "undefined") {
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: () => Promise.resolve(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: () => {},
  });
  // `load()` is the third of the same family: jsdom throws "Not implemented" inside
  // it, so re-pointing an element at a new source printed a stack trace per call.
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    writable: true,
    value: () => {},
  });
  // Unconditional: jsdom DEFINES getContext and throws inside it, so a
  // `if (!prototype.getContext)` guard never fires. Returning null is what a browser does
  // for an unsupported context type, and every caller here already handles that.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: () => null,
  });
}
