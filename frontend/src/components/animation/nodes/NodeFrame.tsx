// Shared node chrome (06 §Shared NodeFrame): a title bar that doubles as the drag
// handle, a per-type accent (`--accent` inline, matching SignalCard's per-card
// theming), a selected ring, and a `.no-drag` body so controls inside never start
// a node drag. `Port` renders the little wiring circle and registers it with the
// canvas via `portRef(nodeId, portId, kind, flow)`.

import { useCallback, useContext } from "react";
import type { CSSProperties, PointerEvent, ReactNode } from "react";
import { MinimizeContext } from "./minimizeContext";
import type { PortRef } from "./nodeProps";

type StartConnect = (nodeId: string, portId: string, flow: string, e: PointerEvent) => void;

interface PortProps {
  nodeId: string;
  portId: string;
  kind: string;
  flow?: string;
  portRef: PortRef;
  startConnect?: StartConnect;
  title?: string;
}

export function Port({ nodeId, portId, kind, flow = "value", portRef, startConnect, title }: PortProps) {
  return (
    <span
      className={`gc-port gc-port-${kind} gc-port-${flow}`}
      data-node={nodeId}
      data-port={portId}
      title={title}
      ref={portRef(nodeId, portId, kind, flow)}
      onPointerDown={
        kind === "out" && startConnect
          ? (e) => startConnect(nodeId, portId, flow, e)
          : undefined
      }
    />
  );
}

interface PortDesc { portId: string; kind: string; flow: string; }
interface MultiAnchorProps {
  nodeId: string;
  ports: PortDesc[];
  portRef: PortRef;
  startConnect?: StartConnect;
  className?: string;
  title?: string;
}

// A single wiring dot that re-registers SEVERAL logical ports to one DOM element,
// so all their edges converge on it (the generalisation of FluidNode's GroupAnchor,
// used by MinimizedCard to collapse a card's wires onto one header anchor). If it
// carries exactly one `out` port it can also start a new wire.
export function MultiAnchor({ nodeId, ports, portRef, startConnect, className = "", title }: MultiAnchorProps) {
  const key = ports.map((p) => `${p.portId}:${p.kind}:${p.flow}`).join(",");
  const ref = useCallback(
    (el: Element | null) => { for (const p of ports) portRef(nodeId, p.portId, p.kind, p.flow)(el); },
    // Deliberate: key on the serialized `key`, not the `ports` array identity, so
    // the ref callback stays stable while the port set is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, key, portRef]
  );
  const out = ports.length === 1 && ports[0].kind === "out" ? ports[0] : null;
  const flow = ports[0]?.flow || "value";
  return (
    <span
      className={`gc-port gc-port-${ports[0]?.kind || "in"} gc-port-${flow} ${className}`}
      data-node={nodeId}
      data-port={out ? out.portId : ports[0]?.portId}
      title={title}
      ref={ref}
      onPointerDown={out && startConnect ? (e) => startConnect(nodeId, out.portId, out.flow, e) : undefined}
    />
  );
}

interface NodeFrameProps {
  node: { id: string; type: string };
  title: ReactNode;
  accent: string;
  selected?: boolean;
  onTitlePointerDown?: (e: PointerEvent) => void;
  onDelete?: () => void;
  headLead?: ReactNode;
  headExtra?: ReactNode;
  sideIn?: ReactNode;
  sideOut?: ReactNode;
  minimized?: boolean;
  children?: ReactNode;
}

export default function NodeFrame({
  node, title, accent, selected, onTitlePointerDown, onDelete, headLead, headExtra,
  sideIn, sideOut, minimized = false, children,
}: NodeFrameProps) {
  const { minimized: minSet, toggle } = useContext(MinimizeContext) as {
    minimized?: Set<string>;
    toggle?: (id: string) => void;
  };
  const isMin = minimized || (minSet && minSet.has && minSet.has(node.id));
  return (
    <div
      className={`anim-node anim-node-${node.type}` + (selected ? " sel" : "") + (isMin ? " min" : "")}
      style={{ "--accent": accent } as CSSProperties}
    >
      {/* Connector dots that straddle the card's left/right edge (centered on the
          title bar) so a wire visibly enters/leaves the side, not the title. */}
      {sideIn && <div className="anim-port-side anim-port-side-in">{sideIn}</div>}
      {sideOut && <div className="anim-port-side anim-port-side-out">{sideOut}</div>}
      <div className="anim-node-head" onPointerDown={onTitlePointerDown}>
        <span className="anim-node-head-left">
          {headLead}
          <span className="anim-node-title">{title}</span>
        </span>
        <span className="anim-node-head-right">
          {headExtra}
          {toggle && (
            <button
              className="anim-node-min no-drag"
              title={isMin ? "expand card" : "minimize to header"}
              aria-label={isMin ? "expand card" : "minimize card"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); toggle(node.id); }}
            >
              {isMin ? "▢" : "–"}
            </button>
          )}
          {onDelete && (
            <button
              className="anim-node-del no-drag"
              title="delete card"
              aria-label="delete card"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
            >
              ✕
            </button>
          )}
        </span>
      </div>
      {!isMin && <div className="anim-node-body no-drag">{children}</div>}
    </div>
  );
}
