// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { engine } from "../lib/audio";

// The band-pass behind "play" on a signal card: the stem's <audio> is captured by a
// MediaElementSource and routed through 4 biquads before it reaches the speakers. What
// makes this worth a test is the failure MODE — an <audio> the engine has not captured
// still plays, just unfiltered, so a broken chain sounds like "the band knob does
// nothing" rather than like silence.

function fakeNode() {
  return {
    frequency: { value: 0 },
    gain: { value: 1 },
    type: "",
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

let created: HTMLAudioElement[] = [];

beforeEach(() => {
  engine.reset();
  created = [];
  (window as unknown as { AudioContext: unknown }).AudioContext = class {
    state = "running";
    destination = fakeNode();
    resume = vi.fn();
    close = vi.fn(() => Promise.resolve());
    createBiquadFilter = fakeNode;
    createGain = fakeNode;
    createMediaElementSource = (el: HTMLAudioElement) => {
      // The real API throws InvalidStateError on a second capture of the same element;
      // record every call so the test can assert we never do that.
      created.push(el);
      return fakeNode();
    };
  };
});

describe("the signal-card band-pass", () => {
  it("puts the band on all four biquads", () => {
    const t = engine.connect("sig1", document.createElement("audio"), 200, 2000);
    expect([t.hp1, t.hp2].map((n) => n.frequency.value)).toEqual([200, 200]);
    expect([t.lp1, t.lp2].map((n) => n.frequency.value)).toEqual([2000, 2000]);
  });

  it("rebuilds the chain when a remount hands it a NEW element for the same signal", () => {
    // Leaving the signals tab and coming back unmounts and remounts the card: same
    // signal id, a brand-new <audio>. Handing back the chain wired to the discarded
    // element would leave the live one uncaptured — playing the whole stem, unfiltered.
    const first = document.createElement("audio");
    engine.connect("sig1", first, 200, 2000);
    const second = document.createElement("audio");
    const t = engine.connect("sig1", second, 200, 2000);
    expect(t.el).toBe(second);
  });

  it("never captures the same element twice", () => {
    // createMediaElementSource throws on a re-capture, and React's StrictMode replays
    // effects on the SAME element — so an unconditional rebuild would break dev mode.
    const el = document.createElement("audio");
    engine.connect("sig1", el, 200, 2000);
    engine.connect("sig1", el, 300, 3000);
    engine.remove("sig1");
    engine.connect("sig1", el, 400, 4000);
    expect(created.filter((c) => c === el)).toHaveLength(1);
  });

  it("keeps two signals on independent chains", () => {
    const a = engine.connect("sig1", document.createElement("audio"), 20, 200);
    const b = engine.connect("sig2", document.createElement("audio"), 2000, 8000);
    engine.setBand("sig1", 30, 300);
    expect(a.hp1.frequency.value).toBe(30);
    expect(b.hp1.frequency.value).toBe(2000);
  });
});
