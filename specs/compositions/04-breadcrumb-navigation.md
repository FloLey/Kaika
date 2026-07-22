# 04 — Navigation: breadcrumb + per-composition canvas

Exactly one composition on screen. "▸ open" on a montage extract descends into
its child; the header becomes a breadcrumb (`segment ▸ extract 3 · clip ▸ …`),
every ancestor a click back up (plus an `↩ up` button). Recursion is free — a
child montage's extracts open the same way, any depth.

## Design

- **Studio owns a nav stack** (`NavFrame { compositionId, label, window }`),
  reset on segment change (and on re-clicking the segment in the rail). The
  current composition = the top frame's, else the segment's root; a frame whose
  composition vanished pops itself.
- **The window is a SNAPSHOT taken at entry**, computed by the montage card from
  its own cut schedule (`openExtract` in MontageNode — the card owns the
  schedule; Studio only follows). This is sound because a child's edits cannot
  move the parent's cuts (the trigger lives in the parent's graph). An extract
  past the cuts (or with no schedule) opens on the whole current window.
- **Re-windowing drives everything at once**: Studio derives `winStart/winEnd`
  from the top frame and synthesizes `viewSegment = {…hostSeg, start, end}` for
  the canvas. Every consumer — transport (`useStudioPlayback`), timeline,
  StreamPreview/useStreamRender/useRenderKey (segment start/end in the hash),
  signal resolution, OutputNode's HD body — reads the window off `ctx.segment`,
  so no per-consumer plumbing was needed and the audio scrubs against exactly
  the bars the extract plays under. Signals stay the HOST segment's (the
  contextual time base): `viewSegment.signals` is the host list untouched.
- **Edits land on the CURRENT composition**: `setActiveGraph`/`setFinalOutput`
  write `pool[currentCompId]`; root auto-creation still only happens at depth 0
  (a nested composition always exists — an extract references it). The canvas is
  keyed by composition id, so selection/undo history is per composition.
  Copy-to-neighbour hides while nested (a segment-root affair).
- `NodeCtx.enterExtract(montageNodeId, extractId, window)` threads Studio →
  AnimationCanvas → useGraphEditor → the montage card's `▸` button.

## Tests / docs

- `compositionNav.dom.test.tsx`: through the real Studio shell — open the modal,
  wait for the cut schedule, open extract 2 → breadcrumb labeled, canvas
  remounted onto the leaf (its two cards), the transport timeline maxed at the
  extract's 4s slice, copy-to-neighbour hidden; segment crumb returns to the
  root and the full window.
- Guide: `animation-compositions` section ("Compositions — opening an extract")
  in Fx.tsx + `DOC_SECTION_IDS` (anchor-guard green).
