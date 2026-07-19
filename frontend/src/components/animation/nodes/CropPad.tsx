import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { videoPreviewSrc } from "../../../lib/assetPreview";
import { CORNERS, useBoxEdit, type Box } from "./BoxPad";

// The video card's SOURCE-crop editor: the whole (uncropped) clip fills the pad at the
// source's own aspect, and the rectangle selects the region that gets fitted into the
// placement box — so a clip too wide/tall for the project format shows exactly the part
// the user picked. Same drag grammar as BoxPad (body = move, corners = resize; commit on
// pointer-up); outside the selection is dimmed. The clip free-runs muted (no transport
// sync — this pad is about WHERE, the box pad shows WHEN/HOW it plays).
export default function CropPad({
  crop,
  src,
  onChange,
}: {
  crop: Box;
  src: string;
  onChange: (crop: Box) => void;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const { view, onBodyDown, onHandleDown } = useBoxEdit(crop, onChange, padRef);
  // The pad adopts the source's real aspect once metadata loads (16:9 until then).
  const [aspect, setAspect] = useState("16 / 9");
  const pct = (v: number) => `${v * 100}%`;
  const full = view.x === 0 && view.y === 0 && view.w === 1 && view.h === 1;
  return (
    <div className="anim-box-editor">
      <div
        className="anim-box-pad no-drag"
        ref={padRef}
        style={{ "--out-aspect": aspect } as CSSProperties}
      >
        <video
          className="anim-box-video anim-crop-src"
          src={videoPreviewSrc(src)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(`${v.videoWidth} / ${v.videoHeight}`);
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
          title="drag to move the crop"
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
        {full ? (
          <>full frame — drag a corner to crop</>
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
