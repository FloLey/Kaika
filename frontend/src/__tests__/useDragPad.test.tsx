// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDragPad } from "../lib/useDragPad";

// Coverage of useDragPad — the pointer-drag plumbing shared by PointsNode and BoxPad.
afterEach(() => vi.restoreAllMocks());

// A ref to a div whose box is a fixed 100x100 at the origin, so client coords map
// straight to 0..1 fractions.
function padRef() {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect;
  return { current: el };
}

// A window pointer event carrying client coords (jsdom's Event has none).
function pointerEvent(type: string, clientX = 0, clientY = 0) {
  return Object.assign(new Event(type), { clientX, clientY });
}

describe("useDragPad.norm", () => {
  it("maps client coords to a 0..1 fraction and clamps out-of-bounds", () => {
    const { result } = renderHook(() => useDragPad(padRef()));
    expect(result.current.norm({ clientX: 50, clientY: 50 })).toEqual([0.5, 0.5]);
    expect(result.current.norm({ clientX: -20, clientY: 200 })).toEqual([0, 1]);
  });
});

describe("useDragPad.startDrag", () => {
  it("fires onMove per pointermove and onEnd(moved:true) with the last coord on pointerup", () => {
    const { result } = renderHook(() => useDragPad(padRef()));
    const onMove = vi.fn();
    const onEnd = vi.fn();
    result.current.startDrag(
      { stopPropagation: vi.fn(), clientX: 0, clientY: 0 },
      { onMove, onEnd }
    );

    window.dispatchEvent(pointerEvent("pointermove", 30, 70));
    expect(onMove).toHaveBeenCalledWith([0.3, 0.7]);

    window.dispatchEvent(pointerEvent("pointerup"));
    expect(onEnd).toHaveBeenCalledWith({ moved: true, coord: [0.3, 0.7] });
  });

  it("reports moved:false / coord:null for a click with no drag", () => {
    const { result } = renderHook(() => useDragPad(padRef()));
    const onEnd = vi.fn();
    result.current.startDrag({ stopPropagation: vi.fn(), clientX: 0, clientY: 0 }, { onEnd });

    window.dispatchEvent(pointerEvent("pointerup"));
    expect(onEnd).toHaveBeenCalledWith({ moved: false, coord: null });
  });
});
