// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import ExportStep from "../components/export/ExportStep";
import { EXPORT_DEFAULTS } from "../lib/export";
import type { OutputSettings } from "../lib/types";

// No stored render in sessionStorage → no api call fires on mount; still stub the
// module so an accidental call can't hit the network.
vi.mock("../lib/api", () => ({
  getExportStatus: vi.fn(),
  startExport: vi.fn(),
  cancelExport: vi.fn(),
}));

afterEach(cleanup);

const canvas = (w: number, h: number): OutputSettings => ({
  width: w,
  height: h,
  quality: "normal",
  fps: 24,
});

describe("ExportStep — export aspect locked to the canvas", () => {
  it("snaps a mismatched export size onto the canvas ratio on mount (keeps the long edge)", () => {
    const setExportSettings = vi.fn();
    render(
      <ExportStep
        job="j1"
        segments={[]}
        exportSettings={{ ...EXPORT_DEFAULTS, width: 1080, height: 1920 }} // portrait
        setExportSettings={setExportSettings}
        output={canvas(1920, 1080)} // landscape 16:9 canvas
        onBack={() => {}}
      />
    );
    expect(setExportSettings).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1920, height: 1080 })
    );
  });

  it("leaves an already-matching export size alone", () => {
    const setExportSettings = vi.fn();
    render(
      <ExportStep
        job="j2"
        segments={[]}
        exportSettings={{ ...EXPORT_DEFAULTS, width: 1080, height: 1920 }}
        setExportSettings={setExportSettings}
        output={canvas(1080, 1920)} // portrait canvas — same shape
        onBack={() => {}}
      />
    );
    expect(setExportSettings).not.toHaveBeenCalled();
  });
});
