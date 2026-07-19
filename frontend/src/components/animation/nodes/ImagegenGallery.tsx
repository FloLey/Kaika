import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../../../lib/portalTarget";
import { assetName } from "./useAssetUpload";

// The settings-window visual for an Image gen card: a grid of ALL its generated images
// (small), and clicking one opens a lightbox — the image big, with ‹ › to step through
// the set (wrapping). Read-only: generation happens in the left column's prompt rows.
export default function ImagegenGallery({ urls }: { urls: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const has = urls.length > 0;

  // Arrow-key navigation + ESC while the lightbox is open.
  useEffect(() => {
    if (open === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      else if (e.key === "ArrowLeft")
        setOpen((i) => (i === null ? i : (i - 1 + urls.length) % urls.length));
      else if (e.key === "ArrowRight") setOpen((i) => (i === null ? i : (i + 1) % urls.length));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, urls.length]);

  if (!has) return <span className="anim-compact-hint">no images yet</span>;

  const step = (delta: number) =>
    setOpen((i) => (i === null ? i : (i + delta + urls.length) % urls.length));

  return (
    <>
      <div className="imagegen-gallery no-drag">
        {urls.map((u, i) => (
          <button
            type="button"
            key={`${u}-${i}`}
            className="imagegen-gallery-cell"
            title={`${assetName(u)} — click to enlarge`}
            onClick={() => setOpen(i)}
          >
            <img src={u} alt="" draggable={false} />
          </button>
        ))}
      </div>
      {open !== null &&
        createPortal(
          <div className="anim-modal-scrim imagegen-lightbox" onPointerDown={() => setOpen(null)}>
            <button
              className="imagegen-lb-nav prev"
              aria-label="previous"
              onPointerDown={(e) => {
                e.stopPropagation();
                step(-1);
              }}
            >
              ‹
            </button>
            <img
              className="imagegen-lb-img"
              src={urls[open]}
              alt=""
              draggable={false}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <button
              className="imagegen-lb-nav next"
              aria-label="next"
              onPointerDown={(e) => {
                e.stopPropagation();
                step(1);
              }}
            >
              ›
            </button>
            <span className="imagegen-lb-count">
              {open + 1} / {urls.length}
            </span>
          </div>,
          portalTarget()
        )}
    </>
  );
}
