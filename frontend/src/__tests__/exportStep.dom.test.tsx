// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import ExportStep from "../components/export/ExportStep";
import { EXPORT_DEFAULTS } from "../lib/export";
import type { OutputSettings, Segment } from "../lib/types";

// No stored render in sessionStorage → no api call fires on mount; still stub the
// module so an accidental call can't hit the network.
const getExportStatus = vi.fn();
vi.mock("../lib/api", () => ({
  getExportStatus: (...a: unknown[]) => getExportStatus(...a),
  startExport: vi.fn(),
  cancelExport: vi.fn(),
}));

// A whole-song export publishes frame progress once per SEGMENT, so the counter sits on
// the same number for minutes and then leaps — read, reasonably, as "stuck at 13s".
// Naming the segment is what makes that wait legible. Mounted for real (a stored render
// id makes the hook resume-poll) rather than re-implementing the label here: a test that
// copies the formatting would stay green while the screen said nothing.
describe("ExportStep — the wait says which segment it is on", () => {
  const mount = async (status: Record<string, unknown>) => {
    sessionStorage.setItem("export-render:j1", "rid-1");
    getExportStatus.mockReset();
    getExportStatus.mockResolvedValue({
      state: "running",
      frames_done: 402,
      total: 6753,
      preview_url: null,
      url: null,
      error: null,
      ...status,
    });
    const r = render(
      <ExportStep
        job="j1"
        segments={[]}
        compositions={{}}
        exportSettings={{ ...EXPORT_DEFAULTS, width: 1080, height: 1920, fps: 30 }}
        setExportSettings={() => {}}
        output={canvas(1080, 1920)}
        onBack={() => {}}
      />
    );
    await waitFor(() => expect(getExportStatus).toHaveBeenCalled());
    return r;
  };

  it("names the segment next to the frame counter", async () => {
    const { findByText } = await mount({ segment: "2/4 · verse" });
    expect(await findByText(/segment 2\/4 · verse/)).toBeTruthy();
  });

  it("names it even before the first frame lands", async () => {
    const { findByText } = await mount({ segment: "1/4 · intro", frames_done: 0, total: 0 });
    expect(await findByText(/rendering segment 1\/4 · intro/)).toBeTruthy();
  });

  it("says nothing extra on a render with no segment field", async () => {
    // Scoped to the progress LABEL — "segment" appears elsewhere in the stage (the
    // per-segment checklist), so a bare /segment/ would match that instead.
    const { findByText, queryByText } = await mount({});
    expect(await findByText("rendering 13s / 225s")).toBeTruthy();
    expect(queryByText(/rendering .*· segment/)).toBeNull();
  });
});

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
        compositions={{}}
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
        compositions={{}}
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
  const seg = (id: string, rootCompositionId?: string): Segment => ({
    id,
    label: id,
    start: 0,
    end: 4,
    signals: [],
    ...(rootCompositionId ? { rootCompositionId } : {}),
  });
  // intro's composition carries a marked output; verse has no animation at all.
  const pool = {
    "c-intro": {
      id: "c-intro",
      name: "intro",
      outputId: "o1",
      graph: {
        version: 8,
        nodes: [{ id: "o1", type: "output", x: 0, y: 0, data: { title: "preview" } }],
        edges: [],
      },
    },
  } as unknown as import("../lib/types").CompositionPool;

  const renderList = (onOpenSegment?: (id: string) => void) =>
    render(
      <ExportStep
        job="j3"
        segments={[seg("intro", "c-intro"), seg("verse")]}
        compositions={pool}
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
