# 05 — The horizontal montage editor

The montage's full surface is now a **full-area editor view**, not a card body:
clicking a montage's compact tile pushes a `kind:"montage"` breadcrumb frame
(`segment ▸ montage`) and the canvas stage renders `MontageEditor` instead of the
graph canvas — same graph state, same ctx, same undo history (the frame shares
the composition; only the surface changes).

## Layout (`components/animation/MontageEditor.tsx`)

- **Top: the extract strip**, horizontal and scrollable. Each tile: the child's
  thumbnail (a leaf clip's server `<sha>-thumb.jpg` via `videoThumbSrc`; `✦` for
  an animation composition; `⚠` for a dangling reference), name, window label,
  shortfall/duplicate badges, and the actions — ×span, 🎬 (re-point the extract
  at a NEW leaf picked from the library; the old composition stays in the pool),
  ▸ open (descend — same `enterExtract` as step 04), ✕ remove. Tiles drag to
  re-order (`moveExtract`); a trailing **+ video** tile appends leaves (the
  library stays open for a run of clips).
- **Left/main: the live view** — `StreamPreview` of the montage node itself,
  large, slaved to the shared transport: at any playhead position the switched
  output IS the current extract, playing under its audio. The status line
  (extracts · cuts · black roll-up) rides beneath it.
- **Right rail: the wiring surface** — threshold/hysteresis Ctls and the same
  `InputPicker` panel the settings modal used, so trigger/opacity value+source
  editing lives here; the modal is no longer needed for a montage (it remains
  the fallback when no navigation exists — `ctx.enterMontage` absent, e.g. the
  montage dom tests, which deliberately keep exercising the modal path).

## Wiring

- `NodeCtx.enterMontage(montageNodeId)`; `CompactCard`'s body click special-cases
  montage onto it. Studio's `NavFrame` gains `kind: "comp" | "montage"` (+
  `montageNodeId`); a montage frame keeps the SAME composition and window as its
  parent view. The pop-on-vanish guard also pops when the montage node is gone.
- `AnimationCanvas` gains `montageEditorNodeId` and swaps the stage for the
  editor — Palette/GraphCanvas don't render under it.

## Tests / docs

- `compositionNav.dom.test.tsx` extended to the full path: compact body → editor
  (breadcrumb `montage`, 2 strip tiles), tile ▸ → leaf canvas + re-windowed
  transport, segment crumb → root (editor gone).
- Guide: the montage section opens with the editor (strip / live view / rail);
  step 06 adds the breakpoints timeline into this surface.
