// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import BoxPad from "../components/animation/nodes/BoxPad";

// jsdom has no canvas backend; return null so the preview draw no-ops quietly (instead of
// jsdom's noisy "Not implemented: getContext").
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(cleanup);

// Map the pad to a fixed 100x100 box at the origin so client coords are 0..1 fractions.
function mockPad(container: HTMLElement) {
  const pad = container.querySelector(".anim-box-pad") as HTMLElement;
  pad.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 }) as DOMRect;
}
const move = (x: number, y: number) =>
  window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: x, clientY: y }));
const up = () => window.dispatchEvent(new Event("pointerup"));

const BOX = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };

describe("BoxPad", () => {
  it("renders the rectangle, four corner handles and a numeric readout", () => {
    const { container, getByText } = render(<BoxPad box={BOX} aspect="1 / 1" onChange={() => {}} />);
    expect(container.querySelector(".anim-box-rect")).toBeTruthy();
    expect(container.querySelectorAll(".anim-box-handle").length).toBe(4);
    expect(getByText(/x 0.10 · y 0.10 · w 0.30 · h 0.30/)).toBeTruthy();
  });

  it("resizes from the SE corner, keeping the opposite (NW) corner fixed, on pointer-up", () => {
    const onChange = vi.fn();
    const { container } = render(<BoxPad box={BOX} aspect="1 / 1" onChange={onChange} />);
    mockPad(container);
    fireEvent.pointerDown(container.querySelector(".anim-box-handle.se")!);
    move(80, 80); // SE corner -> (0.8, 0.8)
    up();
    expect(onChange).toHaveBeenCalledTimes(1);
    const b = onChange.mock.calls[0][0];
    expect(b.x).toBeCloseTo(0.1, 5); // NW anchor unchanged
    expect(b.y).toBeCloseTo(0.1, 5);
    expect(b.w).toBeCloseTo(0.7, 5);
    expect(b.h).toBeCloseTo(0.7, 5);
  });

  it("clamps a resize to the frame edges", () => {
    const onChange = vi.fn();
    const { container } = render(<BoxPad box={BOX} aspect="1 / 1" onChange={onChange} />);
    mockPad(container);
    fireEvent.pointerDown(container.querySelector(".anim-box-handle.se")!);
    move(500, 500); // far past the edge
    up();
    const b = onChange.mock.calls[0][0];
    expect(b.x + b.w).toBeLessThanOrEqual(1.0001);
    expect(b.y + b.h).toBeLessThanOrEqual(1.0001);
  });

  it("moves the box body, keeping its size, on pointer-up", () => {
    const onChange = vi.fn();
    const { container } = render(<BoxPad box={BOX} aspect="1 / 1" onChange={onChange} />);
    mockPad(container);
    // jsdom's fireEvent doesn't carry clientX on pointer events, so dispatch a native
    // one (bubbles to React's delegated listener) that does — like the window moves below.
    container
      .querySelector(".anim-box-rect")!
      .dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { clientX: 10, clientY: 10 }));
    move(50, 50); // drag toward the centre
    up();
    expect(onChange).toHaveBeenCalledTimes(1);
    const b = onChange.mock.calls[0][0];
    expect(b.w).toBeCloseTo(0.3, 5); // size preserved on a move
    expect(b.h).toBeCloseTo(0.3, 5);
    expect(b.x).toBeGreaterThan(BOX.x); // moved right/down, still in frame
    expect(b.y).toBeGreaterThan(BOX.y);
    expect(b.x + b.w).toBeLessThanOrEqual(1.0001);
  });
});
