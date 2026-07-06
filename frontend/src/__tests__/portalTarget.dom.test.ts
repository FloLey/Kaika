// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { portalTarget } from "../lib/portalTarget";

// Modals portal into the FULLSCREEN element when one is active — a document.body
// portal would paint behind the fullscreened .studio-main and be unusable.
describe("portalTarget", () => {
  afterEach(() => {
    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
  });

  it("falls back to document.body outside fullscreen", () => {
    expect(portalTarget()).toBe(document.body);
  });

  it("targets the fullscreen element while one is active", () => {
    const panel = document.createElement("div");
    document.body.appendChild(panel);
    Object.defineProperty(document, "fullscreenElement", { value: panel, configurable: true });
    expect(portalTarget()).toBe(panel);
    panel.remove();
  });
});
