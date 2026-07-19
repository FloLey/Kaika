// @vitest-environment jsdom
import { useRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useSyncedPlayback } from "../components/animation/nodes/useSyncedPlayback";

// The bug this file pins: while the segment plays, the hook used to `pause()` the clip
// and write `currentTime` every frame. Slaving by seek alone can never track audio —
// on long-GOP H.264 each seek re-decodes from the previous keyframe, so the picture
// freezes. The clip must PLAY, with drift absorbed by playbackRate and a seek only as
// a last resort.

let frame: FrameRequestCallback | null = null;
const tick = () => {
  const f = frame;
  frame = null;
  f?.(0);
};

beforeEach(() => {
  // jsdom implements neither play() nor pause(), and `paused` is a prototype getter.
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { value: false, configurable: true });
      return Promise.resolve();
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { value: true, configurable: true });
    }),
  });
  frame = null;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frame = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = null;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A <video> slaved to a fake <audio> clock. `playing` mirrors Studio's groupPlaying.
function mount(opts: { playing?: boolean; segStart?: number } = {}) {
  const audio = document.createElement("audio");
  Object.defineProperty(audio, "paused", { value: false, configurable: true, writable: true });
  audio.currentTime = 0;

  function Probe({ playing, segStart }: { playing: boolean; segStart: number }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const clock = useRef<HTMLAudioElement | null>(audio);
    useSyncedPlayback(videoRef, "/fluid/x.mp4", playing, clock, segStart);
    return <video ref={videoRef} src="/fluid/x.mp4" />;
  }
  const view = render(<Probe playing={opts.playing ?? true} segStart={opts.segStart ?? 0} />);
  const v = view.container.querySelector("video") as HTMLVideoElement;
  Object.defineProperty(v, "duration", { value: 5, configurable: true });
  return { v, audio, view, Probe };
}

describe("useSyncedPlayback — segment playing", () => {
  it("actually PLAYS the clip (it used to pause it and seek every frame)", () => {
    const { v } = mount();
    tick();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(v.paused).toBe(false);
  });

  it("absorbs small drift with playbackRate, without seeking", () => {
    const { v, audio } = mount();
    audio.currentTime = 2.12;
    v.currentTime = 2.0; // 0.12s behind → speed up
    tick();
    expect(v.currentTime).toBe(2.0); // no seek
    expect(v.playbackRate).toBeGreaterThan(1);
    expect(v.playbackRate).toBeLessThanOrEqual(1.1); // bounded, stays unnoticeable
  });

  it("seeks once on a hard décrochage, then restores rate 1", () => {
    const { v, audio } = mount();
    audio.currentTime = 2.0;
    v.currentTime = 1.0; // 1s behind — a rate nudge would take too long
    tick();
    expect(v.currentTime).toBe(2.0);
    expect(v.playbackRate).toBe(1);
  });

  it("never stacks seeks while one is in flight", () => {
    const { v, audio } = mount();
    Object.defineProperty(v, "seeking", { value: true, configurable: true });
    audio.currentTime = 2.0;
    v.currentTime = 1.0;
    tick();
    expect(v.currentTime).toBe(1.0); // untouched — the pending seek must land first
  });

  it("does not fight the loop seam (wrap-aware drift)", () => {
    const { v, audio } = mount();
    audio.currentTime = 0.01; // the transport just looped back to the segment start
    v.currentTime = 4.98; // the clip is about to wrap natively — visually in sync
    tick();
    expect(v.currentTime).toBe(4.98); // no seek: the drift folds to ~0.03s
    expect(v.playbackRate).toBe(1);
  });

  it("waits instead of chasing a position the file does not contain yet", () => {
    // A streamed preview still growing: the clock is past the end of what's on disk.
    const { v, audio } = mount();
    Object.defineProperty(v, "duration", { value: 3, configurable: true });
    audio.currentTime = 4.2;
    v.currentTime = 2.5;
    tick();
    expect(v.currentTime).toBe(2.5);
    expect(v.playbackRate).toBe(1);
    expect(v.paused).toBe(false); // still playing, just not steered
  });

  it("tolerates missing metadata", () => {
    const { v, audio } = mount();
    Object.defineProperty(v, "duration", { value: NaN, configurable: true });
    audio.currentTime = 1.0;
    v.currentTime = 0;
    expect(() => tick()).not.toThrow();
    expect(v.currentTime).toBe(0);
  });

  it("pauses the clip when the transport pauses under it", () => {
    const { v, audio } = mount();
    tick();
    Object.defineProperty(audio, "paused", { value: true, configurable: true });
    tick();
    expect(v.paused).toBe(true);
  });

  it("keeps the rAF loop alive across early returns", () => {
    const { v, audio } = mount();
    Object.defineProperty(v, "duration", { value: NaN, configurable: true });
    tick(); // early-returns on missing metadata…
    expect(frame).not.toBeNull(); // …but must have re-armed itself
    Object.defineProperty(v, "duration", { value: 5, configurable: true });
    audio.currentTime = 2.0;
    v.currentTime = 1.0;
    tick();
    expect(v.currentTime).toBe(2.0); // still steering
  });

  it("never leaks a skewed playbackRate into the idle loop", () => {
    const { v, audio, view, Probe } = mount();
    audio.currentTime = 2.12;
    v.currentTime = 2.0;
    tick();
    expect(v.playbackRate).toBeGreaterThan(1);
    view.rerender(<Probe playing={false} segStart={0} />); // transport stopped
    expect(v.playbackRate).toBe(1);
  });
});
