import { useRef, useState } from "react";
import type { PointerEvent as RPointerEvent } from "react";
import ArgInfo from "./nodes/ArgInfo";
import {
  addManualBreakpoint,
  moveManualBreakpoint,
  removeManualBreakpoint,
  toggleAutoCut,
} from "../../lib/graphModel";
import type { CutMark } from "../../lib/montageCuts";
import type { Graph } from "../../lib/types";

interface Props {
  montageId: string;
  marks: CutMark[]; // from useMontageShortfall — gate ∪ manual, with provenance
  fps: number;
  total: number; // window length in frames
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
export default function BreakpointTimeline({ montageId, marks, fps, total, onGraphChange }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
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
          ? moveManualBreakpoint(g, montageId, id, last / fps)
          : removeManualBreakpoint(g, montageId, id)
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="bp-timeline">
      <div
        className="bp-rail"
        ref={railRef}
        role="group"
        aria-label="breakpoints"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return; // marks handle their own clicks
          const f = frameAtX(e.clientX);
          onGraphChange((g) => addManualBreakpoint(g, montageId, f / fps));
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
              className="bp-mark bp-manual"
              style={{ left }}
              title={`manual cut at ${t}s — drag to move, click to delete`}
              onPointerDown={(e) => startDrag({ breakpointId: m.breakpointId, frame: m.frame }, e)}
            />
          );
        })}
      </div>
      <div className="bp-legend anim-fx-hint">
        <span className="bp-key bp-key-gate" /> gate · <span className="bp-key bp-key-manual" />{" "}
        manual · {secs.toFixed(1)}s
        <ArgInfo type="montage" k="breakpoints" />
      </div>
    </div>
  );
}
