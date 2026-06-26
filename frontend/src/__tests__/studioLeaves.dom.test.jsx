// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import CurveView from "../components/studio/CurveView.tsx";
import PulsePad from "../components/studio/PulsePad.tsx";
import VolumeControl from "../components/studio/VolumeControl.tsx";
import SegmentRail from "../components/studio/SegmentRail.tsx";
import Spectrogram from "../components/studio/Spectrogram.tsx";

afterEach(cleanup);

// First coverage of the studio leaf components (previously untested; converted to
// .tsx in spec 01 step 4).
describe("CurveView", () => {
  it("draws a polyline for a non-empty curve", () => {
    const { container } = render(<CurveView curve={[0, 0.5, 1]} />);
    expect(container.querySelector("polyline")).toBeTruthy();
  });
  it("shows 'no signal' for an empty curve (not loading)", () => {
    const { getByText } = render(<CurveView curve={[]} loading={false} />);
    expect(getByText("no signal")).toBeTruthy();
  });
});

describe("PulsePad", () => {
  it("renders the pulse dot", () => {
    const { container } = render(<PulsePad curve={[0.5]} color="#fff" />);
    expect(container.querySelector(".pulse-dot")).toBeTruthy();
  });
});

describe("VolumeControl", () => {
  it("opens a volume slider on click and reports changes", () => {
    const onChange = vi.fn();
    const { container, getByLabelText } = render(<VolumeControl value={0.5} onChange={onChange} />);
    expect(container.querySelector("input[type=range]")).toBeFalsy();   // closed
    fireEvent.click(getByLabelText("Volume"));
    const slider = container.querySelector("input[type=range]");
    expect(slider).toBeTruthy();
    fireEvent.change(slider, { target: { value: "0.8" } });
    expect(onChange).toHaveBeenCalledWith(0.8);
  });
});

describe("SegmentRail", () => {
  const segments = [
    { id: "s0", label: "intro", start: 0, end: 4 },
    { id: "s1", label: "verse", start: 4, end: 12 },
  ];
  it("renders a chip per segment and selects on click", () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <SegmentRail segments={segments} activeSegId="s0" onSelect={onSelect} />
    );
    expect(getByText("intro")).toBeTruthy();
    fireEvent.click(getByText("verse"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });
});

describe("Spectrogram", () => {
  const track = { specUrl: "/x.png", minHz: 40, maxHz: 12000, fmin: 20, fmax: 22050, color: "#abc" };
  it("renders the image, both band handles, and a playhead", () => {
    const { container } = render(
      <Spectrogram track={track} frac={0.5} onSeek={() => {}} onBandChange={() => {}} />
    );
    expect(container.querySelector("img")).toBeTruthy();
    expect(container.querySelector(".band-handle.min")).toBeTruthy();
    expect(container.querySelector(".band-handle.max")).toBeTruthy();
    expect(container.querySelector(".playhead")).toBeTruthy();
  });
});
