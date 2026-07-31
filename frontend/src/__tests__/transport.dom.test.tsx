// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import TransportBar from "../components/next/TransportBar";
import * as transport from "../lib/transport";
import type { Segment } from "../lib/types";

// One transport for the whole app. The behaviours that matter are the ones the
// three separate players couldn't have: the element outlives any screen, the loop
// window follows what you're editing, and the position never becomes React state.

const seg = (id: string, label: string, start: number, end: number): Segment => ({
  id,
  label,
  start,
  end,
  signals: [],
});
const SEGMENTS = [seg("s1", "INTRO", 0, 30), seg("s2", "VERSE", 30, 60)];

beforeEach(() => transport.__resetForTest());

describe("the transport store", () => {
  it("owns ONE element and keeps it across resets of the React tree", () => {
    const a = transport.audioEl();
    const { unmount } = render(<TransportBar duration={60} segments={SEGMENTS} />);
    unmount();
    // The whole point: the element is not in the tree, so unmounting can't take it.
    expect(transport.audioEl()).toBe(a);
  });

  it("does not reload the element when the source is unchanged", () => {
    transport.setSource("/audio/j1/original");
    const el = transport.audioEl()!;
    const load = vi.spyOn(el, "load");
    transport.setSource("/audio/j1/original");
    expect(load).not.toHaveBeenCalled();
    transport.setSource("/audio/j1/instrumental");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("clamps a seek into the current window", () => {
    transport.setWindow(30, 60);
    transport.seekSong(5);
    expect(transport.positionSong()).toBe(30);
    transport.seekSong(90);
    expect(transport.positionSong()).toBe(60);
    transport.seekSong(45);
    expect(transport.positionSong()).toBe(45);
  });

  it("reports the position inside the window, which is what a segment view wants", () => {
    transport.setWindow(30, 60);
    transport.seekSong(42);
    expect(transport.positionSong()).toBe(42);
    expect(transport.positionInWindow()).toBe(12);
  });

  it("re-seeks to the head only when asked — entering a segment, not widening one", () => {
    transport.setWindow(0, 60);
    transport.seekSong(20);
    transport.setWindow(0, 90); // widened under a playing head
    expect(transport.positionSong()).toBe(20);
    transport.setWindow(30, 60, { reseek: true }); // entered a segment
    expect(transport.positionSong()).toBe(30);
  });

  it("notifies position subscribers without going through React state", () => {
    const fn = vi.fn();
    const off = transport.subscribePosition(fn);
    transport.seekSong(3);
    expect(fn).toHaveBeenCalled();
    off();
    fn.mockClear();
    transport.seekSong(4);
    expect(fn).not.toHaveBeenCalled();
  });

  it("keeps snapshot identity stable when a set changes nothing", () => {
    // useSyncExternalStore re-renders on identity change; a snapshot that churns
    // per tick would defeat the whole design.
    const before = transport.snapshot();
    transport.setLoop(before.loop);
    expect(transport.snapshot()).toBe(before);
    transport.setLoop(!before.loop);
    expect(transport.snapshot()).not.toBe(before);
  });
});

describe("TransportBar", () => {
  it("bands every segment and marks the active one", () => {
    const { container } = render(
      <TransportBar duration={60} segments={SEGMENTS} activeSegId="s2" />
    );
    const bands = container.querySelectorAll(".tbar-seg");
    expect(bands).toHaveLength(2);
    expect(bands[1].className).toContain("on");
    // The second segment starts halfway through a 60s song.
    expect((bands[1] as HTMLElement).style.left).toBe("50%");
  });

  it("clicking a band selects that segment rather than seeking to it", () => {
    const onSelectSegment = vi.fn();
    const { container } = render(
      <TransportBar duration={60} segments={SEGMENTS} onSelectSegment={onSelectSegment} />
    );
    fireEvent.pointerDown(container.querySelectorAll(".tbar-seg")[1]);
    expect(onSelectSegment).toHaveBeenCalledWith("s2");
  });

  it("shows the loop window only when it is narrower than the song", () => {
    const { container, rerender } = render(<TransportBar duration={60} segments={SEGMENTS} />);
    expect(container.querySelector(".tbar-window")).toBeNull();
    act(() => transport.setWindow(30, 60));
    rerender(<TransportBar duration={60} segments={SEGMENTS} />);
    expect(container.querySelector(".tbar-window")).toBeTruthy();
    expect(container.querySelector(".tbar-scope")?.textContent).toBe("segment");
  });

  it("the loop checkbox and volume drive the store", () => {
    const { getByLabelText, container } = render(
      <TransportBar duration={60} segments={SEGMENTS} />
    );
    const loop = container.querySelector(".tbar-loop input") as HTMLInputElement;
    act(() => {
      fireEvent.click(loop);
    });
    expect(transport.snapshot().loop).toBe(false);

    act(() => {
      fireEvent.change(getByLabelText("Volume"), { target: { value: "0.4" } });
    });
    expect(transport.snapshot().volume).toBeCloseTo(0.4);
  });

  it("moves the playhead as the position changes, with no prop passing", () => {
    const { container } = render(<TransportBar duration={60} segments={SEGMENTS} />);
    act(() => transport.seekSong(15));
    expect((container.querySelector(".tbar-head") as HTMLElement).style.left).toBe("25%");
  });
});

// A seek issued BEFORE the audio has metadata. jsdom never loads media, so
// `readyState` is 0 and `currentTime` is a plain property — the same shape as a real
// browser silently dropping the write. These pin the bug where entering a segment left
// the element at 0 while the UI read the segment head, so the first play started at the
// top of the song and only behaved after you scrubbed by hand.
describe("seeking before the audio is loaded", () => {
  const stubEl = (readyState: number) => {
    const a = transport.audioEl()!;
    Object.defineProperty(a, "readyState", { value: readyState, configurable: true });
    let t = 0;
    Object.defineProperty(a, "currentTime", {
      configurable: true,
      get: () => t,
      // A real element ignores the write until metadata exists; mirror that exactly.
      set: (v: number) => {
        if ((a.readyState as number) >= 1) t = v;
      },
    });
    a.play = vi.fn().mockResolvedValue(undefined);
    return a;
  };

  it("applies the seek once metadata arrives, instead of losing it", () => {
    const a = stubEl(0);
    transport.setWindow(30, 60, { reseek: true });
    expect(a.currentTime).toBe(0); // dropped by the element, as a browser would

    Object.defineProperty(a, "readyState", { value: 1, configurable: true });
    fireEvent(a, new Event("loadedmetadata"));
    expect(a.currentTime).toBe(30); // …and replayed the moment it could land
  });

  it("starts play INSIDE the window even when the element was not ready", () => {
    const a = stubEl(0);
    transport.setWindow(30, 60, { reseek: true });
    transport.play();
    // Nothing can play yet; the element is still empty.
    expect(a.play).not.toHaveBeenCalled();

    Object.defineProperty(a, "readyState", { value: 2, configurable: true });
    fireEvent(a, new Event("canplay"));
    expect(a.play).toHaveBeenCalled();
    // The whole point: it began at the segment head, not at 0 (the top of the song).
    expect(a.currentTime).toBe(30);
  });

  it("a newer seek supersedes a pending one", () => {
    const a = stubEl(0);
    transport.setWindow(30, 60, { reseek: true });
    transport.setWindow(90, 120, { reseek: true });
    Object.defineProperty(a, "readyState", { value: 1, configurable: true });
    fireEvent(a, new Event("loadedmetadata"));
    expect(a.currentTime).toBe(90);
  });

  it("seeks normally once loaded (no queueing when it can just be set)", () => {
    const a = stubEl(1);
    transport.setWindow(30, 60);
    transport.seekSong(42);
    expect(a.currentTime).toBe(42);
  });
});
