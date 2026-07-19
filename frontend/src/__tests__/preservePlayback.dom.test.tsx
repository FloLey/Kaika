// @vitest-environment jsdom
import { useEffect, useRef } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { usePreservePlayback } from "../components/animation/nodes/usePreservePlayback";

afterEach(cleanup);

// `reset()` is called straight from an effect body. If it returned a value (an arrow
// with an implicit `lastTime.current = 0` return did), React reads that value as the
// effect's cleanup function and throws "destroy is not a function" on the next unmount.
describe("usePreservePlayback", () => {
  it("reset() returns undefined so it is safe to call from an effect body", () => {
    let observed: unknown = "unset";
    function Probe() {
      const videoRef = useRef<HTMLVideoElement>(null);
      const { reset } = usePreservePlayback(videoRef, "/fluid/x.mp4");
      useEffect(() => {
        observed = reset();
      }, [reset]);
      return <video ref={videoRef} />;
    }
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<Probe />);
    expect(observed).toBeUndefined();
    unmount(); // would throw "destroy is not a function" if reset() returned a number
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("restores the saved position when a growing preview swaps src", () => {
    function Probe({ url }: { url: string }) {
      const videoRef = useRef<HTMLVideoElement>(null);
      usePreservePlayback(videoRef, url);
      return <video ref={videoRef} src={url} />;
    }
    const { container } = render(<Probe url="/fluid/stream/a/preview.mp4?n=0" />);
    const v = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(v, "duration", { value: 10, configurable: true });
    v.currentTime = 4;
    v.dispatchEvent(new Event("timeupdate")); // saves 4
    v.currentTime = 0; // the new, longer source starts at 0
    v.dispatchEvent(new Event("loadedmetadata")); // restores 4
    expect(v.currentTime).toBe(4);
  });

  // While the segment plays, useSyncedPlayback owns currentTime — it has the real
  // clock. A restore here would be a second, uncoordinated writer racing its drift
  // correction, so the restore half is gated off.
  it("does not restore while the transport owns the clock (enabled=false)", () => {
    function Probe({ url }: { url: string }) {
      const videoRef = useRef<HTMLVideoElement>(null);
      usePreservePlayback(videoRef, url, false);
      return <video ref={videoRef} src={url} />;
    }
    const { container } = render(<Probe url="/fluid/stream/a/preview.mp4?n=0" />);
    const v = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(v, "duration", { value: 10, configurable: true });
    v.currentTime = 4;
    v.dispatchEvent(new Event("timeupdate"));
    v.currentTime = 0;
    v.dispatchEvent(new Event("loadedmetadata"));
    expect(v.currentTime).toBe(0); // left alone
  });
});
