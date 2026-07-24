import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { videoScrubSrc } from "../../../lib/assetPreview";
import { CORNERS, lockAspect, useBoxEdit, type Box, type Corner } from "./BoxPad";

// The video card's SOURCE-crop editor: the whole (uncropped) clip fills the pad at the
// source's own aspect, and the rectangle selects the region that gets fitted into the
// placement box — so a clip too wide/tall for the project format shows exactly the part
// the user picked. Same drag grammar as BoxPad (body = move, corners = resize; commit on
// pointer-up); outside the selection is dimmed. The clip free-runs muted (no transport
// sync — this pad is about WHERE, the box pad shows WHEN/HOW it plays).
//
// With `targetAspect` (the render box's output W/H — passed when `fit` is "cover",
// the mode that CROPS), the rect is LOCKED to that shape: whatever is inside it is
// EXACTLY the final image, nothing silently trimmed after the fact — the "final
// crop was a surprise" complaint. The ⬚ button frames the DEFAULT cover result
// (centered, maximal) so the starting point is visible too; drag it sideways to
// choose the slice that survives.
export default function CropPad({
  crop,
  src,
  onChange,
  targetAspect,
}: {
  crop: Box;
  src: string;
  onChange: (crop: Box) => void;
  targetAspect?: number; // output W/H of the box this crop feeds (lock + ⬚)
}) {
  const padRef = useRef<HTMLDivElement>(null);
  // The pad adopts the source's real aspect once metadata loads (16:9 until then).
  const [aspect, setAspect] = useState("16 / 9");
  const [srcDim, setSrcDim] = useState<[number, number] | null>(null);
  // Crop coords are fractions of the SOURCE — the locked rect's height-per-width
  // in fractions is srcAspect/targetAspect (screen aspect = w·SW / h·SH).
  const hPerW = targetAspect && srcDim ? srcDim[0] / srcDim[1] / targetAspect : null;
  const constrain =
    hPerW != null ? (raw: Box, corner: Corner) => lockAspect(raw, corner, hPerW) : undefined;
  const { view, onBodyDown, onHandleDown } = useBoxEdit(crop, onChange, padRef, constrain);
  const pct = (v: number) => `${v * 100}%`;
  const full = view.x === 0 && view.y === 0 && view.w === 1 && view.h === 1;

  // One click = the default cover result (centered, maximal window of the output
  // shape). What used to happen invisibly at render time becomes the visible,
  // draggable starting point.
  const frameOutput = () => {
    if (hPerW == null) return;
    let w = 1;
    let h = hPerW;
    if (h > 1) {
      h = 1;
      w = 1 / hPerW;
    }
    onChange({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  };

  return (
    <div className="anim-box-editor">
      <div
        className="anim-box-pad no-drag"
        ref={padRef}
        style={{ "--out-aspect": aspect } as CSSProperties}
      >
        <video
          className="anim-box-video anim-crop-src"
          src={videoScrubSrc(src)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) {
              setAspect(`${v.videoWidth} / ${v.videoHeight}`);
              setSrcDim([v.videoWidth, v.videoHeight]);
            }
          }}
          muted
          loop
          autoPlay
          playsInline
          preload="auto"
        />
        <div
          className={"anim-box-rect anim-crop-rect" + (full ? " full" : "")}
          style={{ left: pct(view.x), top: pct(view.y), width: pct(view.w), height: pct(view.h) }}
          onPointerDown={onBodyDown}
          title={
            hPerW != null
              ? "what's inside this frame IS the final image — drag to choose the slice"
              : "drag to move the crop"
          }
        >
          {CORNERS.map((c) => (
            <span
              key={c}
              className={`anim-box-handle ${c}`}
              onPointerDown={(e) => onHandleDown(c, e)}
              title="drag to resize the crop"
            />
          ))}
        </div>
      </div>
      <div className="anim-box-readout">
        {hPerW != null && (
          <button
            className="iconbtn no-drag anim-crop-frame"
            title="frame the output: set the crop to exactly what the export would show by default (centered), then drag it to choose the slice"
            onClick={frameOutput}
          >
            ⬚ frame output
          </button>
        )}
        {full ? (
          <>
            full frame —{" "}
            {hPerW != null
              ? "cover trims it invisibly; ⬚ shows what survives"
              : "drag a corner to crop"}
          </>
        ) : (
          <>
            x {view.x.toFixed(2)} · y {view.y.toFixed(2)} · w {view.w.toFixed(2)} · h{" "}
            {view.h.toFixed(2)}
          </>
        )}
      </div>
    </div>
  );
}
