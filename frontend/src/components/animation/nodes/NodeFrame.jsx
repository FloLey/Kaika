// Shared node chrome (06 §Shared NodeFrame): a title bar that doubles as the drag
// handle, a per-type accent (`--accent` inline, matching SignalCard's per-card
// theming), a selected ring, and a `.no-drag` body so controls inside never start
// a node drag. `Port` renders the little wiring circle and registers it with the
// canvas via `portRef(nodeId, portId, kind, flow)`.

export function Port({ nodeId, portId, kind, flow = "value", portRef, startConnect, title }) {
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

export default function NodeFrame({
  node, title, accent, selected, onTitlePointerDown, onDelete, headLead, headExtra,
  sideIn, sideOut, children,
}) {
  return (
    <div
      className={`anim-node anim-node-${node.type}` + (selected ? " sel" : "")}
      style={{ "--accent": accent }}
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
      <div className="anim-node-body no-drag">{children}</div>
    </div>
  );
}
