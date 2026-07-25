// ⌘K — one box that adds a card, jumps to a card, or jumps to a segment.
//
// Portalled like the other overlays (`portalTarget()` follows fullscreen), but
// deliberately NOT a modal: it is a way to get somewhere, so Escape and any outside
// click dismiss it, and it never asks for confirmation.

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as RKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../../lib/portalTarget";
import { filterCommands } from "./commandItems";
import type { CommandItem } from "./commandItems";

const KIND_LABEL: Record<CommandItem["kind"], string> = {
  add: "add",
  card: "card",
  segment: "segment",
};

export interface CommandPaletteProps {
  items: CommandItem[];
  onRun: (item: CommandItem) => void;
  onClose: () => void;
  wireHint?: string; // "→ fluid 2" when an add would auto-wire from the selection
}

export default function CommandPalette({ items, onRun, onClose, wireHint }: CommandPaletteProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => filterCommands(items, q).slice(0, 40), [items, q]);
  // A new query re-ranks the list, so a held-over index would point at something the
  // user never looked at.
  useEffect(() => setActive(0), [q]);

  // Keep the highlighted row in view when the arrows walk past the fold.
  // jsdom has no scrollIntoView — guard the call, as MontageEditor's tile strip does;
  // the highlight class alone is what the tests assert on.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(".cmdk-row.on");
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const onKey = (e: RKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (shown.length ? (a + 1) % shown.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (shown.length ? (a - 1 + shown.length) % shown.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) onRun(shown[active]);
    }
  };

  return createPortal(
    <div className="cmdk-scrim" onPointerDown={onClose}>
      <div
        className="cmdk"
        role="dialog"
        aria-label="command palette"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <input
          className="cmdk-input"
          autoFocus
          value={q}
          placeholder="add a card, jump to a card or a segment…"
          aria-label="command palette search"
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="cmdk-list" ref={listRef}>
          {shown.map((item, i) => (
            <button
              key={item.id}
              className={"cmdk-row" + (i === active ? " on" : "")}
              onMouseEnter={() => setActive(i)}
              onClick={() => onRun(item)}
            >
              <span className={`cmdk-kind k-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
              <span className="cmdk-label">{item.label}</span>
              <span className="cmdk-hint">{item.hint}</span>
            </button>
          ))}
          {!shown.length && <div className="cmdk-empty">nothing matches “{q}”</div>}
        </div>
        {wireHint && <div className="cmdk-foot">a new card wires itself {wireHint}</div>}
      </div>
    </div>,
    portalTarget()
  );
}
