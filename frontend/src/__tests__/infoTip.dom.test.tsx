// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import Info from "../ui/Info";

// The "?" help tip must escape SCROLLING ancestors. It used to be an absolutely
// positioned child of the badge, which any `overflow` container clips — and the docked
// inspector scrolls (`.anim-dock { overflow-y: auto }`), so every "?" in the side panel
// showed a tip cut off mid-sentence. Portalling it out is the fix; these tests pin that
// it really leaves the container, because the symptom is invisible to a render test that
// only asks "is the text in the document".

function inAScrollingPanel(ui: React.ReactElement) {
  const host = document.createElement("div");
  host.className = "anim-dock";
  host.style.overflowY = "auto";
  document.body.appendChild(host);
  const r = render(ui, { container: document.createElement("div") });
  host.appendChild(r.container);
  return { host, ...r };
}

describe("the '?' help tip", () => {
  it("is not rendered until you hover — nothing to clip when closed", () => {
    const { container } = render(<Info text="explain this" />);
    expect(document.querySelector(".info-tip")).toBeNull();
    fireEvent.pointerEnter(container.querySelector(".info")!);
    expect(document.querySelector(".info-tip")).toBeTruthy();
  });

  it("mounts OUTSIDE the scrolling panel that holds the badge", () => {
    const { host, container } = inAScrollingPanel(<Info text="explain this" />);
    fireEvent.pointerEnter(container.querySelector(".info")!);
    const tip = document.querySelector(".info-tip")!;
    expect(tip).toBeTruthy();
    // The whole point: the tip is NOT a descendant of the overflow container, so the
    // container cannot clip it.
    expect(host.contains(tip)).toBe(false);
    expect(document.body.contains(tip)).toBe(true);
  });

  it("closes on pointer-leave and on blur", () => {
    const { container } = render(<Info text="explain this" />);
    const badge = container.querySelector(".info")!;
    fireEvent.pointerEnter(badge);
    expect(document.querySelector(".info-tip")).toBeTruthy();
    fireEvent.pointerLeave(badge);
    expect(document.querySelector(".info-tip")).toBeNull();
    fireEvent.focus(badge);
    expect(document.querySelector(".info-tip")).toBeTruthy();
    fireEvent.blur(badge);
    expect(document.querySelector(".info-tip")).toBeNull();
  });

  it("still deep-links into the guide when given a section", () => {
    const { container } = render(<Info text="explain this" section="animation-dream" />);
    const a = container.querySelector("a.info") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("/?doc=animation-dream");
    expect(a.getAttribute("target")).toBe("_blank");
    // the text stays reachable to a screen reader even while the tip is unmounted
    expect(a.getAttribute("aria-label")).toContain("explain this");
  });

  it("keeps the tip on screen when the badge sits at the right edge", () => {
    const { container } = render(<Info text="explain this" />);
    const badge = container.querySelector(".info")! as HTMLElement;
    badge.getBoundingClientRect = () =>
      ({ right: window.innerWidth, bottom: 40, top: 24 }) as DOMRect;
    fireEvent.pointerEnter(badge);
    const tip = document.querySelector(".info-tip") as HTMLElement;
    expect(parseFloat(tip.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(tip.style.left)).toBeLessThanOrEqual(window.innerWidth - 8);
  });
});
