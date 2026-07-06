// Where modals/portals should mount. The Studio fullscreens `.studio-main` — an
// element INSIDE <body> — and the browser paints a fullscreen element above all of
// its body-level siblings, so a `document.body` portal (scrim + modal) is invisible
// and unclickable while fullscreen. Portaling into the fullscreen element itself
// keeps every modal usable in both modes. Evaluated per render, so toggling
// fullscreen re-targets any open portal on the next render.
export const portalTarget = (): HTMLElement =>
  (document.fullscreenElement as HTMLElement | null) ?? document.body;
