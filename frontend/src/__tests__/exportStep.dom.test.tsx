// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import ExportStep from "../components/export/ExportStep";
import { EXPORT_DEFAULTS } from "../lib/export";
import type { OutputSettings, Segment } from "../lib/types";

// No stored render in sessionStorage → no api call fires on mount; still stub the
// module so an accidental call can't hit the network.
vi.mock("../lib/api", () => ({
  getExportStatus: vi.fn(),
  startExport: vi.fn(),
  cancelExport: vi.fn(),
}));

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

// The readiness checklist names the segments blocking Generate; an unmarked row is the
// click-through to go fix it (a marked row stays inert).
describe("ExportStep — checklist click-through", () => {
  const seg = (id: string, finalOutputId?: string): Segment => ({
    id,
    label: id,
    start: 0,
    end: 4,
    signals: [],
    ...(finalOutputId ? { finalOutputId } : {}),
  });

  const renderList = (onOpenSegment?: (id: string) => void) =>
    render(
      <ExportStep
        job="j3"
        segments={[seg("intro", "o1"), seg("verse")]}
        exportSettings={EXPORT_DEFAULTS}
        setExportSettings={() => {}}
        output={canvas(EXPORT_DEFAULTS.width, EXPORT_DEFAULTS.height)}
        onBack={() => {}}
        onOpenSegment={onOpenSegment}
      />
    );

  it("clicking the ⚠ row opens that segment; the ✓ row is not a button", () => {
    const onOpenSegment = vi.fn();
    const { container } = renderList(onOpenSegment);
    const rows = container.querySelectorAll(".export-seg");
    expect(rows).toHaveLength(2);
    expect(rows[0].tagName).toBe("DIV"); // marked -> inert
    expect(rows[1].tagName).toBe("BUTTON"); // unmarked -> jumpable

    fireEvent.click(rows[1]);
    expect(onOpenSegment).toHaveBeenCalledWith("verse");
  });

  it("without the callback every row stays inert", () => {
    const { container } = renderList(undefined);
    expect(container.querySelector("button.export-seg")).toBeNull();
  });
});
