# 06 — Node cards + palette

> The four concrete node types rendered inside the canvas (`05`), plus the palette
> that adds them. Each card reuses the existing `Ctl`/`Toggle`/`Info` primitives and
> the Kaika theme. This is where the abstract graph becomes tangible cards.

## Goal

Implement `SignalNode`, `ConstantNode`, `FluidNode`, `OutputNode`, and a `Palette`,
all driven by the `04` graph model and slotted into `GraphCanvas`'s `renderNode`.

## Files

- **Create** `frontend/src/components/animation/nodes/SignalNode.jsx`
- **Create** `frontend/src/components/animation/nodes/ConstantNode.jsx`
- **Create** `frontend/src/components/animation/nodes/FluidNode.jsx`
- **Create** `frontend/src/components/animation/nodes/OutputNode.jsx`
- **Create** `frontend/src/components/animation/nodes/NodeFrame.jsx` (shared chrome:
  title bar / drag handle / port row layout)
- **Create** `frontend/src/components/animation/Palette.jsx`
- *(Styling in `08`.)*

## Design detail

### Shared `NodeFrame`

Common chrome so every node looks consistent and drags the same way:

```jsx
<NodeFrame node={node} selected={selected} accent={accent} title="signal"
           onTitlePointerDown={dragHandler}>
  {/* body */}
  <Port kind="out" nodeId={node.id} portId="out" portRef={portRef}/>
</NodeFrame>
```

- Title bar = the **drag handle** (mark the body `.no-drag` so controls don't drag).
- `accent` color: signal → its `stemColor` (`segments.js`), constant → `--courant`,
  fluid → `--petale`, output → `--text`. Sets `--accent` on the card (matches the
  existing per-card theming convention used by `SignalCard`).
- `Port` renders the little circle and registers `portRef(nodeId, portId, kind)`.

### `SignalNode`

- `data.signalId` + `label`. Resolves the live signal from the segment's signals
  (passed via context/prop) to show its stem chip, feature, and band — read-only
  mirror of the signal defined in the other tab.
- A tiny **curve sparkline**: reuse `CurveView` (`studio/CurveView.jsx`) or a
  minimal static version fed by a one-shot `extractSignal` call (same as
  `SignalCard`) so the user recognizes the pulse. Keep it lightweight (no playback).
- One **out** port. If the referenced signal no longer exists, show a "missing
  signal" state (per `01` §3.7) and let the user re-pick or delete the node.
- Created by the palette from a **picker** of the segment's signals.

### `ConstantNode`

- One slider (`Ctl`) bound to `data.value` in 0..1, plus a numeric readout. One
  **out** port. When wired into a param, the *effective* native value is shown by
  the receiving port's range (the constant itself stays normalized; the executor
  maps it). Keep it dead simple.

### `FluidNode` (the artifact)

The richest card. Layout:

- **Static controls** (top): reuse `FluidLab`'s control rows for the non-port
  params — `duration`, color (`r/g/b` → `data.static.color`), `intensity`/`opacity`
  if you choose to keep them static, `enabled`, `radial`, and the path editor.
  > To avoid duplicating FluidLab's param UI, factor the shared control rows to read
  > from `fluidParams.js`. The path editor is complex; for v1 the FluidNode may
  > expose a **simplified** static path (single center point + radial toggle) and
  > defer the full path editor, OR embed the existing path-editor markup. Decide and
  > note it; simplified is acceptable for v1.
- **Param input ports** (one row each, grouped source/color/medium per
  `FLUID_PARAMS.group`): each row shows the param label, an **in** port, and:
  - if `binding.kind === "const"`: an inline `Ctl` slider (native range from
    `fluidParams`) editing `binding.value`.
  - if `binding.kind === "node"`: a compact **range control** — two handles / two
    number inputs for `lo`/`hi` (within the param's min/max) editing the binding,
    plus a small label of the wired source. A "✕" detaches (→ `disconnect`).
- One **out** port (`video`) on the right edge → wires to the OutputNode.

All edits go through `04` helpers (`setPortRange`, `disconnect`, and direct
`static` patches) via the `onGraphChange` updater from `05`.

### `OutputNode`

- One **in** port (`video`). Body = a `<video loop muted autoPlay>` showing the
  rendered url (state owned by `07`'s container, passed in as `videoUrl` +
  `busy`/`error`). Mirrors `FluidLab`'s double-buffered video swap if desired, but a
  single looping `<video>` is fine for v1.
- Shows "not rendered yet / rendering… / error" states.

### `Palette`

- A small floating toolbar (corner of the canvas) with buttons:
  **+ Signal** (opens the segment-signal picker → `signalNode`),
  **+ Constant** (`constantNode`), **+ Fluid** (`fluidNode`),
  **+ Output** (`outputNode`). New nodes drop near the canvas center in graph space.
- Disable **+ Fluid**/**+ Output** when one already exists (v1: one each).

### Wiring it to the canvas

`07`'s container renders `<GraphCanvas renderNode={(node, h) => switch(node.type)…}>`
returning the matching node component, passing `h.portRef`, `h.onMove`, selection,
and the graph-mutation callbacks. Connect requests from `05` are translated via
`graphModel.connect` (only value→param and fluid→output accepted).

## Reuse

- `Ctl`, `Toggle`, `Info` — `frontend/src/ui/`.
- `CurveView` — `frontend/src/components/studio/CurveView.jsx` (signal sparkline).
- `extractSignal` — `frontend/src/lib/api.js` (one-shot curve for the sparkline).
- `stemColor`, signal shape — `frontend/src/lib/segments.js`.
- Color/path control patterns — `frontend/src/components/fluid/FluidLab.jsx`.
- Graph mutations — `graphModel.js` (`04`).

## Acceptance criteria

- [ ] Palette adds each node type; Fluid/Output capped at one each.
- [ ] SignalNode shows the right stem/feature/band + a recognizable sparkline;
      handles a deleted signal gracefully.
- [ ] ConstantNode slider edits `data.value`.
- [ ] FluidNode shows every modulatable param as a port row; const rows edit value,
      wired rows show + edit `lo/hi` and can detach; static controls edit `static`.
- [ ] OutputNode plays a passed `videoUrl` on loop and shows busy/error states.
- [ ] Dragging a value-source out port onto a param in port wires it (binding+edge);
      dragging Fluid out → Output in connects the render sink.

## Verification (two-audience)

**Fixture/seed data:** a segment with a few signals (from `make dev` upload). The
Output `videoUrl` can be stubbed with `/tmp/...`-served mp4 or left empty until `07`.

**Agent check:** `cd frontend && npm run build && npm run lint`. Vitest: render
each node with a sample node object and assert it shows the expected ports/labels;
simulate a slider change and assert the `onGraphChange` updater produces the right
binding.

**User check:** in the animation tab, add a Fluid + Output, add a couple of Signal
cards and a Constant, and wire a signal into `force` — the `force` row should flip
from a slider to a `lo/hi` range with the source name; detaching restores the
slider. (Rendering happens in `07`.)

## Risks & open questions

- **FluidNode size** — 12 param rows + static controls is a tall card; allow it to
  scroll internally or collapse groups (source/color/medium) to keep the canvas
  tidy. Reuse the collapse pattern from `SignalCard`.
- **Path editor duplication** — simplified static path for v1 recommended; full
  editor reuse is a stretch goal. Note the choice in the PR.
- **Sparkline cost** — debounce/once-only extraction like `SignalCard` (220 ms) to
  avoid hammering `/extract`.
