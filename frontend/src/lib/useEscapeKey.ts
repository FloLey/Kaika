import { useEffect, useRef } from "react";

// "ESC closes this" — the same window-level listener was hand-rolled in seven modals
// (SettingsModal, NodeSettingsModal, LyricsEditor, OutputSettings, AssetLibrary,
// HdViewerModal, ConfirmDialog), each with its own useEffect, its own cleanup and its
// own dependency array to get right.
//
// Not folded in, deliberately: VolumeControl also closes on an outside pointerdown, and
// ImagegenGallery's handler drives arrow-key navigation as well. Both do more than this
// hook does, and forcing them through it would mean a callback bag that is harder to read
// than the listener it replaces. NodeFrame's ESC is an inline `onKeyDown` on a rename
// input, not a window listener at all.
//
// The handler is held in a ref so a caller passing an inline arrow function doesn't tear
// the listener down and re-add it on every render — the originals all re-subscribed
// whenever their `onClose` identity changed.
export function useEscapeKey(onEscape?: (() => void) | null, active = true): void {
  const handler = useRef(onEscape);
  handler.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handler.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
