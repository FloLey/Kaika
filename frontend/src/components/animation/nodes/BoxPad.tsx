import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, RefObject } from "react";
import { useDragPad } from "../../../lib/useDragPad";
import { fitText } from "../../../lib/lyricsFit";

// A normalized (0..1) rectangle in the frame.
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Optional WYSIWYG text preview drawn inside the box (lyrics card): the actual text in the
// chosen font, wrapped + auto-fit like the backend, white fill + black outline. When
// `playing`, it follows the playback `clock` — `getText(t)` returns the revealed text at
// time t, so the word-by-word reveal actually plays in the card; otherwise `idleText` shows.
export interface BoxPreview {
  getText: (timeSec: number) => string;
  idleText: string;
  fontFamily: string; // "" = fall back to a generic font until the webfont loads
  align: "left" | "center" | "right";
  outline: boolean;
  outlineWidth: number;
  clock?: RefObject<HTMLAudioElement | null>;
  playing?: boolean;
  time0: number; // fallback time when there's no clock (e.g. the segment start)
}

// Optional live clip preview drawn inside the box (video card): the real video, placed +
// scaled per `fit`, following the transport `clock` so it plays synced to the timeline.
// Timing approximates the backend (source_t = start + speed·base, base per `sync`, wrapped
// when `loop`); per-frame speed modulation isn't previewed — the render stays authoritative.
export interface BoxVideoPreview {
  src: string;
  fit: "cover" | "contain" | "stretch";
  sync: "song" | "segment";
  start: number;
  speed: number;
  loop: boolean;
  segStart: number;
  clock?: RefObject<HTMLAudioElement | null>;
  playing?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const MIN = 0.05; // smallest box side (fraction of the frame)
const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

// The visual editor for a normalized box: drag the rectangle body to MOVE it, drag a
// corner handle to RESIZE it (opposite corner stays put), all clamped to the frame. The
// pad adopts the project output aspect so the box lands where it will render. Mirrors
// PointsNode: live drag in local state, commit once on pointer-up (no graph churn per move).
export default function BoxPad({
  box,
  aspect,
  onChange,
  preview,
  videoPreview,
}: {
  box: Box;
  aspect: string;
  onChange: (box: Box) => void;
  preview?: BoxPreview;
  videoPreview?: BoxVideoPreview;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { norm, startDrag } = useDragPad(padRef);
  const [drag, setDrag] = useState<Box | null>(null);
  const view = drag ?? box;

  // Draw one frame of the WYSIWYG text preview: wrap + auto-fit `text` to the box (stroke
  // included) exactly like the backend, white fill + black outline. Approximate (canvas vs
  // PIL metrics) but enough to place/size the box; the backend render stays authoritative.
  const align = preview?.align;
  const fontFamily = preview?.fontFamily;
  const outline = preview?.outline;
  const outlineWidth = preview?.outlineWidth;
  const drawText = useCallback(
    (text: string) => {
      const canvas = canvasRef.current;
      const pad = padRef.current;
      if (!canvas || !pad) return;
      let g: CanvasRenderingContext2D | null = null;
      try {
        g = canvas.getContext("2d"); // throws "not implemented" in jsdom — treat as no preview
      } catch {
        g = null;
      }
      const W = pad.clientWidth;
      const H = pad.clientHeight;
      if (!g || !W || !H) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      if (!text) return;
      const fam = fontFamily || "sans-serif";
      const bx = view.x * W;
      const by = view.y * H;
      const bw = view.w * W;
      const bh = view.h * H;
      const measure = (t: string, px: number) => {
        g.font = `${px}px "${fam}"`;
        return g.measureText(t).width;
      };
      const lineHeight = (px: number) => {
        g.font = `${px}px "${fam}"`;
        const m = g.measureText("Ag");
        const a = m.fontBoundingBoxAscent;
        const d = m.fontBoundingBoxDescent;
        return a && d ? a + d : px * 1.25;
      };
      const strokeFrac = outline ? (outlineWidth ?? 0) : 0;
      const { px, lines, lineH } = fitText(text, bw, bh, strokeFrac, measure, lineHeight, bh);
      g.font = `${px}px "${fam}"`;
      g.textBaseline = "top";
      g.lineJoin = "round";
      const sw = strokeFrac * px;
      let y = by + (bh - lineH * lines.length) / 2;
      for (const ln of lines) {
        const lw = g.measureText(ln).width;
        const x =
          align === "left"
            ? bx + sw
            : align === "right"
              ? bx + bw - lw - sw
              : bx + (bw - lw) / 2;
        if (sw > 0) {
          g.lineWidth = 2 * sw;
          g.strokeStyle = "#000";
          g.strokeText(ln, x, y);
        }
        g.fillStyle = "#fff";
        g.fillText(ln, x, y);
        y += lineH;
      }
    },
    [view.x, view.y, view.w, view.h, fontFamily, align, outline, outlineWidth]
  );

  // Draw the CURRENT frame: the revealed text at the playhead while playing (empty between
  // lines, like the render), else the idle text. Every redraw path (rAF + resize) goes
  // through this so nothing fights over what to show (which caused the flicker).
  const renderFrame = useCallback(() => {
    if (!preview) {
      drawText("");
      return;
    }
    const t = preview.clock?.current?.currentTime ?? preview.time0;
    const txt = preview.playing ? preview.getText(t) : preview.getText(t) || preview.idleText;
    drawText(txt);
  }, [drawText, preview]);

  // While playing, follow the clock at 60fps (imperative rAF, like PulsePad — no re-renders);
  // otherwise draw once.
  useEffect(() => {
    if (!preview?.playing) {
      renderFrame();
      return undefined;
    }
    let raf = 0;
    const tick = () => {
      renderFrame();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [preview?.playing, renderFrame]);

  // Redraw the current frame when the pad resizes.
  useEffect(() => {
    const pad = padRef.current;
    if (!pad || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => renderFrame());
    ro.observe(pad);
    return () => ro.disconnect();
  }, [renderFrame]);

  // Drive the live video preview off the transport clock. The key is to let the <video>
  // PLAY NATIVELY (smooth, hardware-decoded) and keep it loosely in sync — nudging
  // `playbackRate` a few % to absorb small drift, and hard-seeking only on a big desync
  // (a scrub / loop wrap). Seeking every frame would flush the decoder and stutter, so we
  // never do that. While paused we seek once to the frame under the playhead. Timing
  // mirrors the backend approximately — the render is authoritative.
  useEffect(() => {
    const v = videoRef.current;
    const vp = videoPreview;
    if (!v || !vp) return undefined;
    v.muted = true;
    const speed = Math.max(0.1, Math.min(16, vp.speed || 1));
    const srcTime = () => {
      const now = vp.clock?.current?.currentTime ?? vp.segStart;
      const base = vp.sync === "song" ? now : now - vp.segStart;
      let t = vp.start + speed * Math.max(0, base);
      const dur = v.duration;
      if (dur && isFinite(dur)) {
        t = vp.loop ? ((t % dur) + dur) % dur : Math.min(t, Math.max(0, dur - 1 / 30));
      }
      return t;
    };
    if (!vp.playing) {
      v.pause();
      v.playbackRate = speed;
      const t = srcTime();
      if (Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
      return undefined;
    }
    // Playing: seed the position once, then let it run and gently self-correct.
    if (Math.abs(v.currentTime - srcTime()) > 0.4) v.currentTime = srcTime();
    v.playbackRate = speed;
    v.play()?.catch(() => {});
    let raf = 0;
    let n = 0;
    const tick = () => {
      if ((n++ & 7) === 0) {
        // ~7–8×/sec, not every frame
        const drift = srcTime() - v.currentTime;
        if (Math.abs(drift) > 0.5) {
          v.currentTime = srcTime(); // big desync (scrubbed / wrapped): jump
          v.playbackRate = speed;
        } else {
          // small drift: nudge the rate up to ±12% so it closes smoothly, no seek
          v.playbackRate = speed * (1 + Math.max(-0.12, Math.min(0.12, drift)));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      v.pause();
    };
  }, [videoPreview]);

  // Move: keep the grab offset within the box so it doesn't jump under the cursor.
  const onBodyDown = (e: PointerEvent) => {
    if (e.target !== e.currentTarget) return; // a corner handle, not the body
    const [gx, gy] = norm(e);
    const ox = gx - box.x;
    const oy = gy - box.y;
    const moveTo = ([cx, cy]: [number, number]): Box => ({
      x: clamp(cx - ox, 0, 1 - box.w),
      y: clamp(cy - oy, 0, 1 - box.h),
      w: box.w,
      h: box.h,
    });
    startDrag(e, {
      onMove: (coord) => setDrag(moveTo(coord)),
      onEnd: ({ moved, coord }) => {
        setDrag(null);
        if (moved && coord) onChange(moveTo(coord));
      },
    });
  };

  // Resize: the dragged corner follows the cursor; the opposite corner is the anchor.
  const resize = (c: Corner, [cx, cy]: [number, number]): Box => {
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    let { x, y, w, h } = box;
    if (c === "se" || c === "ne") w = clamp(cx - box.x, MIN, 1 - box.x);
    if (c === "sw" || c === "nw") {
      x = clamp(cx, 0, right - MIN);
      w = right - x;
    }
    if (c === "se" || c === "sw") h = clamp(cy - box.y, MIN, 1 - box.y);
    if (c === "ne" || c === "nw") {
      y = clamp(cy, 0, bottom - MIN);
      h = bottom - y;
    }
    return { x, y, w, h };
  };

  const onHandleDown = (c: Corner, e: PointerEvent) => {
    startDrag(e, {
      onMove: (coord) => setDrag(resize(c, coord)),
      onEnd: ({ moved, coord }) => {
        setDrag(null);
        if (moved && coord) onChange(resize(c, coord));
      },
    });
  };

  const pct = (v: number) => `${v * 100}%`;
  return (
    <div className="anim-box-editor">
      <div
        className="anim-box-pad no-drag"
        ref={padRef}
        style={{ "--out-aspect": aspect } as CSSProperties}
      >
        <canvas ref={canvasRef} className="anim-box-canvas" />
        {videoPreview?.src && (
          <video
            ref={videoRef}
            className="anim-box-video"
            src={videoPreview.src}
            style={{
              left: pct(view.x),
              top: pct(view.y),
              width: pct(view.w),
              height: pct(view.h),
              objectFit: videoPreview.fit === "stretch" ? "fill" : videoPreview.fit,
            }}
            muted
            loop={videoPreview.loop}
            playsInline
            preload="auto"
          />
        )}
        <div
          className="anim-box-rect"
          style={{ left: pct(view.x), top: pct(view.y), width: pct(view.w), height: pct(view.h) }}
          onPointerDown={onBodyDown}
          title="drag to move"
        >
          {CORNERS.map((c) => (
            <span
              key={c}
              className={`anim-box-handle ${c}`}
              onPointerDown={(e) => onHandleDown(c, e)}
              title="drag to resize"
            />
          ))}
        </div>
      </div>
      <div className="anim-box-readout">
        x {view.x.toFixed(2)} · y {view.y.toFixed(2)} · w {view.w.toFixed(2)} · h {view.h.toFixed(2)}
      </div>
    </div>
  );
}
