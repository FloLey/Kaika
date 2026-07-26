// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import Studio from "../components/studio/Studio";
import * as transport from "../lib/transport";

// `isNext()` is read during render, so a mutable flag lets one file cover both arms
// while both exist. It stops being needed when the shared arm is the only arm.
let nextMode = false;
vi.mock("../lib/uiFlag", () => ({ isNext: () => nextMode }));

// jsdom doesn't implement media playback; stub the transport calls Studio makes on
// segment select / play so the shell logic runs without "Not implemented" noise.
beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

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
    compositions: {},
    setCompositions: vi.fn(),
    activeSegId: "s0",
    setActiveSegId: vi.fn(),
    stems: {},
    duration: 60,
    job: "job123",
    output: {
      width: 1080,
      height: 1080,
      fps: 30,
      quality: "normal" as const,
      background: "#0b0b0f",
    },
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
    expect(audio!.getAttribute("src")).toBe("/audio/job123/original");
  });

  it("renders both mode tabs", () => {
    const { getByText } = renderStudio();
    expect(getByText("extract signals by track")).toBeTruthy();
    expect(getByText("create animation")).toBeTruthy();
  });

  it("drops the redundant mode from the title on the animation tab and shows the copy control", () => {
    const { getByText, queryByText } = renderStudio();
    fireEvent.click(getByText("create animation"));
    // The active tab already says "create animation", so the title is just the label.
    expect(getByText(/INTRO/)).toBeTruthy();
    expect(queryByText(/CREATE ANIMATION/)).toBeNull();
    // The segmented copy control's two sides are present (disabled here: no cards yet).
    expect(getByText("‹ prev")).toBeTruthy();
    expect(getByText("next ›")).toBeTruthy();
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

// The arm that is about to become the only arm.
//
// Studio's playback hook carries two complete engines — its own <audio> plus clock, and
// a delegation to `lib/transport`, whose element lives outside the React tree. The
// second is what the routed shell mounts, and the first is about to be deleted. These
// cover the delegation BEFORE that deletion, so what survives is verified rather than
// merely still compiling.
//
// The real store, not a mock, following `transport.dom.test.tsx`: the failure worth
// catching is Studio wiring itself to the wrong thing, and a mocked module would accept
// any wiring at all.
describe("Studio shell — the shared transport", () => {
  beforeEach(() => {
    nextMode = true;
    transport.__resetForTest();
  });
  afterEach(() => {
    nextMode = false;
  });

  it("mounts NO local <audio> — the store owns the element", () => {
    const { container } = renderStudio();
    expect(container.querySelector("audio")).toBeNull();
    expect(transport.audioEl()).toBeTruthy();
  });

  it("points the store at the job's mix", () => {
    renderStudio();
    expect(transport.snapshot().src).toBe("/audio/job123/original");
  });

  it("follows the audioMode prop to the instrumental mix", () => {
    renderStudio({ audioMode: "instrumental" });
    expect(transport.snapshot().src).toBe("/audio/job123/instrumental");
  });

  it("narrows the loop window to the active segment", () => {
    // s0 is 0–4. Outside the studio the shell widens this to the whole song, so a
    // Studio that failed to narrow would loop the entire track over one segment.
    renderStudio();
    const { windowStart, windowEnd } = transport.snapshot();
    expect([windowStart, windowEnd]).toEqual([0, 4]);
  });

  it("re-narrows the window when another segment becomes active", () => {
    const { rerender, props } = renderStudio();
    rerender(<Studio {...props} activeSegId="s1" />);
    const { windowStart, windowEnd } = transport.snapshot();
    expect([windowStart, windowEnd]).toEqual([4, 12]);
  });
});
