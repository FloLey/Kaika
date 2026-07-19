import { useEffect } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../../lib/portalTarget";
import type { ExportSettings } from "../../lib/export";

// The HD render of one segment, at full size. The card's preview well is a thumbnail —
// the whole point of an HD render is to actually LOOK at it, so it opens here: real
// playback controls (unlike the muted, clock-slaved card previews), the clip's own
// audio, and a download link. Same portal + scrim + Escape pattern as
// NodeSettingsModal (portal to <body> so the fixed scrim isn't clipped by the
// pan/zoomed canvas; a wheel here must not pan the canvas behind it).
interface HdViewerModalProps {
  url: string;
  settings?: ExportSettings;
  // While the render is still streaming, `url` is the growing preview: label it so a
  // partial clip isn't mistaken for the finished one.
  streaming?: boolean;
  onClose: () => void;
}

export default function HdViewerModal({ url, settings, streaming, onClose }: HdViewerModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const aspect = settings ? `${settings.width} / ${settings.height}` : "9 / 16";
  const specs = settings
    ? `${settings.width}×${settings.height} · ${settings.fps} fps · detail ${settings.gridCells}`
    : "";

  return createPortal(
    <div className="anim-modal-scrim" onPointerDown={onClose} onWheel={(e) => e.stopPropagation()}>
      <div
        className="anim-modal hd-viewer"
        role="dialog"
        aria-label="HD render"
        onPointerDown={(e) => e.stopPropagation()}
        style={{ "--hd-aspect": aspect } as CSSProperties}
      >
        <div className="hd-viewer-head">
          <span className="hd-viewer-title">
            {streaming ? "HD render — still rendering" : "HD render"}
          </span>
          {specs && <span className="hd-viewer-specs">{specs}</span>}
          <button className="btn sm" onClick={onClose} title="close (Esc)">
            ✕
          </button>
        </div>
        {/* Not muted and not clock-slaved: this clip carries the segment's own audio. */}
        <video className="hd-viewer-video" src={url} controls autoPlay playsInline loop />
        <div className="hd-viewer-foot">
          <a className="btn sm" href={url} download>
            ⬇ download
          </a>
        </div>
      </div>
    </div>,
    portalTarget()
  );
}
