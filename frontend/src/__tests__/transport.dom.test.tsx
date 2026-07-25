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
