import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as RPointerEvent, RefObject } from "react";
import { useWindowPointer } from "./useWindowPointer";
import { portKey, centerInContainer, canConnect, connectIssue } from "./ports";
import type { PortMeta } from "./ports";

// Drawing a wire from an out port to an in port.
//
// Hit-testing is done with `elementFromPoint` against the live DOM rather than against
// measured rectangles: ports move with pan, zoom, card drags and minimize, and any
// cached geometry would be one gesture out of date.
//
// The drop is deliberately forgiving, in three tiers. On a valid port: connect. Anywhere
// on a CARD: hand it to the editor, which auto-assigns or parks it. On a port that
// refused: say why. On empty space: nothing — a cancel is not an error.

export interface Wire {
  source: PortMeta;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  target: PortMeta | null;
}

interface WireConnectOpts {
  rootRef: RefObject<HTMLDivElement>;
  portEls: MutableRefObject<Map<string, Element>>;
  portMeta: MutableRefObject<Map<string, PortMeta>>;
  onConnect?: (
    srcId: string,
    srcPort: string,
    tgtId: string,
    tgtPort: string,
    at?: { x: number; y: number }
  ) => void;
  onCardDrop?: (
    srcId: string,
    srcFlow: string,
    tgtId: string,
    at?: { x: number; y: number }
  ) => void;
}

// Read a `[data-port]` element back into the port it represents.
const metaFromDom = (
  dom: Element | null | undefined,
  portMeta: Map<string, PortMeta>
): PortMeta | null => {
  if (!dom) return null;
  const key = portKey(dom.getAttribute("data-node") || "", dom.getAttribute("data-port") || "");
  return portMeta.get(key) ?? null;
};

export function useWireConnect({
  rootRef,
  portEls,
  portMeta,
  onConnect,
  onCardDrop,
}: WireConnectOpts) {
  const [wire, setWire] = useState<Wire | null>(null);
  const wireRef = useRef<Wire | null>(null);
  wireRef.current = wire;

  // A brief toast explaining why the last connect attempt was rejected. Auto-clears;
  // a fresh attempt replaces it (and resets the timer).
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 2800);
  }, []);
  useEffect(() => () => void (hintTimer.current && clearTimeout(hintTimer.current)), []);

  const startConnect = useCallback(
    (nodeId: string, portId: string, flow: string, e: RPointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const root = rootRef.current;
      const el = portEls.current.get(portKey(nodeId, portId));
      if (!root || !el) return;
      const rect = root.getBoundingClientRect();
      const c = centerInContainer(el, rect);
      setWire({
        source: { nodeId, portId, kind: "out", flow },
        x1: c.x,
        y1: c.y,
        x2: c.x,
        y2: c.y,
        target: null,
      });
      (el as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [rootRef, portEls]
  );

  // Track the cursor and highlight an eligible in-port under it.
  useWindowPointer(
    !!wire,
    (e) => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const x2 = e.clientX - rect.left;
      const y2 = e.clientY - rect.top;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const meta = metaFromDom(hit?.closest("[data-port]"), portMeta.current);
      const target = meta && canConnect(wireRef.current?.source, meta) ? meta : null;
      setWire((w) => (w ? { ...w, x2, y2, target } : w));
    },
    (e) => {
      const w = wireRef.current;
      // Where the wire was let go, in canvas-local coordinates — the editor opens its
      // port menu here, so the choice appears under the cursor that made the drop.
      const dropRect = rootRef.current?.getBoundingClientRect();
      const at = dropRect
        ? { x: e.clientX - dropRect.left, y: e.clientY - dropRect.top }
        : undefined;
      if (w && w.target) {
        onConnect?.(w.source.nodeId, w.source.portId, w.target.nodeId, w.target.portId, at);
      } else if (w) {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const cardDom = hit?.closest("[data-node-id]");
        const tgtId = cardDom?.getAttribute("data-node-id");
        if (tgtId && tgtId !== w.source.nodeId && onCardDrop) {
          onCardDrop(w.source.nodeId, w.source.flow, tgtId, at);
          setWire(null);
          return;
        }
        const issue = connectIssue(
          w.source,
          metaFromDom(hit?.closest("[data-port]"), portMeta.current)
        );
        if (issue) showHint(issue);
      }
      setWire(null);
    }
  );

  return { wire, hint, startConnect };
}
