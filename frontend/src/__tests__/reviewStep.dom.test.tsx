// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import ReviewStep from "../components/review/ReviewStep";
import * as transport from "../lib/transport";
import type { Segment } from "../lib/types";

// First coverage of the review screen.
//
// It carries a `shared` prop — not an `isNext()` call, which is why it is invisible to
// a grep for the flag — that swaps every playback path from a private <audio> to the
// shell's transport store. The routed shell always passes it, so the private arm is
// about to be deleted, and it was the only arm anyone had ever tested. These tests
// exist so that deletion is verifiable rather than hopeful.
//
// The real store, not a mock (following `transport.dom.test.tsx`): what could break here
// is this screen wiring itself to the wrong thing, and a mocked module accepts any
// wiring at all.

const seg = (id: string, label: string, start: number, end: number): Segment => ({
  id,
  label,
  start,
  end,
  signals: [],
});
const SEGMENTS = [seg("s1", "INTRO", 0, 30), seg("s2", "VERSE", 30, 60)];

const onSplitAt = vi.fn();

function setup(over: Partial<React.ComponentProps<typeof ReviewStep>> = {}) {
  return render(
    <ReviewStep
      specUrl="/spec.png"
      audioUrl="/audio/j1/original"
      duration={60}
      segments={SEGMENTS}
      setSegments={vi.fn()}
      onSplitAt={onSplitAt}
      vocalEnvelope={[]}
      envelopeTimes={[]}
      onValidate={vi.fn()}
      onBack={vi.fn()}
      shared
      {...over}
    />
  );
}

beforeEach(() => {
  onSplitAt.mockReset();
  transport.__resetForTest();
});

describe("ReviewStep — playing through the shared transport", () => {
  it("mounts NO local <audio>: the store owns the element", () => {
    const { container } = setup();
    expect(container.querySelector("audio")).toBeNull();
  });

  it("still mounts its own <audio> when not shared", () => {
    // The arm being deleted. Asserted here so the two are known to be exclusive —
    // without this, the test above would also pass if `shared` were simply ignored.
    const { container } = setup({ shared: false });
    expect(container.querySelector("audio")?.getAttribute("src")).toBe("/audio/j1/original");
  });

  it("toggles the store, not a local element", () => {
    const { container } = setup();
    const toggle = vi.spyOn(transport, "toggle");
    fireEvent.click(container.querySelector(".review-transport .play")!);
    expect(toggle).toHaveBeenCalled();
    toggle.mockRestore();
  });

  it("splits at the STORE's playhead, not at local state", () => {
    // The bug this pins: `cur` is never updated in shared mode (nothing subscribes it
    // to state), so a split that read `cur` would silently always cut at 0.
    const { getByTitle } = setup();
    const el = transport.audioEl()!;
    act(() => {
      el.currentTime = 21;
      el.dispatchEvent(new Event("timeupdate"));
    });
    fireEvent.click(getByTitle("Add a cut at the playhead"));
    expect(onSplitAt).toHaveBeenCalledWith(21);
  });

  it("seeks the store when a segment's play button is pressed", () => {
    const seekSong = vi.spyOn(transport, "seekSong");
    const play = vi.spyOn(transport, "play").mockImplementation(() => {});
    const { getAllByTitle } = setup();
    fireEvent.click(getAllByTitle("Play from here")[1]);
    expect(seekSong).toHaveBeenCalledWith(30); // VERSE starts at 30
    expect(play).toHaveBeenCalled();
    seekSong.mockRestore();
    play.mockRestore();
  });

  it("clamps a seek to the song, so a click past the end can't strand the playhead", () => {
    const seekSong = vi.spyOn(transport, "seekSong");
    const { container } = setup();
    const bar = container.querySelector(".review-transport .bar")!;
    bar.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
    fireEvent.click(bar, { clientX: 400 }); // 4× the song
    expect(seekSong).toHaveBeenCalledWith(60);
    seekSong.mockRestore();
  });

  it("toggles on Space from anywhere on the screen", () => {
    setup();
    const toggle = vi.spyOn(transport, "toggle");
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(toggle).toHaveBeenCalled();
    toggle.mockRestore();
  });
});
