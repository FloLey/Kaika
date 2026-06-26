// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import Studio from "../components/studio/Studio.tsx";

// jsdom doesn't implement media playback; stub the transport calls Studio makes on
// segment select / play so the shell logic runs without "Not implemented" noise.
beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

afterEach(cleanup);

// First coverage of the Studio shell (converted to .tsx in spec 01 step 4).
// Rendered with no stems so no SignalCard/audio graph mounts — keeps the test to
// the shell wiring (header, transport, tabs, segment selection).
const segments = [
  { id: "s0", label: "intro", start: 0, end: 4, signals: [] },
  { id: "s1", label: "verse", start: 4, end: 12, signals: [] },
];

function renderStudio(overrides = {}) {
  const props = {
    segments,
    setSegments: vi.fn(),
    activeSegId: "s0",
    setActiveSegId: vi.fn(),
    stems: {},
    duration: 60,
    job: "job123",
    output: { width: 1080, height: 1080, fps: 30, quality: "normal" },
    setOutput: vi.fn(),
    onEditSplit: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<Studio {...props} />) };
}

describe("Studio shell", () => {
  it("titles the header with the active segment and the signals mode", () => {
    const { getByText } = renderStudio();
    expect(getByText(/INTRO/)).toBeTruthy();
    expect(getByText(/EXTRACT SIGNALS BY TRACK/)).toBeTruthy();
  });

  it("points the reference <audio> at the job's original mix", () => {
    const { container } = renderStudio();
    const audio = container.querySelector("audio");
    expect(audio).toBeTruthy();
    expect(audio.getAttribute("src")).toBe("/audio/job123/original");
  });

  it("renders both mode tabs", () => {
    const { getByText } = renderStudio();
    expect(getByText("extract signals by track")).toBeTruthy();
    expect(getByText("create animation")).toBeTruthy();
  });

  it("selects another segment from the rail", () => {
    const { props, getByText } = renderStudio();
    fireEvent.click(getByText("verse"));
    expect(props.setActiveSegId).toHaveBeenCalledWith("s1");
  });

  it("collapses and reopens the segment rail", () => {
    const { container, getByTitle } = renderStudio();
    expect(container.querySelector(".seg-rail")).toBeTruthy();
    fireEvent.click(getByTitle("Hide segments"));
    expect(container.querySelector(".seg-rail")).toBeFalsy();
    fireEvent.click(getByTitle("Show segments"));
    expect(container.querySelector(".seg-rail")).toBeTruthy();
  });
});
