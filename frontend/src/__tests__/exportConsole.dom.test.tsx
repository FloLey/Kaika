// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import ExportConsole from "../components/next/ExportConsole";
import { NumberField, clampTo } from "../ui/Field";
import { outputNode } from "../lib/graphModel";
import { EXPORT_DEFAULTS } from "../lib/export";
import { OUTPUT_DEFAULTS } from "../lib/output";
import type { CompositionPool, Segment } from "../lib/types";

// The export console. What it has to do that ExportStep doesn't: show the backend's
// `phase` (which ExportStep drops), and make the segment list say where the job is
// instead of sitting greyed out beside a bar that can't move for minutes.

const startExport = vi.fn(async () => ({ render_id: "r1" }));
const getExportStatus = vi.fn();

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  startExport: () => startExport(),
  getExportStatus: (id: string) => getExportStatus(id),
  cancelExport: vi.fn(),
}));

const seg = (id: string, label: string, root?: string): Segment => ({
  id,
  label,
  start: 0,
  end: 10,
  signals: [],
  rootCompositionId: root,
});
const marked = (id: string): CompositionPool => {
  const out = outputNode(0, 0);
  return {
    [id]: { id, name: "root", graph: { version: 1, nodes: [out], edges: [] }, outputId: out.id },
  };
};

const SEGMENTS = [seg("s1", "INTRO", "c1"), seg("s2", "VERSE", "c1"), seg("s3", "CHORUS", "c1")];

beforeEach(() => {
  startExport.mockClear();
  getExportStatus.mockReset();
  sessionStorage.clear();
});

function setup(over: Partial<React.ComponentProps<typeof ExportConsole>> = {}) {
  return render(
    <ExportConsole
      job="j1"
      segments={SEGMENTS}
      compositions={marked("c1")}
      exportSettings={EXPORT_DEFAULTS}
      setExportSettings={() => {}}
      output={OUTPUT_DEFAULTS}
      {...over}
    />
  );
}

const rows = (c: HTMLElement) => [...c.querySelectorAll(".export-seg")];

describe("ExportConsole readiness", () => {
  it("lists every segment as ready when each has a final output", () => {
    const { container } = setup();
    expect(rows(container)).toHaveLength(3);
    expect(rows(container).every((r) => r.className.includes("st-ok"))).toBe(true);
    expect(container.querySelector(".export-checklist-head")?.textContent).toContain("SEGMENTS");
  });

  it("flags the segments missing a final output and offers to jump there", () => {
    const onOpenSegment = vi.fn();
    const { container } = setup({
      segments: [seg("s1", "INTRO", "c1"), seg("s2", "VERSE")],
      onOpenSegment,
    });
    const warn = container.querySelector(".export-seg.st-warn")!;
    expect(warn.textContent).toContain("no final output");
    expect(container.querySelector(".export-checklist-head")?.textContent).toContain(
      "1 still needs a final output"
    );
    fireEvent.click(warn);
    expect(onOpenSegment).toHaveBeenCalledWith("s2");
  });

  it("refuses to Generate until every segment is marked", () => {
    const { container } = setup({ segments: [seg("s1", "INTRO")] });
    const btn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Generate")
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("ExportConsole progress", () => {
  // One status frame, then park — enough to assert the rendering state.
  const running = (over: Record<string, unknown>) => {
    getExportStatus.mockImplementation(async () => ({
      state: "running",
      frames_done: 300,
      total: 900,
      ...over,
    }));
  };

  async function generate(container: HTMLElement) {
    const btn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Generate")
    )!;
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("walks the list: done behind the active segment, pending ahead of it", async () => {
    running({ segment: "VERSE", phase: "render" });
    const { container } = setup();
    await generate(container);
    await waitFor(() => expect(container.querySelector(".export-seg.st-running")).toBeTruthy());
    const cls = rows(container).map((r) => r.className);
    expect(cls[0]).toContain("st-done");
    expect(cls[1]).toContain("st-running");
    expect(cls[2]).toContain("st-pending");
  });

  it("shows the PHASE — the field the old screen dropped", async () => {
    running({ segment: "VERSE", phase: "assets" });
    const { container } = setup();
    await generate(container);
    await waitFor(() =>
      expect(container.querySelector(".export-progress-label")?.textContent).toContain(
        "regenerating images in HD"
      )
    );
    // …and on the row itself, so it's visible next to the segment it applies to.
    expect(container.querySelector(".export-seg.st-running")?.textContent).toContain(
      "regenerating images in HD"
    );
  });

  it("says where in the song the job is, not just a frame count", async () => {
    running({ segment: "CHORUS", phase: "render" });
    const { container } = setup();
    await generate(container);
    await waitFor(() =>
      expect(container.querySelector(".export-progress-label")?.textContent).toContain(
        "segment 3 of 3 · CHORUS"
      )
    );
  });

  it("passes an unknown phase straight through rather than hiding it", async () => {
    running({ segment: "INTRO", phase: "sharpening" });
    const { container } = setup();
    await generate(container);
    await waitFor(() =>
      expect(container.querySelector(".export-progress-label")?.textContent).toContain("sharpening")
    );
  });

  it("the head becomes PROGRESS while running", async () => {
    running({ segment: "INTRO", phase: "render" });
    const { container } = setup();
    await generate(container);
    await waitFor(() =>
      expect(container.querySelector(".export-checklist-head")?.textContent).toContain("PROGRESS")
    );
  });
});

// Ported from `exportStep.dom.test.tsx` when the console replaced that screen. The
// snap is the only thing that ever corrects a stored export size against a canvas that
// has since been rotated, and it is invisible when it fails — the project just exports
// at the wrong shape forever. Test the component, not `fitToRatio` (already covered in
// `output.test.ts`): what broke here would be the effect going missing, not the maths.
const canvas = (width: number, height: number) => ({ ...OUTPUT_DEFAULTS, width, height });

describe("ExportConsole — export aspect locked to the canvas", () => {
  it("snaps a mismatched export size onto the canvas ratio on mount (keeps the long edge)", () => {
    const setExportSettings = vi.fn();
    setup({
      exportSettings: { ...EXPORT_DEFAULTS, width: 1080, height: 1920 }, // portrait
      setExportSettings,
      output: canvas(1920, 1080), // landscape 16:9 canvas
    });
    expect(setExportSettings).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1920, height: 1080 })
    );
  });

  it("leaves an already-matching export size alone", () => {
    const setExportSettings = vi.fn();
    setup({
      exportSettings: { ...EXPORT_DEFAULTS, width: 1080, height: 1920 },
      setExportSettings,
      output: canvas(1080, 1920), // portrait canvas — same shape
    });
    expect(setExportSettings).not.toHaveBeenCalled();
  });
});

describe("NumberField", () => {
  it("clamps out of range, and rounds when asked", () => {
    expect(clampTo(5000, 16, 4096)).toBe(4096);
    expect(clampTo(2, 16, 4096)).toBe(16);
    expect(clampTo(30.6, 1, 120)).toBe(31);
    expect(clampTo(NaN, 16, 4096)).toBe(16);
    expect(clampTo(0.5, 0, 1, false)).toBe(0.5);
  });

  it("reports the clamped value, so a caller can't store an out-of-range one", () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(
      <NumberField label="fps" value={30} min={1} max={120} onChange={onChange} />
    );
    fireEvent.change(getByLabelText("fps"), { target: { value: "999" } });
    expect(onChange).toHaveBeenCalledWith(120);
  });
});
