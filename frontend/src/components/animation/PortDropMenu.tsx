// The port picker a dropped wire opens when the target card has more than one input
// it could legally land on. Positioned at the drop point inside the canvas, in the
// canvas's own screen-space coordinates (the same space `.gc-hint` and the wire
// overlay use), so it appears exactly where the gesture ended.
//
// Keyboard is the point as much as the mouse: the filter takes focus on open, ↑/↓
// walk the list, Enter takes the highlighted row. Escape cancels the drop outright —
// "park for later" is the LAST row rather than the fallback, because parking used to
// be the only outcome and that is precisely what this replaces.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as RKeyboardEvent } from "react";
import type { DropCandidate } from "./dropPlan";

export interface PortDropMenuProps {
  x: number; // drop point, canvas-local
  y: number;
  sourceName: string;
  targetName: string;
  candidates: DropCandidate[];
  nameOf: (nodeId: string) => string; // id -> display name, for "replaces …"
  dynamicLabel?: string; // "layer" / "input" — offers "+ new <label>"
  onPick: (portId: string) => void;
  onAddDynamic?: () => void;
  onPark: () => void;
  onCancel: () => void;
}

const FILTER_FROM = 8; // rows above which browsing needs a filter box

export default function PortDropMenu({
  x,
  y,
  sourceName,
  targetName,
  candidates,
  nameOf,
  dynamicLabel,
  onPick,
  onAddDynamic,
  onPark,
  onCancel,
}: PortDropMenuProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState({ dx: 0, dy: 0 });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter(
      (c) =>
        c.label.toLowerCase().includes(needle) || (c.group || "").toLowerCase().includes(needle)
    );
  }, [candidates, q]);

  // Clamp back inside the canvas: the drop can land near the right/bottom edge, and
  // `.anim-stage` clips (overflow hidden), so an un-nudged menu would be cut off.
  useLayoutEffect(() => {
    const el = rootRef.current;
    const host = el?.offsetParent as HTMLElement | null;
    if (!el || !host) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const dx = Math.min(0, host.clientWidth - 8 - (x + w));
    const dy = Math.min(0, host.clientHeight - 8 - (y + h));
    setFlip((p) => (p.dx === dx && p.dy === dy ? p : { dx, dy }));
  }, [x, y, shown.length]);

  // Any pointer outside cancels — the same "click away to dismiss" the palette
  // dropdowns use. Capture phase so a click on a card doesn't also select it.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onCancel();
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [onCancel]);

  const rows = shown.length + (dynamicLabel ? 1 : 0) + 1; // + park
  const take = (i: number) => {
    if (i < shown.length) return onPick(shown[i].portId);
    if (dynamicLabel && i === shown.length) return onAddDynamic?.();
    return onPark();
  };

  const onKey = (e: RKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % rows);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + rows) % rows);
    } else if (e.key === "Enter") {
      e.preventDefault();
      take(active);
    }
  };

  // Group headers, in the order the params arrive (fluid's source/medium split).
  let lastGroup: string | undefined;

  return (
    <div
      className="gc-drop-menu"
      ref={rootRef}
      role="dialog"
      aria-label={`wire ${sourceName} into ${targetName}`}
      style={{ left: x + flip.dx, top: y + flip.dy }}
      onKeyDown={onKey}
      // The canvas treats a background pointerdown as "start a pan / clear the
      // selection"; the menu is on top of it and owns its own clicks.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="gc-drop-head">
        <span className="gc-drop-src">{sourceName}</span>
        <span className="gc-drop-arrow">→</span>
        <span className="gc-drop-tgt">{targetName}</span>
      </div>

      {candidates.length >= FILTER_FROM && (
        <input
          className="gc-drop-filter"
          autoFocus
          value={q}
          placeholder="filter inputs…"
          aria-label="filter inputs"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
        />
      )}

      <div className="gc-drop-list">
        {shown.map((c, i) => {
          const header = c.group && c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <div key={c.portId}>
              {header && <div className="gc-drop-group">{header}</div>}
              <button
                className={"gc-drop-row" + (i === active ? " on" : "")}
                // autoFocus lands here when there is no filter box, so the list is
                // arrow-navigable either way.
                autoFocus={i === 0 && candidates.length < FILTER_FROM}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(c.portId)}
              >
                <span className="gc-drop-label">{c.label}</span>
                {c.currentSource && (
                  <span className="gc-drop-taken">replaces {nameOf(c.currentSource)}</span>
                )}
              </button>
            </div>
          );
        })}
        {!shown.length && <div className="gc-drop-empty">no input matches</div>}
      </div>

      <div className="gc-drop-foot">
        {dynamicLabel && (
          <button
            className={"gc-drop-row alt" + (active === shown.length ? " on" : "")}
            onMouseEnter={() => setActive(shown.length)}
            onClick={() => onAddDynamic?.()}
          >
            + new {dynamicLabel}
          </button>
        )}
        <button
          className={"gc-drop-row alt" + (active === rows - 1 ? " on" : "")}
          onMouseEnter={() => setActive(rows - 1)}
          onClick={onPark}
          title="leave the wire parked on the card, unassigned"
        >
          park for later
        </button>
      </div>
    </div>
  );
}
