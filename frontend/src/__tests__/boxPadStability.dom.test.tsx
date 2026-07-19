// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useState } from "react";

import BoxPad from "../components/animation/nodes/BoxPad";
import type { BoxVideoPreview } from "../components/animation/nodes/BoxPad";

// BoxPad's playback engine used to depend on the videoPreview OBJECT. Callers build that
// object inline, so every parent render replaced it, tearing the engine down and back up
// — and each rebuild made the <video> re-request its source. On a canvas of 20 clips that
// was ~27 requests each and a frozen tab. Two components grew hand-written memos with
// diverging dep lists to work around it; the engine now keys on the preview's FIELDS, so
// a fresh object per render is free.
//
// This test asserts that property directly: re-render with an equal-but-new preview
// object and the media element must not be touched again.

const preview = (over: Partial<BoxVideoPreview> = {}): BoxVideoPreview => ({
  src: "/asset-clip/job/abc?start=0.0&dur=8.0",
  fit: "cover",
  sync: "segment",
  start: 0,
  speed: 1,
  loop: true,
  segStart: 0,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  clock: undefined,
  playing: false,
  ...over,
});

beforeEach(() => {
  // jsdom implements none of these; stub them so the playback engine can run.
  Object.defineProperty(HTMLMediaElement.prototype, "load", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: () => Promise.resolve(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: () => {},
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
});

function Harness({ vp }: { vp: BoxVideoPreview }) {
  const [, force] = useState(0);
  return (
    <div>
      <button onClick={() => force((n) => n + 1)}>rerender</button>
      {/* the box object is deliberately inline too — the same identity trap */}
      <BoxPad
        box={{ x: 0, y: 0, w: 1, h: 1 }}
        aspect="1 / 1"
        onChange={() => {}}
        readOnly
        videoPreview={vp}
      />
    </div>
  );
}

describe("BoxPad playback stability", () => {
  it("keeps the same <video> element across re-renders with an equal preview", () => {
    const { container, rerender } = render(<Harness vp={preview()} />);
    const first = container.querySelector("video");
    expect(first).toBeTruthy();

    // A NEW object each time, equal in value — exactly what an inline builder produces.
    for (let i = 0; i < 5; i++) rerender(<Harness vp={preview()} />);

    const after = container.querySelector("video");
    expect(after).toBe(first); // same element: React never remounted it
    expect(after?.getAttribute("src")).toBe(preview().src); // and the same source
  });

  it("changes the source only when a preview FIELD actually changes", () => {
    const { container, rerender } = render(<Harness vp={preview()} />);
    expect(container.querySelector("video")?.getAttribute("src")).toContain("start=0.0");

    rerender(<Harness vp={preview({ src: "/asset-clip/job/abc?start=2.0&dur=8.0" })} />);
    expect(container.querySelector("video")?.getAttribute("src")).toContain("start=2.0");
  });
});
