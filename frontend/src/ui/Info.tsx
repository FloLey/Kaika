import { useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../lib/portalTarget";

// A small "?" badge. Hover or keyboard-focus reveals an explanation; when a
// `section` is given it's also a link that opens the in-app guide (new tab)
// scrolled to that section. `section` matches an id in Docs.tsx.
//
// The tip is PORTALLED and positioned `fixed`, not nested inside the badge. It used to
// be `position: absolute` under it, which ANY scrolling ancestor clips — and the docked
// inspector scrolls (`.anim-dock { overflow-y: auto }`), so every "?" in the side panel
// showed a tip cut off mid-sentence and unreadable. A portal has no clipping ancestor by
// construction, so this fixes the dock, the montage editor, and anything similar later.
// `portalTarget()` rather than plain `document.body`: the Studio can fullscreen an
// element inside body, above which a body-level portal would be invisible.
interface InfoProps {
  text: string;
  section?: string;
}

const TIP_W = 260; // must match .info-tip's max-width — we clamp against it here

export default function Info({ text, section }: InfoProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  // Measure when the tip OPENS, not on mount: the badge moves whenever its panel
  // scrolls, so a position captured earlier would be stale. Clamped to the viewport and
  // flipped above the badge when there's no room below — a tip that opens off-screen is
  // exactly as unreadable as one that's clipped.
  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(window.innerWidth - TIP_W - 8, r.right - TIP_W));
    const flipUp = r.bottom + 6 + 120 > window.innerHeight && r.top > 120;
    setAt({ top: flipUp ? r.top - 6 : r.bottom + 6, left });
  };
  const close = () => setAt(null);

  const handlers = {
    onPointerEnter: open,
    onPointerLeave: close,
    onFocus: open,
    onBlur: close,
  };

  const tip =
    at &&
    createPortal(
      <span className="info-tip" style={{ top: at.top, left: at.left }} role="tooltip">
        {text}
      </span>,
      portalTarget()
    );

  if (section) {
    return (
      <>
        <a
          ref={ref as RefObject<HTMLAnchorElement>}
          className="info info-link"
          href={`/?doc=${section}`}
          target="_blank"
          rel="noopener noreferrer"
          role="note"
          aria-label={`${text} — open the guide`}
          title="Open the guide"
          {...handlers}
        >
          ?
        </a>
        {tip}
      </>
    );
  }
  return (
    <>
      <span
        ref={ref as RefObject<HTMLSpanElement>}
        className="info"
        tabIndex={0}
        role="note"
        aria-label={text}
        {...handlers}
      >
        ?
      </span>
      {tip}
    </>
  );
}
