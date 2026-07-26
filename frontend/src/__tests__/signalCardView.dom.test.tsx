// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import SignalCardView from "../components/studio/SignalCardView";
import { summariseSignal, shapeWords, bandIgnoredFor } from "../components/studio/signalSummary";
import type { Signal } from "../lib/types";

// The signal card in three bands of disclosure. What it has to fix: an expanded card
// puts ~19 controls on screen with no hierarchy and no summary, so four bands on one
// stem are four identical blocks you open one at a time to tell apart.

const sig = (over: Partial<Signal> = {}): Signal => ({
  id: "sig1",
  stemKey: "bass",
  minHz: 40,
  maxHz: 120,
  feature: "energy",
  name: "bass pulse",
  attack: 5,
  release: 900,
  invert: false,
  gamma: 1,
  gain: 1,
  offset: 0,
  threshold: 0,
  ...over,
});

function setup(signal = sig(), patch = vi.fn()) {
  const onRemove = vi.fn();
  const utils = render(
    <SignalCardView
      signal={signal}
      patch={patch}
      onRemove={onRemove}
      color="#b84a74"
      nyq={22050}
      bandIgnored={bandIgnoredFor(signal.feature)}
      playing={false}
      onTogglePlay={() => {}}
      setBandMin={() => {}}
      setBandMax={() => {}}
      spectrogram={<div data-testid="spec" />}
      curveView={<div data-testid="curve" />}
      pulsePad={<div data-testid="pulse" />}
    />
  );
  return { ...utils, patch, onRemove };
}

const sections = (c: HTMLElement) =>
  [...c.querySelectorAll(".sig-sec-title")].map((e) => e.textContent);
// The head's textContent starts with the caret, so match on the title element.
const openSection = (c: HTMLElement, name: string) =>
  fireEvent.click(
    [...c.querySelectorAll(".sig-sec-head")].find(
      (h) => h.querySelector(".sig-sec-title")?.textContent === name
    )!
  );

describe("summariseSignal", () => {
  it("puts the whole card in one line", () => {
    expect(summariseSignal(sig())).toBe("bass · 40 Hz–120 Hz · energy · snappy, long tail");
  });

  it("says the band is irrelevant for the tempo-locked features", () => {
    expect(summariseSignal(sig({ feature: "beat" }))).toContain("whole track");
    expect(bandIgnoredFor("beat")).toBe(true);
    expect(bandIgnoredFor("energy")).toBe(false);
  });

  it("names the character of the envelope, not the numbers", () => {
    expect(shapeWords(sig({ attack: 500, release: 40 }))).toContain("slow swell");
    expect(shapeWords(sig({ attack: 500, release: 40 }))).toContain("tight");
    expect(shapeWords(sig({ gamma: 2.5 }))).toContain("peaks only");
    expect(shapeWords(sig({ gamma: 0.4 }))).toContain("lifted");
    expect(shapeWords(sig({ invert: true }))).toContain("inverted");
  });

  it("stays silent about anything left at its default", () => {
    const plain = sig({ attack: 100, release: 300 });
    expect(shapeWords(plain)).toEqual([]);
    expect(summariseSignal(plain)).toBe("bass · 40 Hz–120 Hz · energy");
  });
});

describe("SignalCardView", () => {
  it("keeps the curve and the pulse always visible — they are the point of the card", () => {
    const { getByTestId } = setup();
    expect(getByTestId("curve")).toBeTruthy();
    expect(getByTestId("pulse")).toBeTruthy();
  });

  it("shows the derived summary without opening anything", () => {
    const { container } = setup();
    expect(container.querySelector(".sig-next-summary")?.textContent).toContain("40 Hz–120 Hz");
  });

  it("holds the detail in three closed sections", () => {
    const { container, queryByTestId } = setup();
    expect(sections(container)).toEqual(["band", "feature", "shape"]);
    expect(container.querySelectorAll(".sig-sec.open")).toHaveLength(0);
    expect(queryByTestId("spec")).toBeNull(); // the spectrogram is behind `band`
  });

  it("a closed section still reports its own state", () => {
    const { container } = setup();
    const summaries = [...container.querySelectorAll(".sig-sec-summary")].map((e) => e.textContent);
    expect(summaries).toEqual(["40–120 Hz", "energy", "snappy, long tail"]);
  });

  it("opening `band` reveals the spectrogram and the Hz fields", () => {
    const { container, getByTestId, getByLabelText } = setup();
    openSection(container, "band");
    expect(getByTestId("spec")).toBeTruthy();
    expect((getByLabelText("band low") as HTMLInputElement).value).toBe("40");
    expect((getByLabelText("band high") as HTMLInputElement).value).toBe("120");
  });

  it("opening `shape` reveals the six sliders and invert", () => {
    const { container } = setup();
    openSection(container, "shape");
    expect(container.querySelectorAll('.signal-ctls input[type="range"]')).toHaveLength(6);
    // The shared primitive, not the hand-rolled button the classic card uses.
    expect(container.querySelector('.ctl-check input[type="checkbox"]')).toBeTruthy();
  });

  it("invert goes through the shared Toggle", () => {
    const patch = vi.fn();
    const { container } = setup(sig(), patch);
    openSection(container, "shape");
    fireEvent.click(container.querySelector('.ctl-check input[type="checkbox"]')!);
    expect(patch).toHaveBeenCalledWith({ invert: true });
  });

  it("renaming and removing still work from the header", () => {
    const patch = vi.fn();
    const { container, onRemove } = setup(sig(), patch);
    fireEvent.change(container.querySelector(".signal-name")!, { target: { value: "low thump" } });
    expect(patch).toHaveBeenCalledWith({ name: "low thump" });
    fireEvent.click(container.querySelector(".iconbtn")!);
    expect(onRemove).toHaveBeenCalledWith("sig1");
  });

  it("disables the band fields for a tempo-locked feature and says why", () => {
    const { container, getByLabelText } = setup(sig({ feature: "bar" }));
    openSection(container, "band");
    expect((getByLabelText("band low") as HTMLInputElement).disabled).toBe(true);
    expect(container.querySelector(".hz-note")?.textContent).toContain("band ignored");
  });
});
