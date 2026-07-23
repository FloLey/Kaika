import { useEffect, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent } from "react";
import ArgInfo from "./nodes/ArgInfo";
import {
  addManualBreakpoint,
  moveManualBreakpoint,
  removeManualBreakpoint,
  toggleAutoCut,
} from "../../lib/graphModel";
import type { NodeCtx } from "./nodes/nodeProps";
import type { CutMark } from "../../lib/montageCuts";
import type { Graph } from "../../lib/types";

// One colour per EXTRACT, cycling — so each extract's stretch of the timeline
// (and its strip tile's key dot, MontageEditor) reads apart from its neighbours.
// Black holes stay black: that's the thing being looked for.
export const EXTRACT_COLORS = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#c084fc",
  "#22d3ee",
  "#f87171",
  "#a3e635",
];
export const extractColor = (k: number) => EXTRACT_COLORS[k % EXTRACT_COLORS.length];

// Which extract the transport sits over right now (an index into `starts`), or null
// when the playhead is outside the window. A rAF loop reads the audio clock every
// frame — playing OR scrubbing — but commits state only when the INDEX changes, so
// this costs a handful of re-renders per pass, not 60 Hz. The editor highlights the
// live extract's timeline band and strip tile off this one value.
export function useLiveExtract(
  clock: NodeCtx["groupClock"] | undefined,
  starts: number[] | undefined,
  total: number,
  fps: number,
  segStart: number
): number | null {
  const [live, setLive] = useState<number | null>(null);
  const liveRef = useRef<number | null>(null);
  useEffect(() => {
    liveRef.current = null;
    setLive(null);
    if (!clock || !starts || !starts.length || !total) return;
    let raf = 0;
    const tick = () => {
      const a = clock.current;
      let k: number | null = null;
      if (a) {
        const f = (a.currentTime - segStart) * fps;
        if (f >= 0 && f < total) {
          k = 0;
          while (k + 1 < starts.length && starts[k + 1] <= f) k++;
        }
      }
      if (k !== liveRef.current) {
        liveRef.current = k;
        setLive(k);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock, starts, total, fps, segStart]);
  return live;
}

interface Props {
  montageId: string;
  marks: CutMark[]; // from useMontageShortfall — gate ∪ manual, with provenance
  // Material coverage bands (same hook): tinted where an extract has footage,
  // near-black where the export will render BLACK — the gaps read at a glance.
  coverage: { from: number; to: number; kind: "covered" | "black"; extract: number }[];
  fps: number;
  total: number; // window length in frames
  // The shared transport clock (Studio's <audio>) + this composition's window
  // start — the playhead line follows them, playing OR scrubbing.
  clock?: NodeCtx["groupClock"];
  segStart?: number;
  // The extract the playhead is over (useLiveExtract) — its bands render brighter.
  liveExtract?: number | null;
  // Clicking a coverage band SELECTS the extract it belongs to — the editor
  // scrolls that tile into view and highlights it. The bands live in their own
  // lane above the rail precisely so this click and click-to-place-a-cut on the
  // rail can never collide.
  onSelectExtract?: (k: number) => void;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
}

// The montage's BREAKPOINTS TIMELINE — a strip over the composition's window where
// both cut sources stay visible with their provenance: GATE cuts (from the wired
// trigger, recomputed live) in the gate colour, MANUAL breakpoints in the manual
// colour. A gate cut clicks off/on — disabled it stays visible, greyed and struck,
// so you can always see where it came from; it just no longer cuts (stored as a
// time exception, re-enabled automatically if the cut MOVES under a threshold
// edit). Click an empty spot to place a manual cut there; drag a manual cut to
// move it; click one to delete it.
export default function BreakpointTimeline({
  montageId,
  marks,
  coverage,
  fps,
  total,
  clock,
  segStart = 0,
  liveExtract = null,
  onSelectExtract,
  onGraphChange,
}: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  // The playhead: a line that follows the transport across the strip — while
  // PLAYING and while scrubbing (it reads the audio clock every frame either
  // way). Driven by direct style writes off one rAF loop, not state: a 60 Hz
  // setState would re-render every mark and band for a moving line.
  const headRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!clock) return;
    let raf = 0;
    const tick = () => {
      const a = clock.current;
      const el = headRef.current;
      if (a && el) {
        const frac = (a.currentTime - segStart) / Math.max(0.001, total / fps);
        if (frac >= 0 && frac <= 1) {
          el.style.left = `${frac * 100}%`;
          el.style.display = "";
        } else {
          el.style.display = "none"; // the playhead is outside this window
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock, segStart, total, fps]);
  // A manual mark mid-drag: its breakpointId + live position (frames). Committed on
  // pointer-up through moveManualBreakpoint; rendering uses the live position so the
  // marker follows the pointer without a graph commit per move.
  const [drag, setDrag] = useState<{ id: string; frame: number; moved: boolean } | null>(null);

  const secs = total / fps;
  const tol = 0.5 / fps; // the render's half-frame matching rule — one definition
  const frameAtX = (clientX: number) => {
    const r = railRef.current!.getBoundingClientRect();
    const f = Math.round(((clientX - r.left) / Math.max(1, r.width)) * total);
    return Math.max(1, Math.min(total - 1, f));
  };

  const startDrag = (bp: { breakpointId?: string; frame: number }, e: RPointerEvent) => {
    if (!bp.breakpointId) return;
    e.stopPropagation();
    e.preventDefault();
    const id = bp.breakpointId;
    let last = bp.frame;
    let moved = false;
    setDrag({ id, frame: bp.frame, moved });
    const move = (ev: PointerEvent) => {
      last = frameAtX(ev.clientX);
      moved = true;
      setDrag({ id, frame: last, moved });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      // A drag MOVES the breakpoint; a plain click (no movement) DELETES it.
      onGraphChange((g) =>
        moved
          ? moveManualBreakpoint(g, montageId, id, last / fps, tol)
          : removeManualBreakpoint(g, montageId, id)
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="bp-timeline">
      <div className="bp-lanes">
        {/* The EXTRACTS lane: material coverage, one clickable band per stretch.
            Click a band to SELECT the video playing there — its own lane above the
            rail, so selecting can never collide with click-to-place-a-cut. */}
        <div className="bp-extracts" role="group" aria-label="extract coverage">
          {coverage.map((b, i) => (
            <button
              key={`c${i}`}
              type="button"
              className={
                "bp-band" +
                (b.kind === "black" ? " bp-band-black" : "") +
                (b.kind === "covered" && b.extract === liveExtract ? " bp-band-live" : "")
              }
              style={{
                left: `${(b.from / total) * 100}%`,
                width: `${((b.to - b.from) / total) * 100}%`,
                // The band under the playhead brightens (b3 vs 59 alpha): "this is
                // the video playing right now".
                ...(b.kind === "covered"
                  ? {
                      background: `${extractColor(b.extract)}${b.extract === liveExtract ? "b3" : "59"}`,
                    }
                  : {}),
              }}
              title={
                (b.kind === "black"
                  ? `no material here — the export renders BLACK (extract ${b.extract + 1})`
                  : `extract ${b.extract + 1}`) + " — click to select its tile"
              }
              onClick={() => onSelectExtract?.(b.extract)}
            />
          ))}
        </div>
        <div
          className="bp-rail"
          ref={railRef}
          role="group"
          aria-label="breakpoints"
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return; // marks handle their own clicks
            const f = frameAtX(e.clientX);
            // tol: placing a cut here clears a stale "no cut here" at the same spot.
            onGraphChange((g) => addManualBreakpoint(g, montageId, f / fps, tol));
          }}
          title="click to place a manual cut here"
        >
          {marks.map((m) => {
            const frame = drag && m.breakpointId === drag.id ? drag.frame : m.frame;
            const left = `${(frame / total) * 100}%`;
            const t = (frame / fps).toFixed(2);
            if (m.source === "gate") {
              return (
                <button
                  key={`g${m.frame}`}
                  className={"bp-mark bp-gate" + (m.disabled ? " off" : "")}
                  style={{ left }}
                  title={
                    m.disabled
                      ? `gate cut at ${t}s — DISABLED (click to re-enable). It stays visible so its origin reads; it just doesn't cut.`
                      : `gate cut at ${t}s, from the trigger signal — click to disable just this one`
                  }
                  onClick={() =>
                    onGraphChange((g) => toggleAutoCut(g, montageId, m.frame / fps, tol))
                  }
                />
              );
            }
            return (
              <button
                key={m.breakpointId}
                className={"bp-mark bp-manual" + (m.disabled ? " off" : "")}
                style={{ left }}
                title={
                  m.disabled
                    ? `manual cut at ${t}s — SILENCED by a disabled cut at the same time. Drag to move it clear, click to delete.`
                    : `manual cut at ${t}s — drag to move, click to delete`
                }
                onPointerDown={(e) =>
                  startDrag({ breakpointId: m.breakpointId, frame: m.frame }, e)
                }
              />
            );
          })}
        </div>
        {/* The playhead spans BOTH lanes — one line through bands and marks. */}
        <div className="bp-head" ref={headRef} style={{ display: "none" }} />
      </div>
      <div className="bp-legend anim-fx-hint">
        <span className="bp-key bp-key-gate" /> gate · <span className="bp-key bp-key-manual" />{" "}
        manual · <span className="bp-key bp-key-covered" /> filmed ·{" "}
        <span className="bp-key bp-key-black" /> black · {secs.toFixed(1)}s
        <ArgInfo type="montage" k="breakpoints" />
      </div>
    </div>
  );
}
